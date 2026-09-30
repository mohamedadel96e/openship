import { createHash, randomUUID } from "node:crypto";
import { AppError, ConflictError, NotFoundError, SUPPORT_EMAIL, ValidationError } from "@repo/core";
import {
  CloudSupportInputSchema,
  CloudSupportReplySchema,
  parseInput,
  type CloudSupportReceipt,
} from "@repo/contracts";
import type { CloudSupportRepo, CloudSupportTicket } from "@repo/db/repos";
import type { SendMailOptions } from "../../lib/mail";
import { supportEmail } from "../../lib/email-templates";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const receipt = (ticket: CloudSupportTicket): CloudSupportReceipt => ({
  id: ticket.id,
  createdAt: ticket.createdAt.toISOString(),
});

export class CloudSupportService {
  private flushing?: Promise<{ delivered: number; failed: number }>;
  constructor(
    private readonly options: {
      enabled: () => boolean;
      repo: CloudSupportRepo;
      send: (mail: SendMailOptions) => Promise<boolean>;
    },
  ) {}

  private requireCloud() {
    if (!this.options.enabled()) throw new NotFoundError("Support");
  }

  async submit(raw: unknown, beforeCreate: (recipientHash: string) => Promise<void>) {
    this.requireCloud();
    const input = parseInput(CloudSupportInputSchema, raw);
    const value = {
      name: input.name.trim(),
      email: input.email.trim(),
      subject: input.subject.trim(),
      message: input.message.trim(),
      source: input.source,
    };
    if (!value.name || !value.subject || !value.message)
      throw new ValidationError("Name, subject, and message cannot be blank.");
    const recipientHash = hash(value.email.toLowerCase());
    const id = `SUP-${hash(`${recipientHash}:${input.requestId.toLowerCase()}`).slice(0, 24).toUpperCase()}`;
    const inputHash = hash(JSON.stringify(value));
    const existing = await this.options.repo.find(id);
    if (existing) {
      if (existing.inputHash !== inputHash)
        throw new ConflictError("This request reference was already used for a different message.");
      return receipt(existing);
    }
    // Rate-limit NEW tickets only. A retry after a lost response remains safe.
    await beforeCreate(recipientHash);
    return receipt(await this.options.repo.create({ id, inputHash, ...value }));
  }

  async list(input: { status?: CloudSupportTicket["status"]; before?: string; limit: number }) {
    this.requireCloud();
    const rows = await this.options.repo.list(input);
    const page = rows.slice(0, input.limit);
    return {
      tickets: page.map(({ inputHash: _inputHash, message: _message, ...ticket }) => ticket),
      nextCursor: rows.length > input.limit ? page.at(-1)!.id : null,
    };
  }

  async get(id: string) {
    this.requireCloud();
    const ticket = await this.options.repo.find(id);
    if (!ticket) throw new NotFoundError("Support ticket");
    const { inputHash: _inputHash, ...view } = ticket;
    return { ticket: view, messages: await this.options.repo.messages(id) };
  }

  async setStatus(id: string, status: CloudSupportTicket["status"]) {
    this.requireCloud();
    await this.options.repo.setStatus(id, status);
  }

  async reply(id: string, raw: unknown) {
    this.requireCloud();
    const input = parseInput(CloudSupportReplySchema, raw);
    const body = input.message.trim();
    if (!body) throw new ValidationError("Reply cannot be blank.");
    return this.options.repo.reply(id, {
      id: `${id}:reply:${input.requestId.toLowerCase()}`,
      body,
      resolve: input.resolve,
    });
  }

  async retry(id: string) {
    this.requireCloud();
    if (!(await this.options.repo.find(id))) throw new NotFoundError("Support ticket");
    return { queued: (await this.options.repo.retryFailed(id)).length };
  }

  /** Bounded batches, with SQL leases shared by all Cloud API replicas. */
  flush(): Promise<{ delivered: number; failed: number }> {
    if (!this.options.enabled()) return Promise.resolve({ delivered: 0, failed: 0 });
    return (this.flushing ??= this.deliverPending().finally(() => {
      this.flushing = undefined;
    }));
  }

  private async deliverPending() {
    const summary = { delivered: 0, failed: 0 };
    for (let batch = 0; batch < 5; batch++) {
      const leaseId = randomUUID();
      const due = await this.options.repo.claim(leaseId, new Date(), 4);
      if (!due.length) break;
      await Promise.all(
        due.map(async (message) => {
          try {
            const ticket = await this.options.repo.find(message.ticketId);
            if (!ticket) throw new NotFoundError("Support ticket");
            const accepted = await this.options.send({
              to: message.kind === "notification" ? SUPPORT_EMAIL : ticket.email,
              replyTo: message.kind === "notification" ? ticket.email : SUPPORT_EMAIL,
              messageId: `<support-${hash(message.id)}@openship.io>`,
              ...supportEmail({ ...ticket, kind: message.kind, reply: message.body }),
            });
            if (!accepted)
              throw new AppError(
                "No mail transport accepted this message",
                503,
                "SMTP_UNAVAILABLE",
              );
            await this.options.repo.delivered(message.id, leaseId, new Date());
            summary.delivered++;
          } catch (error) {
            // SMTP errors may contain credentials/addresses. Persist only a safe
            // operational diagnosis, never the provider's raw response.
            const reason =
              error instanceof AppError && error.code === "SMTP_UNAVAILABLE"
                ? "No configured mail transport accepted this email. Check Cloud SMTP settings."
                : "Email delivery failed. Check Cloud SMTP settings and retry delivery.";
            const delay = Math.min(60 * 60_000, 60_000 * 2 ** Math.min(message.attempts - 1, 6));
            await this.options.repo.failed(
              message.id,
              leaseId,
              message.attempts >= 10 ? null : new Date(Date.now() + delay),
              reason,
            );
            summary.failed++;
          }
        }),
      );
    }
    return summary;
  }
}
