import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("@repo/platform/engine/config/env", async (original) => {
  const config = await original<typeof import("@repo/platform/engine/config/env")>();
  return {
    ...config,
    env: {
      ...config.env,
      CLOUD_MODE: true,
      OBLIEN_API_URL: "https://provider.openship.test",
      OBLIEN_CLIENT_ID: "test-control-plane",
      OBLIEN_CLIENT_SECRET: "test-control-plane-secret",
    },
  };
});
vi.mock("@repo/platform/engine/lib/openship-cloud", () => ({
  issueNamespaceToken: async (organizationId: string) => ({
    namespace: `ns-${organizationId}`,
    token: `test-${organizationId}`,
  }),
}));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", async (original) => ({
  ...(await original<object>()),
  assertCloudCanSpend: async () => {},
}));

import {
  db,
  schema,
  repos,
  seedOwner,
  installFakeRunner,
  type SeededOwner,
} from "../jobs/_harness";
import { eq } from "@repo/db";
import { getAppTemplate } from "@repo/core";
import { initPlatform, resetPlatform } from "@repo/adapters";
import {
  cloudDockerResources,
  ensureCloudDockerWorkspace,
} from "@repo/platform/engine/lib/cloud-docker-workspace";
import { appRoutes } from "../../../src/modules/apps/app.routes";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

// Real authenticated HTTP install/delete, shared engine, SQL repositories, and
// Oblien adapter. Only the external provider transport and billing admission
// are simulated; no Docker daemon or paid Cloud resources are needed.
installFakeRunner();
const app = new Hono()
  .onError(handleApiError)
  .route("/api/apps", appRoutes)
  .route("/api/projects", projectRoutes);

interface ProviderWorkspace {
  id: string;
  namespace: string;
  slug: string;
  status: string;
  provisioning: { state: string };
  resources?: { cpus: number; memory_mb: number; disk_size_mb: number };
}

let workspaces: Map<string, ProviderWorkspace>;
let requests: string[];
let createMode: "quota" | "legacy-quota" | "failed-workspace" | "lost-response" | "unknown";
let deleteFails: boolean;
let deleting: Set<string>;
const resources = { cpuCores: 2, memoryMb: 4096, diskMb: 32768 };

beforeEach(async () => {
  workspaces = new Map();
  requests = [];
  deleting = new Set();
  createMode = "quota";
  deleteFails = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== "https://provider.openship.test") {
        // Catalog overlay refresh is advisory. Keep this test on the bundled
        // Supabase catalog and never allow external network access.
        throw new Error(`Network disabled in Cloud lifecycle test: ${url.origin}`);
      }
      const method = init?.method ?? "GET";
      requests.push(`${method} ${url.pathname}`);
      if (url.pathname === "/workspace" && method === "POST") {
        if (createMode === "quota" || createMode === "legacy-quota") {
          return Response.json(
            { success: false, code: "NAMESPACE_LIMIT_REACHED" },
            {
              status: createMode === "quota" ? 409 : 200,
            },
          );
        }
        if (createMode === "unknown") throw new TypeError("provider response lost");
        const body = JSON.parse(String(init?.body));
        const workspace: ProviderWorkspace = {
          id: "ws-initial-failure",
          namespace: body.namespace,
          slug: body.slug,
          status: "error",
          provisioning: { state: "failed" },
          resources: {
            cpus: body.config.cpus,
            memory_mb: body.config.memory_mb,
            disk_size_mb: body.config.disk_size_mb,
          },
        };
        workspaces.set(workspace.id, workspace);
        if (createMode === "lost-response") throw new TypeError("provider response lost");
        return Response.json(
          {
            code: "CREATE_FAILED",
            details: { workspace_id: workspace.id },
          },
          { status: 422 },
        );
      }
      if (url.pathname === "/workspace" && method === "GET") {
        return Response.json({
          success: true,
          workspaces: [...workspaces.values()],
          total: workspaces.size,
          limit: 100,
          page: 1,
        });
      }
      const workspaceId = url.pathname.match(/^\/workspace\/([^/]+)$/)?.[1];
      const retryId = url.pathname.match(/^\/workspace\/([^/]+)\/provisioning\/retry$/)?.[1];
      if (retryId && method === "POST") {
        const workspace = workspaces.get(retryId)!;
        workspace.status = "running";
        workspace.provisioning.state = "ready";
        return Response.json({ success: true, workspace });
      }
      if (url.pathname.endsWith("/lifecycle/permanent") && method === "POST")
        return Response.json({ success: true });
      if (workspaceId && method === "GET") {
        // Async deletion is only complete once a subsequent read confirms absent.
        if (deleting.has(workspaceId)) workspaces.delete(workspaceId);
        const workspace = workspaces.get(workspaceId);
        return workspace
          ? Response.json({ success: true, workspace })
          : Response.json({ code: "NOT_FOUND" }, { status: 404 });
      }
      if (workspaceId && method === "DELETE") {
        if (deleteFails) return Response.json({ code: "PROVIDER_UNAVAILABLE" }, { status: 503 });
        deleting.add(workspaceId);
        return Response.json({ success: true, accepted: true });
      }
      if (url.pathname === "/pages" && method === "GET")
        return Response.json({ success: true, pages: [] });
      if (url.pathname === "/domain/routes" && method === "GET")
        return Response.json({ success: true, data: [] });
      throw new Error(`Unexpected provider request: ${method} ${url.pathname}`);
    }),
  );
  await initPlatform({
    target: "cloud",
    cloudToken: "test-platform-token",
    cloudNamespace: "test-platform",
    cloudApiUrl: "https://provider.openship.test",
  });
});

afterEach(() => {
  resetPlatform();
  vi.unstubAllGlobals();
});

async function installSupabase(tier: "pro" | "starter" = "pro") {
  const owner = await seedOwner();
  await db
    .update(schema.organization)
    .set({ planTierId: tier })
    .where(eq(schema.organization.id, owner.orgId));
  const response = await app.request("/api/apps", {
    method: "POST",
    headers: { ...owner.auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      templateId: "supabase",
      name: "Supabase",
      routes: [{ service: "kong", port: 8000, mode: "free" }],
    }),
  });
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  const projectId = result.data?.projectId as string;
  expect(projectId).toBeTruthy();
  const services = await repos.service.listByProject(projectId);
  expect(services).toHaveLength(getAppTemplate("supabase")!.services!.length);
  expect(
    cloudDockerResources({
      services: services.map((service) => ({ resources: service.advanced?.resources })),
    }),
  ).toEqual({ cpuCores: 4, memoryMb: 8192, diskMb: 40960 });
  expect(services.find((service) => service.name === "kong")?.publicEndpoints).toEqual([
    { port: 8000, domainType: "free", domain: "supabase-kong" },
  ]);
  expect(services.find((service) => service.name === "db")?.exposed).toBe(false);
  const secrets = await repos.project.listEnvVars(projectId);
  expect(secrets.some((value) => value.key === "POSTGRES_PASSWORD" && value.isSecret)).toBe(true);
  return { owner, projectId, secrets };
}

async function failProvisioning(owner: SeededOwner, projectId: string) {
  await expect(
    ensureCloudDockerWorkspace({
      projectId,
      organizationId: owner.orgId,
      resources,
    }),
  ).rejects.toBeInstanceOf(Error);
}

async function remove(owner: SeededOwner, projectId: string) {
  const response = await app.request(`/api/projects/${projectId}?wipeVolumes=true`, {
    method: "DELETE",
    headers: owner.auth,
  });
  return { status: response.status, body: await response.json() };
}

async function expectDeleted(projectId: string) {
  expect(await repos.project.findById(projectId)).toBeUndefined();
  expect(await repos.service.listByProject(projectId)).toEqual([]);
  expect(await repos.project.listEnvVars(projectId)).toEqual([]);
  expect(workspaces.size).toBe(0);
}

describe("Supabase Cloud installation failure and deletion", () => {
  it("saves an explicitly chosen MongoDB hostname exactly while keeping its database unrouted", async () => {
    const owner = await seedOwner();
    await db.update(schema.organization).set({ planTierId: "pro" }).where(eq(schema.organization.id, owner.orgId));
    const response = await app.request("/api/apps", {
      method: "POST",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "mongodb",
        name: "Production database",
        routes: [{ service: "mongo-express", port: 8081, mode: "free", domain: "mongodb-mongo-express" }],
      }),
    });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    const services = await repos.service.listByProject(result.data.projectId);
    expect(services.find(service => service.name === "mongo-express")).toMatchObject({
      exposed: true,
      publicEndpoints: [{ port: 8081, domainType: "free", domain: "mongodb-mongo-express" }],
    });
    expect(services.find(service => service.name === "mongo")?.exposed).toBe(false);
    expect(requests.some(request => request.startsWith("POST "))).toBe(false);
  });

  it("assigns automatic domains from the new instance's unique name", async () => {
    const owner = await seedOwner();
    await db.update(schema.organization).set({ planTierId: "pro" }).where(eq(schema.organization.id, owner.orgId));
    const headers = { ...owner.auth, "Content-Type": "application/json" };
    const existing = await app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "MongoDB", projectType: "services", hasBuild: false }),
    });
    expect(existing.ok, await existing.text()).toBe(true);
    const response = await app.request("/api/apps", {
      method: "POST",
      headers,
      body: JSON.stringify({
        templateId: "mongodb",
        name: "MongoDB",
        routes: [{ service: "mongo-express", port: 8081, mode: "free" }],
      }),
    });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result.data.slug).toBe("mongodb-2");
    const services = await repos.service.listByProject(result.data.projectId);
    expect(services.find(service => service.name === "mongo-express")?.publicEndpoints).toEqual([
      { port: 8081, domainType: "free", domain: "mongodb-2-mongo-express" },
    ]);
    expect(requests.some(request => request.startsWith("POST "))).toBe(false);
  });

  it("can save the complete draft without consuming slots before deployment admission", async () => {
    const { owner, projectId, secrets } = await installSupabase("starter");
    expect(await repos.service.countRunningForOrg(owner.orgId)).toBe(0);
    const response = await app.request(
      `/api/apps/catalog/supabase/host-fit?deployTarget=cloud&projectId=${projectId}`,
      { headers: owner.auth },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data.cloud.status).toBe("upgrade");
    expect(await repos.project.listEnvVars(projectId)).toEqual(secrets);
    expect(requests.some((request) => request.startsWith("POST "))).toBe(false);
  });
  it("previews the plan and actual draft resources without provisioning or changing saved settings", async () => {
    const { owner, projectId, secrets } = await installSupabase();
    const preview = async () => {
      const response = await app.request(
        `/api/apps/catalog/supabase/host-fit?deployTarget=cloud&projectId=${projectId}`,
        { headers: owner.auth },
      );
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      return body.data.cloud;
    };
    expect(await preview()).toMatchObject({
      status: "upgrade",
      resources: { cpuCores: 4, memoryMb: 8192, diskMb: 40960 },
    });
    await db
      .update(schema.organization)
      .set({ planTierId: "team" })
      .where(eq(schema.organization.id, owner.orgId));
    expect(await preview()).toMatchObject({ status: "ready" });
    const services = await repos.service.listByProject(projectId);
    const database = services.find((service) => service.name === "db")!;
    await repos.service.update(database.id, {
      advanced: { ...database.advanced, resources: { cpuCores: 3, memoryMb: 3072, diskMb: 40960 } },
    });
    expect(await preview()).toMatchObject({ status: "upgrade", resources: { cpuCores: 6 } });
    expect((await repos.service.findById(database.id))?.advanced?.resources?.cpuCores).toBe(3);
    expect(await repos.project.listEnvVars(projectId)).toEqual(secrets);
    expect(requests.some((request) => request.startsWith("POST "))).toBe(false);
    const outsider = await seedOwner();
    const forbidden = await app.request(
      `/api/apps/catalog/supabase/host-fit?deployTarget=cloud&projectId=${projectId}`,
      { headers: outsider.auth },
    );
    expect([403, 404]).toContain(forbidden.status);
    expect(await forbidden.text()).not.toContain("cpuCores");
  });

  it("checks Cloud apps without declared host minimums before a project exists", async () => {
    const owner = await seedOwner();
    await db
      .update(schema.organization)
      .set({ planTierId: "hobby" })
      .where(eq(schema.organization.id, owner.orgId));
    const response = await app.request("/api/apps/catalog/ghost/host-fit?deployTarget=cloud", {
      headers: owner.auth,
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.data.cloud).toMatchObject({ status: "upgrade" });
    expect(requests.some((request) => request.startsWith("POST "))).toBe(false);
  });

  it.each(["quota", "legacy-quota"] as const)(
    "deletes a %s refusal without creating anything during cleanup",
    async (mode) => {
      createMode = mode;
      const { owner, projectId } = await installSupabase();
      await failProvisioning(owner, projectId);
      expect(await repos.cloudDockerWorkspace.find(projectId, owner.orgId)).toBeUndefined();
      const beforeDelete = requests.length;
      const result = await remove(owner, projectId);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(requests.slice(beforeDelete).every((request) => request.startsWith("GET "))).toBe(
        true,
      );
      await expectDeleted(projectId);
    },
  );

  it("retains the failed VM and project data on cleanup failure, then confirms async deletion on retry", async () => {
    createMode = "failed-workspace";
    const { owner, projectId, secrets } = await installSupabase();
    await failProvisioning(owner, projectId);
    expect(await repos.cloudDockerWorkspace.find(projectId, owner.orgId)).toMatchObject({
      workspaceId: "ws-initial-failure",
    });
    const beforeDelete = requests.length;
    deleteFails = true;
    const failure = await remove(owner, projectId);
    expect(failure.status, JSON.stringify(failure.body)).toBe(409);
    expect(failure.body.code).toBe("PROJECT_TEARDOWN_FAILED");
    expect(JSON.stringify(failure.body.unrecoverable)).toContain("PROVIDER_UNAVAILABLE");
    expect(await repos.project.findById(projectId)).toMatchObject({ deletionInProgress: false });
    expect(await repos.project.listEnvVars(projectId)).toEqual(secrets);
    expect(workspaces.size).toBe(1);

    deleteFails = false;
    const retry = await remove(owner, projectId);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    await expectDeleted(projectId);
    const cleanup = requests.slice(beforeDelete);
    expect(cleanup.some((request) => request.startsWith("POST "))).toBe(false);
    expect(cleanup.at(-1)).toBe("GET /workspace/ws-initial-failure");
  });

  it("recovers a lost create response by namespace and project slug before deleting the failed VM", async () => {
    createMode = "lost-response";
    const { owner, projectId } = await installSupabase();
    await failProvisioning(owner, projectId);
    expect(await repos.cloudDockerWorkspace.find(projectId, owner.orgId)).toMatchObject({
      workspaceId: null,
    });
    const beforeDelete = requests.length;
    const stranger = await seedOwner();
    expect((await remove(stranger, projectId)).status).toBe(404);
    expect(requests).toHaveLength(beforeDelete);
    const result = await remove(owner, projectId);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(requests.slice(beforeDelete).some((request) => request.startsWith("POST "))).toBe(false);
    await expectDeleted(projectId);
  });

  it("recovers the original VM when a create replay hits quota, then retries and deletes that same VM", async () => {
    createMode = "lost-response";
    const { owner, projectId, secrets } = await installSupabase();
    await failProvisioning(owner, projectId);
    const reserved = await repos.cloudDockerWorkspace.find(projectId, owner.orgId);
    expect(reserved?.workspaceId).toBeNull();
    createMode = "quota";

    const recovered = await ensureCloudDockerWorkspace({ projectId, organizationId: owner.orgId, resources });

    expect(recovered.workspaceId).toBe("ws-initial-failure");
    expect(await repos.cloudDockerWorkspace.find(projectId, owner.orgId)).toMatchObject({
      provisionKey: reserved!.provisionKey,
      workspaceId: "ws-initial-failure",
      state: "ready",
    });
    expect(workspaces.size).toBe(1);
    expect(requests.filter(request => request === "POST /workspace")).toHaveLength(2);
    expect(requests).toContain("POST /workspace/ws-initial-failure/provisioning/retry");
    expect(await repos.project.listEnvVars(projectId)).toEqual(secrets);
    const removed = await remove(owner, projectId);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    await expectDeleted(projectId);
  });

  it("preserves an uncertain old reservation when the provider cannot confirm its outcome", async () => {
    createMode = "unknown";
    const { owner, projectId, secrets } = await installSupabase();
    await failProvisioning(owner, projectId);
    const binding = await repos.cloudDockerWorkspace.find(projectId, owner.orgId);
    const result = await remove(owner, projectId);
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(result.body.canForceOrphan).toBe(false);
    expect(await repos.cloudDockerWorkspace.find(projectId, owner.orgId)).toEqual(binding);
    expect(await repos.project.listEnvVars(projectId)).toEqual(secrets);
    expect(await repos.project.findById(projectId)).toMatchObject({ deletionInProgress: false });
  });
});
