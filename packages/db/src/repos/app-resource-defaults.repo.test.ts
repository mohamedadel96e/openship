import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDatabase, createRepositories, schema, type DatabaseConnection } from "../factory";
import { createEncryption } from "../encryption";

describe("atomic resource defaults for unfinished apps", () => {
  const encryption = createEncryption("app-resource-defaults-test");
  let connection: DatabaseConnection;
  let repos: ReturnType<typeof createRepositories>;
  let sequence = 0;
  const resources = { cpuCores: 1, memoryMb: 3072, diskMb: 40960 };
  beforeAll(async () => {
    connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
    repos = createRepositories(connection.db, encryption);
    await connection.db.insert(schema.organization).values([
      { id: "org-a", name: "A" },
      { id: "org-b", name: "B" },
    ]);
  });
  afterAll(async () => {
    await connection?.close();
    encryption.close();
  });

  async function fixture() {
    const slug = `app-${++sequence}`;
    const group = await repos.projectGroup.create({ organizationId: "org-a", name: slug, slug });
    const project = await repos.project.create({
      groupId: group.id,
      organizationId: "org-a",
      name: slug,
      slug,
      isApp: true,
      appTemplateId: "supabase",
    });
    const services = await repos.service.syncFromCompose(project.id, [
      {
        name: "db",
        image: "postgres:17",
        advanced: { files: [{ path: "/secret", content: "private-config" }] },
      },
      { name: "auth", image: "example/auth:1" },
    ]);
    const input = {
      projectId: project.id,
      organizationId: "org-a",
      appTemplateId: "supabase",
      profiles: services.map((service) => ({ name: service.name, resources })),
    };
    return { project, services, input };
  }

  it("fills missing profiles together and preserves encrypted config and explicit overrides", async () => {
    const { services, input } = await fixture();
    const db = services.find((s) => s.name === "db")!;
    const auth = services.find((s) => s.name === "auth")!;
    const override = { cpuCores: 0.25, memoryMb: 256 };
    await repos.service.update(auth.id, { advanced: { resources: override } });
    const rawBefore = await connection.db.query.service.findFirst({
      where: eq(schema.service.id, db.id),
    });
    expect(JSON.stringify(rawBefore!.advanced)).not.toContain("private-config");
    expect(await repos.service.seedDraftAppResourceDefaults(input)).toEqual([db.id]);
    expect((await repos.service.findById(db.id))?.advanced).toEqual({ ...db.advanced, resources });
    expect((await repos.service.findById(auth.id))?.advanced?.resources).toEqual(override);
    const rawAfter = await connection.db.query.service.findFirst({
      where: eq(schema.service.id, db.id),
    });
    expect(typeof rawAfter!.advanced).toBe("string");
    expect(JSON.stringify(rawAfter!.advanced)).not.toContain("private-config");
    expect(await repos.service.seedDraftAppResourceDefaults(input)).toEqual([]);
    expect(
      await connection.db.query.service.findFirst({ where: eq(schema.service.id, db.id) }),
    ).toEqual(rawAfter);
  });

  it("cannot cross organization or template ownership", async () => {
    const { input } = await fixture();
    expect(
      await repos.service.seedDraftAppResourceDefaults({ ...input, organizationId: "org-b" }),
    ).toEqual([]);
    expect(
      await repos.service.seedDraftAppResourceDefaults({ ...input, appTemplateId: "another-app" }),
    ).toEqual([]);
    expect(
      (await repos.service.listByProject(input.projectId)).every((s) => !s.advanced?.resources),
    ).toBe(true);
  });

  it.each([
    { activeDeploymentId: "active-release" },
    { resources: { cpuCores: 1, memoryMb: 2048, diskMb: 16384 } },
    { deletedAt: new Date("2026-01-01T00:00:00Z") },
    { deletionInProgress: true },
  ])(
    "does not override project settings or touch deployed/deleting projects: %j",
    async (patch) => {
      const { input } = await fixture();
      await connection.db
        .update(schema.project)
        .set(patch)
        .where(eq(schema.project.id, input.projectId));
      expect(await repos.service.seedDraftAppResourceDefaults(input)).toEqual([]);
      expect(
        (await repos.service.listByProject(input.projectId)).every((s) => !s.advanced?.resources),
      ).toBe(true);
    },
  );

  it("serializes concurrent retries so profiles cannot be mixed between catalog versions", async () => {
    const { input } = await fixture();
    const different = { cpuCores: 2, memoryMb: 2048, diskMb: 8192 };
    const result = await Promise.all([
      repos.service.seedDraftAppResourceDefaults(input),
      repos.service.seedDraftAppResourceDefaults({
        ...input,
        profiles: input.profiles.map((s) => ({ ...s, resources: different })),
      }),
    ]);
    expect(result.map((ids) => ids.length).sort()).toEqual([0, 2]);
    const stored = (await repos.service.listByProject(input.projectId)).map(
      (s) => s.advanced?.resources,
    );
    expect(stored[0]).toEqual(stored[1]);
    expect([resources, different]).toContainEqual(stored[0]);
  });

  it("rolls back the entire profile set if one service update fails", async () => {
    const { input } = await fixture();
    input.profiles.sort((a, b) => (a.name === "db" ? -1 : b.name === "db" ? 1 : 0));
    await connection.db.execute(sql`CREATE FUNCTION reject_app_profile() RETURNS trigger AS $$
      BEGIN IF NEW.name = 'auth' THEN RAISE EXCEPTION 'profile write failed'; END IF; RETURN NEW; END;
      $$ LANGUAGE plpgsql`);
    await connection.db.execute(sql`CREATE TRIGGER reject_app_profile BEFORE UPDATE ON service
      FOR EACH ROW EXECUTE FUNCTION reject_app_profile()`);
    try {
      await expect(repos.service.seedDraftAppResourceDefaults(input)).rejects.toThrow();
      expect(
        (await repos.service.listByProject(input.projectId)).every((s) => !s.advanced?.resources),
      ).toBe(true);
    } finally {
      await connection.db.execute(sql`DROP TRIGGER reject_app_profile ON service`);
      await connection.db.execute(sql`DROP FUNCTION reject_app_profile()`);
    }
  });

  it("fails closed when stored configuration cannot be decrypted", async () => {
    const { input, services } = await fixture();
    await connection.db
      .execute(sql`UPDATE service SET advanced = '"openship:config:v1:invalid"'::jsonb
      WHERE id = ${services[1]!.id}`);
    const before = await connection.db
      .select()
      .from(schema.service)
      .where(eq(schema.service.projectId, input.projectId));
    await expect(repos.service.seedDraftAppResourceDefaults(input)).rejects.toThrow(
      "Unable to decrypt stored configuration",
    );
    expect(
      await connection.db
        .select()
        .from(schema.service)
        .where(eq(schema.service.projectId, input.projectId)),
    ).toEqual(before);
  });
});
