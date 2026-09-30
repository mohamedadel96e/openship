import { and, or, eq, inArray, isNull, lt, lte, asc, desc, sql } from "drizzle-orm";
import { ConflictError, NotFoundError } from "@repo/core";
import type { Database } from "../connection";
import {
  cloudSupportTicket as tickets,
  cloudSupportMessage as messages,
} from "../schema/cloud-support";

export type CloudSupportTicket = typeof tickets.$inferSelect;
export type CloudSupportMessage = typeof messages.$inferSelect;
type TicketInput = Pick<
  CloudSupportTicket,
  "id" | "inputHash" | "name" | "email" | "subject" | "message" | "source"
>;

export function createCloudSupportRepo(db: Database) {
  const find = async (id: string) =>
    (await db.select().from(tickets).where(eq(tickets.id, id)).limit(1))[0] ?? null;
  return {
    find,
    async create(input: TicketInput) {
      return db.transaction(async (tx) => {
        const [inserted] = await tx.insert(tickets).values(input).onConflictDoNothing().returning();
        if (!inserted) {
          const [existing] = await tx.select().from(tickets).where(eq(tickets.id, input.id));
          if (!existing || existing.inputHash !== input.inputHash)
            throw new ConflictError(
              "This request reference was already used for a different message.",
            );
          return existing;
        }
        // Both deliveries commit with the ticket. A process crash cannot lose them.
        await tx.insert(messages).values([
          { id: `${input.id}:receipt`, ticketId: input.id, kind: "receipt" },
          { id: `${input.id}:notification`, ticketId: input.id, kind: "notification" },
        ]);
        return inserted;
      });
    },
    async list(input: { status?: CloudSupportTicket["status"]; before?: string; limit: number }) {
      const before = input.before ? await find(input.before) : null;
      if (input.before && !before) throw new NotFoundError("Support cursor");
      return db
        .select()
        .from(tickets)
        .where(
          and(
            input.status ? eq(tickets.status, input.status) : undefined,
            before
              ? or(
                  lt(tickets.createdAt, before.createdAt),
                  and(eq(tickets.createdAt, before.createdAt), lt(tickets.id, before.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(tickets.createdAt), desc(tickets.id))
        .limit(input.limit + 1);
    },
    async messages(id: string) {
      return db
        .select()
        .from(messages)
        .where(eq(messages.ticketId, id))
        .orderBy(asc(messages.createdAt), asc(messages.id));
    },
    async setStatus(id: string, status: CloudSupportTicket["status"]) {
      const [ticket] = await db
        .update(tickets)
        .set({ status, updatedAt: new Date() })
        .where(eq(tickets.id, id))
        .returning();
      if (!ticket) throw new NotFoundError("Support ticket");
      return ticket;
    },
    async reply(id: string, input: { id: string; body: string; resolve: boolean }) {
      return db.transaction(async (tx) => {
        const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, id)).for("update");
        if (!ticket) throw new NotFoundError("Support ticket");
        const [existing] = await tx.select().from(messages).where(eq(messages.id, input.id));
        if (existing) {
          if (
            existing.ticketId !== id ||
            existing.body !== input.body ||
            existing.resolve !== input.resolve
          )
            throw new ConflictError(
              "This reply reference was already used for a different message.",
            );
          return existing;
        }
        const [reply] = await tx
          .insert(messages)
          .values({ ...input, ticketId: id, kind: "reply" })
          .returning();
        await tx
          .update(tickets)
          .set({ updatedAt: new Date(), ...(input.resolve ? { status: "resolved" as const } : {}) })
          .where(eq(tickets.id, id));
        return reply!;
      });
    },
    async claim(leaseId: string, now: Date, limit: number) {
      return db.transaction(async (tx) => {
        const due = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(and(isNull(messages.deliveredAt), lte(messages.nextAttemptAt, now)))
          .orderBy(asc(messages.nextAttemptAt), asc(messages.id))
          .limit(limit)
          .for("update", { skipLocked: true });
        if (!due.length) return [];
        return tx
          .update(messages)
          .set({
            leaseId,
            attempts: sql`${messages.attempts} + 1`,
            nextAttemptAt: new Date(now.getTime() + 5 * 60_000),
          })
          .where(
            inArray(
              messages.id,
              due.map((row) => row.id),
            ),
          )
          .returning();
      });
    },
    async delivered(id: string, leaseId: string, now: Date) {
      await db
        .update(messages)
        .set({ deliveredAt: now, nextAttemptAt: null, lastError: null, leaseId: null })
        .where(and(eq(messages.id, id), eq(messages.leaseId, leaseId)));
    },
    async failed(id: string, leaseId: string, nextAttemptAt: Date | null, lastError: string) {
      await db
        .update(messages)
        .set({ nextAttemptAt, lastError, leaseId: null })
        .where(and(eq(messages.id, id), eq(messages.leaseId, leaseId)));
    },
    async retryFailed(id: string) {
      // Never steal an active send lease or resend mail already accepted by SMTP.
      return db
        .update(messages)
        .set({ attempts: 0, nextAttemptAt: new Date(), lastError: null })
        .where(
          and(eq(messages.ticketId, id), isNull(messages.deliveredAt), isNull(messages.leaseId)),
        )
        .returning();
    },
  };
}
export type CloudSupportRepo = ReturnType<typeof createCloudSupportRepo>;
