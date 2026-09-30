import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudDockerRuntime, CloudRuntime } from "@repo/adapters";
import type { Deployment, Domain, Project } from "@repo/db";

const h = vi.hoisted(() => ({
  project: {} as Project,
  deployment: {} as Deployment,
  domains: [] as Domain[],
  services: [] as any[],
  liveRows: [] as any[],
  runtime: {} as CloudRuntime | CloudDockerRuntime,
  expose: vi.fn(),
  connectDomain: vi.fn(),
  networkGet: vi.fn(),
  networkUpdate: vi.fn(),
  workspace: vi.fn(),
  pageGet: vi.fn(),
  pageEnable: vi.fn(),
  pageConnect: vi.fn(),
  genericRegister: vi.fn(),
  syncManagedEdge: vi.fn(),
  deregisterManagedEdge: vi.fn(),
  updateDeployment: vi.fn(),
  publishRoute: vi.fn(),
  containerInfo: vi.fn(),
}));

vi.mock("@repo/db", async (original) => ({
  ...(await original<typeof import("@repo/db")>()),
  repos: {
    project: { findById: vi.fn(async () => h.project) },
    deployment: { findById: vi.fn(async () => h.deployment), updateStatus: h.updateDeployment },
    domain: { listByProject: vi.fn(async () => h.domains) },
    service: {
      listByProject: vi.fn(async () => h.services),
      listByDeployment: vi.fn(async () => h.liveRows),
    },
  },
}));
vi.mock("@repo/adapters", async (original) => ({
  ...(await original<typeof import("@repo/adapters")>()),
  Oblien: class {
    workspace = h.workspace;
    pages = { get: h.pageGet, enable: h.pageEnable, connectDomain: h.pageConnect };
  },
}));
vi.mock("@repo/platform/engine/lib/cloud/client", () => ({
  getOrgCloudToken: vi.fn(async () => ({ token: "test-token", namespace: "ns-a" })),
}));
vi.mock("@repo/platform/engine/lib/cloud/admin-proxy", () => ({
  createRemoteCloudAdmin: () => ({}),
}));
vi.mock("@repo/platform/engine/lib/platform-config", () => ({
  platform: () => ({ target: "cloud", runtime: h.runtime }),
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/deployment-runtime")>()),
  resolveDeploymentPlatform: vi.fn(async () => ({
    effectiveTarget: "cloud",
    serverId: null,
    platform: { runtime: h.runtime, routing: { registerRoute: h.genericRegister } },
  })),
  disposePlatform: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/managed-edge-proxy", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/managed-edge-proxy")>()),
  syncManagedEdgeRoutes: h.syncManagedEdge,
  deregisterManagedEdgeRoutes: h.deregisterManagedEdge,
}));

import { retryProjectRouting } from "@repo/platform/engine/modules/projects/project-runtime.service";
import { reapplyProjectLiveRoutes } from "@repo/platform/engine/modules/domains/project-route.service";
import { reconcileProjectRoutes } from "@repo/platform/engine/lib/route-apply.service";

// Exercise real route planning, Cloud dispatch and provider calls together.
// Only persistence and provider I/O are replaced; no live customer route is used.
beforeEach(() => {
  vi.clearAllMocks();
  h.project = {
    id: "project-a",
    organizationId: "org-a",
    slug: "app",
    port: 8000,
    cloudWorkspaceId: null,
    serverId: null,
    activeDeploymentId: "deployment-a",
    hasServer: true,
    workloadType: "server",
    routingConfig: null,
  } as Project;
  h.deployment = {
    id: "deployment-a",
    projectId: h.project.id,
    organizationId: h.project.organizationId,
    containerId: "workspace-a",
    status: "ready",
    meta: {
      deployTarget: "cloud",
      edgeUnsynced: true,
      deployWarning: "Old server-address warning",
    },
  } as Deployment;
  h.domains = [
    {
      id: "domain-a",
      projectId: h.project.id,
      hostname: "app.opsh.io",
      domainType: "free",
      serviceId: null,
      isPrimary: true,
      verified: true,
      targetPort: 8000,
      targetPath: null,
    },
  ] as Domain[];
  h.services = [];
  h.liveRows = [];
  h.runtime = Object.create(CloudRuntime.prototype);
  h.workspace.mockReturnValue({
    publicAccess: { expose: h.expose },
    domains: { connect: h.connectDomain },
    network: { get: h.networkGet, update: h.networkUpdate },
  });
  h.networkGet.mockResolvedValue({ ingress_ports: [3000, 9000] });
  h.networkUpdate.mockResolvedValue({});
  h.expose.mockResolvedValue({ url: "https://app.opsh.io" });
  h.connectDomain.mockResolvedValue({});
  h.pageGet.mockResolvedValue({
    page: { slug: "app", namespace: "ns-a", url: "https://app.opsh.io" },
  });
  h.pageEnable.mockResolvedValue({});
  h.syncManagedEdge.mockResolvedValue({ failures: [] });
  h.updateDeployment.mockImplementation(async (_id, _status, changes) =>
    Object.assign(h.deployment, changes),
  );
  h.publishRoute.mockResolvedValue(undefined);
});

describe("Cloud route port edits and repair", () => {
  it("applies a changed port to the active workspace even without the project workspace column", async () => {
    await reapplyProjectLiveRoutes(h.project, ["app.opsh.io"]);
    expect(h.workspace).toHaveBeenCalledExactlyOnceWith("workspace-a");
    expect(h.expose).toHaveBeenCalledExactlyOnceWith({
      port: 8000,
      domain: "opsh.io",
      slug: "app",
    });
    expect(h.genericRegister).not.toHaveBeenCalled();
    expect(h.syncManagedEdge).not.toHaveBeenCalled();
  });

  it("uses the Cloud runtime default for a legacy deployment missing target metadata", async () => {
    h.deployment.meta = {};
    expect(await retryProjectRouting(h.project.id, h.project.organizationId)).toEqual({ ok: true });
    expect(h.expose).toHaveBeenCalledExactlyOnceWith({
      port: 8000,
      domain: "opsh.io",
      slug: "app",
    });
    expect(h.syncManagedEdge).not.toHaveBeenCalled();
    expect(h.genericRegister).not.toHaveBeenCalled();
  });

  it("updates a custom domain on the same workspace and preserves other ingress ports", async () => {
    h.domains[0] = { ...h.domains[0]!, hostname: "app.example.com", domainType: "custom" };
    await reapplyProjectLiveRoutes(h.project, ["app.example.com"]);
    expect(h.workspace).toHaveBeenCalledExactlyOnceWith("workspace-a");
    expect(h.networkUpdate).toHaveBeenCalledExactlyOnceWith({ ingress_ports: [3000, 9000, 8000] });
    expect(h.connectDomain).toHaveBeenCalledExactlyOnceWith({
      domain: "app.example.com",
      port: 8000,
    });
    expect(h.genericRegister).not.toHaveBeenCalled();
  });

  it.each([null, "/"])(
    "keeps a native Page route owned by the Page for path %s",
    async (targetPath) => {
      h.deployment.containerId = "page:app";
      h.domains[0]!.targetPath = targetPath;
      await reapplyProjectLiveRoutes(h.project, ["app.opsh.io"]);
      expect(h.pageEnable).toHaveBeenCalledExactlyOnceWith("app");
      expect(h.workspace).not.toHaveBeenCalled();
      expect(h.genericRegister).not.toHaveBeenCalled();
    },
  );

  it("retries the provider route and clears the old server warning only after verification", async () => {
    const verifyDomains = vi.fn(async () => {
      expect(h.expose).toHaveBeenCalledOnce();
      expect(h.updateDeployment).not.toHaveBeenCalled();
      return [];
    });
    expect(
      await retryProjectRouting(h.project.id, h.project.organizationId, { verifyDomains }),
    ).toEqual({ ok: true });
    expect(verifyDomains).toHaveBeenCalledOnce();
    expect(h.syncManagedEdge).not.toHaveBeenCalled();
    expect(h.deployment.meta).toEqual({ deployTarget: "cloud" });
  });

  it("keeps a provider rejection retryable without replacing it with server-IP advice", async () => {
    h.expose.mockRejectedValueOnce(new Error("Provider route update unavailable"));
    expect(await retryProjectRouting(h.project.id, h.project.organizationId)).toEqual({
      ok: false,
      warning: "Provider route update unavailable",
    });
    expect(h.deployment.meta).toMatchObject({
      edgeUnsynced: true,
      deployWarning: "Provider route update unavailable",
    });
    expect(h.syncManagedEdge).not.toHaveBeenCalled();
  });

  it("publishes one complete Docker route table using the selected container port", async () => {
    h.deployment.containerId = "compose";
    h.deployment.meta = {
      deployTarget: "cloud",
      cloudDockerWorkspace: { projectId: h.project.id, workspaceId: "workspace-a" },
    };
    h.services = [
      {
        id: "service-a",
        name: "web",
        enabled: true,
        kind: "compose",
        ports: ["8000"],
        exposed: false,
      },
    ];
    h.liveRows = [{ serviceId: "service-a", containerId: "container-a" }];
    h.runtime = Object.assign(Object.create(CloudDockerRuntime.prototype), {
      workspaceId: "workspace-a",
      getContainerInfo: h.containerInfo,
      publishRoute: h.publishRoute,
    });
    h.containerInfo.mockResolvedValue({
      containerId: "container-a",
      status: "running",
      hostPortByContainerPort: { 8000: 32000 },
    });
    expect(await retryProjectRouting(h.project.id, h.project.organizationId)).toEqual({ ok: true });
    expect(h.publishRoute).toHaveBeenCalledExactlyOnceWith(
      "app.opsh.io",
      32000,
      false,
      expect.objectContaining({
        routes: expect.arrayContaining([
          expect.objectContaining({
            action: { kind: "proxy", workspace: "workspace-a", port: 32000 },
          }),
        ]),
      }),
    );
    expect(h.genericRegister).not.toHaveBeenCalled();
    expect(h.syncManagedEdge).not.toHaveBeenCalled();
  });

  it("refuses a deployment from another project before any provider write", async () => {
    await expect(
      reconcileProjectRoutes(h.project, {
        deployment: { ...h.deployment, projectId: "other-project" },
        registers: [{ hostname: "app.opsh.io", port: 8000, isCustomDomain: false }],
      }),
    ).rejects.toThrow("active deployment changed");
    expect(h.workspace).not.toHaveBeenCalled();
    expect(h.pageEnable).not.toHaveBeenCalled();
    expect(h.genericRegister).not.toHaveBeenCalled();
  });
});
