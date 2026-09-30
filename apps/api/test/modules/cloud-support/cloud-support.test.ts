import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { AppError, SUPPORT_EMAIL } from "@repo/core";
import type { Database } from "@repo/db";
import { createCloudSupportRepo } from "../../../../../packages/db/src/repos/cloud-support.repo";
import { CloudSupportService } from "@repo/platform/engine/modules/cloud-support/service";

const state = vi.hoisted(() => ({
  env: { CLOUD_MODE: true, DEPLOY_MODE: "docker", INTERNAL_TOKEN: "operator-test-token" },
  service: null as CloudSupportService | null,
  limiter: vi.fn(),
  routeLimiter: vi.fn(),
  wake: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: state.env }));
vi.mock("@repo/platform/engine/config/index", () => ({ env: state.env }));
vi.mock("@repo/platform/engine/modules/cloud-support/index", () => ({
  cloudSupport: new Proxy(
    {},
    { get: (_, name) => (state.service as any)[name].bind(state.service) },
  ),
  deliverCloudSupport: state.wake,
}));
vi.mock("../../../src/lib/rate-limit", () => ({ rateLimit: state.limiter }));
// Auth for the operator routes stays real. Only unrelated identity/permission
// registration and the router's ordinary IP limiter are isolated here.
vi.mock("@repo/platform/engine/lib/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("../../../src/middleware/auth", () => ({ authMiddleware: vi.fn() }));
vi.mock("../../../src/middleware/rate-limiter", () => ({
  rateLimiterFor: () => async (_c: unknown, next: () => Promise<void>) => {
    state.routeLimiter();
    await next();
  },
}));

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let repo: ReturnType<typeof createCloudSupportRepo>;
let app: Hono;
const send = vi.fn();
const input = (extra = {}) => ({
  requestId: randomUUID(),
  name: "Cloud customer",
  email: "customer@example.com",
  subject: "Deployment does not start",
  message: "The Docker connection never becomes ready.",
  source: "support",
  ...extra,
});
const call = (path: string, method = "GET", body?: unknown, operator = false) =>
  app.request(`/api/cloud/support${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(operator ? { "X-Internal-Token": state.env.INTERNAL_TOKEN } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

beforeAll(async () => {
  client = new PGlite("memory://");
  await client.exec(
    readFileSync(
      new URL("../../../../../packages/db/drizzle/0152_cloud_support.sql", import.meta.url),
      "utf8",
    ),
  );
  db = drizzle(client);
  repo = createCloudSupportRepo(db as unknown as Database);
  state.service = new CloudSupportService({ enabled: () => state.env.CLOUD_MODE, repo, send });
  const { cloudSupportRoutes } =
    await import("../../../src/modules/cloud-support/cloud-support.routes");
  app = new Hono();
  app.onError((error, c) =>
    c.json(
      { error: error instanceof AppError ? error.message : "Unavailable" },
      (error instanceof AppError ? error.statusCode : 500) as 400,
    ),
  );
  app.route("/api/cloud/support", cloudSupportRoutes);
  // Cold PostgreSQL WASM startup and route transforms contend with the full API suite.
}, 30_000);
beforeEach(async () => {
  state.env.CLOUD_MODE = true;
  await client.exec("TRUNCATE cloud_support_ticket CASCADE");
  send.mockReset().mockResolvedValue(true);
  state.limiter.mockReset().mockResolvedValue({ allowed: true, resetMs: 1000, remaining: 4 });
  state.wake.mockClear();
});
afterAll(async () => {
  await client?.close();
});

describe("Cloud support tickets", () => {
  it("commits the ticket and both email jobs before acknowledging receipt", async () => {
    const response = await call("", "POST", input());
    expect(response.status).toBe(201);
    const receipt = await response.json();
    expect(Object.keys(receipt).sort()).toEqual(["createdAt", "id"]);
    expect(receipt.id).toMatch(/^SUP-[A-F0-9]{24}$/);
    expect(await repo.find(receipt.id)).toMatchObject({
      email: "customer@example.com",
      status: "open",
    });
    expect((await repo.messages(receipt.id)).map((m) => m.kind).sort()).toEqual([
      "notification",
      "receipt",
    ]);
    expect(send).not.toHaveBeenCalled();
    expect(state.wake).toHaveBeenCalledOnce();
    expect(state.limiter.mock.calls[0]![0].subjectId).toMatch(/^[a-f0-9]{64}$/);
  });

  it("retries a lost response without duplicating requests or charging the contact limit again", async () => {
    const body = input();
    const first = await (await call("", "POST", body)).json();
    state.limiter.mockResolvedValue({ allowed: false, resetMs: 900_000 });
    const retry = await call("", "POST", body);
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(first);
    expect(state.limiter).toHaveBeenCalledOnce();
    expect(await repo.messages(first.id)).toHaveLength(2);
    expect((await call("", "POST", { ...body, message: "A different message" })).status).toBe(409);
  });

  it("deduplicates concurrent submissions atomically", async () => {
    const body = input();
    const receipts = await Promise.all(
      Array.from({ length: 4 }, () => state.service!.submit(body, async () => {})),
    );
    expect(new Set(receipts.map((r) => r.id)).size).toBe(1);
    expect(await repo.messages(receipts[0]!.id)).toHaveLength(2);
    expect(await repo.list({ limit: 25 })).toHaveLength(1);
  });

  it("rolls back the request if its outbox cannot be committed", async () => {
    await client.exec(
      "ALTER TABLE cloud_support_message ADD CONSTRAINT reject_test CHECK (kind <> 'notification')",
    );
    try {
      expect((await call("", "POST", input())).status).toBe(500);
      expect(await repo.list({ limit: 25 })).toHaveLength(0);
    } finally {
      await client.exec("ALTER TABLE cloud_support_message DROP CONSTRAINT reject_test");
    }
  });

  it("persists requests during SMTP failure, retries after restart, and never re-sends the successful half", async () => {
    const receipt = await (await call("", "POST", input())).json();
    send.mockImplementation(async (mail) => mail.to === SUPPORT_EMAIL);
    expect(await state.service!.flush()).toEqual({ delivered: 1, failed: 1 });
    expect(await repo.find(receipt.id)).not.toBeNull();
    const failed = (await repo.messages(receipt.id)).find((m) => m.kind === "receipt")!;
    expect(failed.deliveredAt).toBeNull();
    expect(failed.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(failed.lastError).toContain("SMTP");
    const restarted = new CloudSupportService({ enabled: () => true, repo, send });
    await db.execute(
      sql`UPDATE cloud_support_message SET next_attempt_at = now() WHERE delivered_at IS NULL`,
    );
    send.mockClear().mockResolvedValue(true);
    expect(await restarted.flush()).toEqual({ delivered: 1, failed: 0 });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({
      to: "customer@example.com",
      replyTo: SUPPORT_EMAIL,
      messageId: expect.stringMatching(/^<support-.*@openship.io>$/),
    });
    expect(send.mock.calls[0]![0].text).toContain(receipt.id);
    expect((await repo.messages(receipt.id)).every((m) => m.deliveredAt)).toBe(true);
  });

  it("does not reflect arbitrary user content in acknowledgement mail and escapes team mail", async () => {
    await call(
      "",
      "POST",
      input({
        name: "<img src=x>",
        subject: "<script>attack</script>",
        message: "<a href='https://attacker.invalid'>Attack</a>",
      }),
    );
    await state.service!.flush();
    const confirmation = send.mock.calls.find(([mail]) => mail.to === "customer@example.com")![0];
    expect(confirmation.text).not.toContain("attacker.invalid");
    expect(confirmation.subject).not.toContain("script");
    const notification = send.mock.calls.find(([mail]) => mail.to === SUPPORT_EMAIL)![0];
    expect(notification.replyTo).toBe("customer@example.com");
    expect(notification.html).not.toContain("<script>");
    expect(notification.html).toContain("&lt;script&gt;");
  });

  it("serializes delivery claims across workers and recovers a dead worker's lease", async () => {
    const receipt = await (await call("", "POST", input())).json();
    const claimed = await repo.claim("old-worker", new Date(), 4);
    expect(claimed).toHaveLength(2);
    expect(await repo.claim("other-worker", new Date(), 4)).toHaveLength(0);
    const recovered = await repo.claim("new-worker", new Date(Date.now() + 6 * 60_000), 4);
    expect(recovered).toHaveLength(2);
    await repo.delivered(claimed[0]!.id, "old-worker", new Date());
    expect((await repo.messages(receipt.id)).every((m) => m.deliveredAt === null)).toBe(true);
  });

  it("stops repeated delivery failures after the retry budget and allows an operator to resume them", async () => {
    const receipt = await (await call("", "POST", input())).json();
    await db.execute(sql`UPDATE cloud_support_message SET attempts = 9`);
    send.mockResolvedValue(false);
    expect(await state.service!.flush()).toEqual({ delivered: 0, failed: 2 });
    expect(
      (await repo.messages(receipt.id)).every((m) => m.nextAttemptAt === null && m.attempts === 10),
    ).toBe(true);
    expect(await state.service!.flush()).toEqual({ delivered: 0, failed: 0 });
    expect((await call(`/tickets/${receipt.id}/retry`, "POST", undefined, true)).status).toBe(202);
    send.mockResolvedValue(true);
    expect(await state.service!.flush()).toEqual({ delivered: 2, failed: 0 });
  });

  it.each([
    { email: "a@example.com\r\nBcc: b@example.com" },
    { email: "a\u0000@example.com" },
    { email: "a@example.com,b@example.com" },
    { subject: "Bad\nheader" },
    { message: "  " },
    { requestId: "invalid" },
    { name: " " },
    { message: "x".repeat(12_001) },
    { organizationId: "someone-else" },
  ])("rejects invalid or privileged input %#", async (extra) => {
    expect((await call("", "POST", input(extra))).status).toBe(400);
    expect(await repo.list({ limit: 25 })).toHaveLength(0);
    expect(state.wake).not.toHaveBeenCalled();
  });

  it("limits new submissions and rejects oversized streaming bodies", async () => {
    state.limiter.mockResolvedValue({ allowed: false, resetMs: 90_000 });
    const response = await call("", "POST", input());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("90");
    expect((await call("", "POST", input({ message: "x".repeat(66_000) }))).status).toBe(413);
    expect(await repo.list({ limit: 25 })).toHaveLength(0);
  });

  it("requires operator credentials to read, reply, close, or retry mail", async () => {
    const receipt = await (await call("", "POST", input())).json();
    for (const [method, path, body] of [
      ["GET", "/tickets"],
      ["GET", `/tickets/${receipt.id}`],
      ["PATCH", `/tickets/${receipt.id}`, { status: "resolved" }],
      [
        "POST",
        `/tickets/${receipt.id}/replies`,
        { requestId: randomUUID(), message: "Reply", resolve: true },
      ],
      ["POST", `/tickets/${receipt.id}/retry`],
    ] as const) {
      expect((await call(path, method, body)).status).toBe(401);
    }
    expect((await repo.find(receipt.id))!.status).toBe("open");
    expect((await call(`/tickets/${receipt.id}`, "GET", undefined, true)).status).toBe(200);
  });

  it("queues an idempotent operator reply and resolves the ticket in the same transaction", async () => {
    const receipt = await (await call("", "POST", input())).json();
    await state.service!.flush();
    send.mockClear();
    const body = {
      requestId: randomUUID(),
      message: "The deployment connection is restored.",
      resolve: true,
    };
    expect((await call(`/tickets/${receipt.id}/replies`, "POST", body, true)).status).toBe(202);
    expect((await repo.find(receipt.id))!.status).toBe("resolved");
    await call(`/tickets/${receipt.id}/replies`, "POST", body, true);
    expect((await repo.messages(receipt.id)).filter((m) => m.kind === "reply")).toHaveLength(1);
    expect(
      (
        await call(
          `/tickets/${receipt.id}/replies`,
          "POST",
          { ...body, message: "Changed reply" },
          true,
        )
      ).status,
    ).toBe(409);
    await state.service!.flush();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0].text).toContain(body.message);
    expect((await call(`/tickets/${receipt.id}`, "PATCH", { status: "open" }, true)).status).toBe(
      200,
    );
    expect((await repo.find(receipt.id))!.status).toBe("open");
  });

  it("paginates a stable operator queue and bounds queries", async () => {
    for (let i = 0; i < 3; i++) await call("", "POST", input({ subject: `Issue ${i}` }));
    const first = await (await call("/tickets?limit=2", "GET", undefined, true)).json();
    const second = await (
      await call(`/tickets?limit=2&before=${first.nextCursor}`, "GET", undefined, true)
    ).json();
    expect(first.tickets).toHaveLength(2);
    expect(second.tickets).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.tickets, ...second.tickets].map((t: { id: string }) => t.id)).size,
    ).toBe(3);
    expect((await call("/tickets?limit=999", "GET", undefined, true)).status).toBe(400);
  });

  it("does no support work outside Cloud mode", async () => {
    state.env.CLOUD_MODE = false;
    expect((await call("", "POST", input())).status).toBe(404);
    expect((await call("/tickets", "GET", undefined, true)).status).toBe(404);
    await expect(state.service!.submit(input(), async () => {})).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(await state.service!.flush()).toEqual({ delivered: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(await repo.list({ limit: 25 })).toHaveLength(0);
  });
});
