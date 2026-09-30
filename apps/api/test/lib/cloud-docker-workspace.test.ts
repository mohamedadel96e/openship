import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Project } from "@repo/db";

const h = vi.hoisted(() => ({
  owner: vi.fn(), find: vi.fn(), reserve: vi.fn(), attach: vi.fn(), ready: vi.fn(), active: vi.fn(),
  token: vi.fn(), spend: vi.fn(), create: vi.fn(), retry: vi.fn(), get: vi.fn(), start: vi.fn(), resume: vi.fn(),
  permanent: vi.fn(), resize: vi.fn(), wait: vi.fn(), credentials: [] as unknown[],
  inFlight: vi.fn(), discard: vi.fn(), list: vi.fn(), exec: vi.fn(), invalidate: vi.fn(), dispose: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  withAdvisoryLock: async (_key: string, run: () => Promise<unknown>) => run(),
  repos: { project: { findByIdInOrganization: h.owner }, deployment: { findById: h.active, listInFlightByProject: h.inFlight },
    cloudDockerWorkspace: { find: h.find, reserve: h.reserve, attach: h.attach, markReady: h.ready, discardUncreated: h.discard } },
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: { CLOUD_MODE: true, OBLIEN_API_URL: "https://staging.oblien.test" } }));
vi.mock("@repo/platform/engine/lib/openship-cloud", () => ({ issueNamespaceToken: h.token }));
vi.mock("@repo/platform/engine/lib/cloud/client", () => ({ getOrgCloudToken: vi.fn() }));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", () => ({ assertCloudCanSpend: h.spend }));
vi.mock("@repo/adapters", async (original) => ({
  ...await original<typeof import("@repo/adapters")>(),
  Oblien: class {
    constructor(credentials: unknown) { h.credentials.push(credentials); }
    workspaces = { create: h.create, retryCreation: h.retry, get: h.get, list: h.list };
    workspace = () => ({ get: h.get, start: h.start, resume: h.resume,
      lifecycle: { makePermanent: h.permanent }, resources: { update: h.resize },
      runtime: async () => ({ exec: { run: h.exec } }), invalidateRuntime: h.invalidate });
  },
  waitForCloudDockerWorkspace: h.wait,
  CloudWorkspaceExecutor: class {
    exec = h.exec;
    dispose = h.dispose;
    runWithAbortSignal(signal: AbortSignal, run: () => Promise<unknown>) { signal.throwIfAborted(); return run(); }
  },
}));

import { cloudDockerNeedsBuild, reconcileCloudDockerWorkspace, runningDockerAllocation, cloudDockerResources, cloudDockerWorkspaceForCleanup, ensureCloudDockerWorkspace, usesCloudDockerWorkspace } from "@repo/platform/engine/lib/cloud-docker-workspace";

const project = { id: "project-a", organizationId: "org-a", activeDeploymentId: null, cloudWorkspaceId: null } as Project;
const resources = { cpuCores: 2, memoryMb: 4096, diskMb: 32768 };
const input = { projectId: project.id, organizationId: project.organizationId, resources };
let binding: Record<string, any> | undefined;
beforeEach(() => {
  vi.resetAllMocks(); h.credentials.length = 0; binding = undefined;
  h.owner.mockResolvedValue(project);
  h.token.mockResolvedValue({ token: "short-lived-tenant-token", namespace: "namespace-a" });
  h.find.mockImplementation(async () => binding);
  h.reserve.mockImplementation(async (value) => binding ??= { ...value, provisionKey: "stable-key", workspaceId: null, state: "provisioning" });
  h.attach.mockImplementation(async (_p, _o, _n, id) => { binding!.workspaceId = id; });
  h.ready.mockImplementation(async () => { binding!.state = "ready"; });
  h.create.mockResolvedValue({ id: "workspace-a", namespace: "namespace-a", status: "creating" });
  h.retry.mockResolvedValue({ id: "workspace-a", namespace: "namespace-a", status: "creating" });
  h.get.mockResolvedValue({
    id: "workspace-a",
    namespace: "namespace-a",
    slug: `os-docker-${createHash("sha256").update(project.id).digest("hex").slice(0, 24)}`,
    status: "active",
    info: { status: "running" },
    resources: { cpus: 2, memory_mb: 4096, disk_size_mb: 32768 },
  });
  h.wait.mockImplementation(async () => h.get());
  h.exec.mockResolvedValue("");
  h.resize.mockResolvedValue({ success: true, relaunched: true });
  h.inFlight.mockResolvedValue([]);
  h.list.mockResolvedValue({ workspaces: [], total: 0, limit: 100, page: 1 });
  h.discard.mockImplementation(async () => {
    binding = undefined;
  });
});

describe("Cloud Docker provisioning and retry", () => {
  it("uses namespace credentials and stores provider identity before readiness", async () => {
    h.wait.mockImplementation(async () => {
      expect(binding?.workspaceId).toBe("workspace-a");
      expect(h.permanent).not.toHaveBeenCalled();
      return h.get();
    });
    expect(await ensureCloudDockerWorkspace(input)).toEqual({ projectId: "project-a", workspaceId: "workspace-a" });
    expect(h.credentials).toEqual([{ token: "short-lived-tenant-token", baseUrl: "https://staging.oblien.test" }]);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ namespace: "namespace-a", image: "oblien/docker:29", wait_ready: false, idempotency_key: "stable-key" }));
    expect(binding?.state).toBe("ready");
    expect(h.permanent).toHaveBeenCalledOnce();
  });
  it("deduplicates simultaneous first deployments through the project lock", async () => {
    const result = await Promise.all([ensureCloudDockerWorkspace(input), ensureCloudDockerWorkspace(input)]);
    expect(result[0]).toEqual(result[1]);
    expect(h.create).toHaveBeenCalledOnce();
  });
  it("replays the identical creation request after an uncertain POST, even if desired resources change", async () => {
    h.create.mockRejectedValueOnce(new Error("connection lost after POST"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("connection lost");
    expect(binding?.workspaceId).toBeNull();
    await ensureCloudDockerWorkspace({ ...input, resources: { ...resources, memoryMb: 8192 } });
    expect(h.create.mock.calls[1]![0]).toEqual(h.create.mock.calls[0]![0]);
    expect(h.resize).toHaveBeenCalledWith(expect.objectContaining({ memory_mb: 8192 }));
  });
  it("retains the binding on readiness failure and reconnects without creating another disk", async () => {
    h.wait.mockRejectedValueOnce(new Error("still starting"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("still starting");
    expect(binding?.workspaceId).toBe("workspace-a");
    expect(binding?.state).toBe("provisioning");
    await ensureCloudDockerWorkspace(input);
    expect(h.create).toHaveBeenCalledOnce();
  });
  it("retries failed initial provisioning on the same workspace when the deployment is retried", async () => {
    h.wait.mockRejectedValueOnce(new Error("provider boot failed"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("provider boot failed");
    h.get.mockResolvedValueOnce({ id: "workspace-a", namespace: "namespace-a", status: "error", provisioning: { state: "failed" } });
    await expect(ensureCloudDockerWorkspace(input)).resolves.toEqual({ projectId: "project-a", workspaceId: "workspace-a" });
    expect(h.retry).toHaveBeenCalledExactlyOnceWith("workspace-a");
    expect(h.create).toHaveBeenCalledOnce();
    expect(binding?.state).toBe("ready");
  });
  it("does not retry creation for a previously ready workspace with customer data", async () => {
    await ensureCloudDockerWorkspace(input);
    h.get.mockResolvedValue({ id: "workspace-a", namespace: "namespace-a", status: "error", provisioning: { state: "failed" } });
    h.wait.mockRejectedValue(new Error("provider boot failed"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("provider boot failed");
    expect(h.retry).not.toHaveBeenCalled();
    expect(h.create).toHaveBeenCalledOnce();
  });
  it("verifies the workspace returned from a provisioning retry", async () => {
    h.wait.mockRejectedValueOnce(new Error("provider boot failed"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("provider boot failed");
    h.get.mockResolvedValueOnce({ id: "workspace-a", namespace: "namespace-a", status: "error", provisioning: { state: "failed" } });
    h.retry.mockResolvedValue({ id: "workspace-other", namespace: "namespace-other" });
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("unexpected workspace");
    expect(binding?.workspaceId).toBe("workspace-a");
    expect(binding?.state).toBe("provisioning");
  });
  it("discards an empty reservation only after a definitive provider rejection", async () => {
    h.create.mockRejectedValueOnce(Object.assign(new Error("resource allowance exceeded"), { status: 403 }));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("resource allowance");
    expect(h.discard).toHaveBeenCalledWith(project.id, project.organizationId, "stable-key");
    expect(binding).toBeUndefined();
  });
  it("can retry a smaller allocation after a definitive namespace capacity rejection", async () => {
    const oversized = { ...input, resources: { ...resources, cpuCores: 5 } };
    h.create.mockImplementation(async (request) => {
      if (request.config.cpus > 4) {
        throw Object.assign(new Error("namespace permits 4 vCPU"), {
          status: 409,
          code: "NAMESPACE_LIMIT_REACHED",
        });
      }
      return { id: "workspace-a", namespace: "namespace-a" };
    });
    await expect(ensureCloudDockerWorkspace(oversized)).rejects.toMatchObject({
      code: "NAMESPACE_LIMIT_REACHED",
    });
    await expect(ensureCloudDockerWorkspace(input)).resolves.toEqual({
      projectId: "project-a",
      workspaceId: "workspace-a",
    });
    expect(h.create.mock.calls.map(([request]) => request.config.cpus)).toEqual([5, 2]);
    expect(binding?.state).toBe("ready");
  });
  it("does not replace an old request when an empty lookup cannot rule out earlier provisioning", async () => {
    binding = { ...input, namespace: "namespace-a", resources: { ...resources, cpuCores: 5 },
      provisionKey: "legacy-key", workspaceId: null, state: "provisioning" };
    h.create.mockImplementation(async (request) => {
      if (request.config.cpus > 4) {
        throw Object.assign(new Error("namespace permits 4 vCPU"), {
          status: 409, code: "NAMESPACE_LIMIT_REACHED",
        });
      }
      return { id: "workspace-a", namespace: "namespace-a" };
    });
    await expect(ensureCloudDockerWorkspace({ ...input, resources: { ...resources, cpuCores: 4 } }))
      .rejects.toMatchObject({ code: "NAMESPACE_LIMIT_REACHED" });
    expect(h.create.mock.calls.map(([request]) => request.config.cpus)).toEqual([5]);
    expect(h.create.mock.calls.map(([request]) => request.idempotency_key)).toEqual(["legacy-key"]);
    expect(h.list).toHaveBeenCalled();
    expect(h.discard).not.toHaveBeenCalled();
    expect(binding?.state).toBe("provisioning");
  });
  it("adopts an earlier workspace discovered after a quota refusal instead of creating another", async () => {
    binding = { ...input, namespace: "namespace-a", provisionKey: "legacy-key", workspaceId: null, state: "provisioning" };
    h.create.mockRejectedValue(Object.assign(new Error("namespace workspace limit"), { status: 409, code: "NAMESPACE_LIMIT_REACHED" }));
    h.list.mockResolvedValue({ workspaces: [await h.get()], total: 1, limit: 100, page: 1 });
    await expect(ensureCloudDockerWorkspace(input)).resolves.toEqual({ projectId: project.id, workspaceId: "workspace-a" });
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
  });
  it("retains an old reservation when a quota refusal cannot be reconciled with provider state", async () => {
    binding = { ...input, namespace: "namespace-a", provisionKey: "legacy-key", workspaceId: null, state: "provisioning" };
    h.create.mockRejectedValue(Object.assign(new Error("namespace workspace limit"), { status: 409, code: "NAMESPACE_LIMIT_REACHED" }));
    h.list.mockRejectedValue(new Error("provider lookup unavailable"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("provider lookup unavailable");
    expect(binding?.provisionKey).toBe("legacy-key");
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
  });
  it("searches all pages and recovers only the workspace in this project's namespace", async () => {
    binding = { ...input, namespace: "namespace-a", provisionKey: "legacy-key", workspaceId: null, state: "provisioning" };
    h.create.mockRejectedValue(Object.assign(new Error("namespace workspace limit"), { status: 409, code: "NAMESPACE_LIMIT_REACHED" }));
    const workspace = await h.get();
    h.list.mockResolvedValueOnce({ workspaces: [{ ...workspace, namespace: "other-namespace", id: "foreign-vm" }], total: 2, limit: 1, page: 1 });
    h.list.mockResolvedValueOnce({ workspaces: [workspace], total: 2, limit: 1, page: 2 });
    await expect(ensureCloudDockerWorkspace(input)).resolves.toMatchObject({ workspaceId: "workspace-a" });
    expect(h.list).toHaveBeenNthCalledWith(2, { page: 2, limit: 100 });
    expect(h.attach).toHaveBeenCalledExactlyOnceWith(project.id, project.organizationId, "namespace-a", "workspace-a");
  });
  it("refuses an ambiguous provider identity instead of selecting one disk arbitrarily", async () => {
    binding = { ...input, namespace: "namespace-a", provisionKey: "legacy-key", workspaceId: null, state: "provisioning" };
    h.create.mockRejectedValue(Object.assign(new Error("namespace workspace limit"), { status: 409, code: "NAMESPACE_LIMIT_REACHED" }));
    const workspace = await h.get();
    h.list.mockResolvedValue({ workspaces: [workspace, { ...workspace, id: "duplicate-vm" }], total: 2, limit: 100, page: 1 });
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("Multiple Cloud workspaces");
    expect(h.attach).not.toHaveBeenCalled();
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
  });
  it.each([
    "NAMESPACE_LIMIT_REACHED",
    "SANDBOX_LIMIT_REACHED",
    "POOL_LIMIT_REACHED",
    "plan_limit_exceeded",
    "namespace_limit_exceeded",
  ])("leaves a rejected %s installation deletable without creating a workspace", async (code) => {
    const error = Object.assign(new Error("creation rejected"), { status: 409, code });
    h.create.mockRejectedValueOnce(error);
    await expect(ensureCloudDockerWorkspace(input)).rejects.toBe(error);
    expect(
      await cloudDockerWorkspaceForCleanup(project.id, project.organizationId),
    ).toBeUndefined();
    expect(binding).toBeUndefined();
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.start).not.toHaveBeenCalled();
  });
  it("keeps an unclassified conflict reserved instead of assuming no workspace exists", async () => {
    h.create.mockRejectedValueOnce(
      Object.assign(new Error("create already in progress"), {
        status: 409,
        code: "CREATE_IN_PROGRESS",
      }),
    );
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("already in progress");
    expect(binding?.provisionKey).toBe("stable-key");
    expect(h.discard).not.toHaveBeenCalled();
  });
  it("releases a new reservation if cancelled before the provider request", async () => {
    const controller = new AbortController();
    const reserve = h.reserve.getMockImplementation()!;
    h.reserve.mockImplementationOnce(async (...args) => {
      const result = await reserve(...args);
      controller.abort(new Error("install cancelled"));
      return result;
    });
    await expect(
      ensureCloudDockerWorkspace({ ...input, signal: controller.signal }),
    ).rejects.toThrow("install cancelled");
    expect(h.create).not.toHaveBeenCalled();
    expect(
      await cloudDockerWorkspaceForCleanup(project.id, project.organizationId),
    ).toBeUndefined();
  });
  it("preserves an earlier uncertain request when a retry is cancelled before sending", async () => {
    h.create.mockRejectedValueOnce(new Error("response lost"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("response lost");
    const controller = new AbortController();
    h.token.mockImplementationOnce(async () => {
      controller.abort(new Error("retry cancelled"));
      return { token: "short-lived-tenant-token", namespace: "namespace-a" };
    });
    await expect(
      ensureCloudDockerWorkspace({ ...input, signal: controller.signal }),
    ).rejects.toThrow("retry cancelled");
    expect(binding?.provisionKey).toBe("stable-key");
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.create).toHaveBeenCalledOnce();
  });
  it("tracks a failed creation's returned workspace so deletion can reclaim it", async () => {
    const error = Object.assign(new Error("initial provisioning failed"), {
      status: 422,
      code: "CREATE_FAILED",
      details: { workspace_id: "workspace-a" },
    });
    h.create.mockRejectedValueOnce(error);
    await expect(ensureCloudDockerWorkspace(input)).rejects.toBe(error);
    expect(await cloudDockerWorkspaceForCleanup(project.id, project.organizationId)).toMatchObject({
      workspaceId: "workspace-a",
      state: "provisioning",
    });
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.wait).not.toHaveBeenCalled();
  });
  it("does not release a previous uncertain request when its retry is rejected", async () => {
    h.create.mockRejectedValueOnce(new Error("response lost"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("response lost");
    h.create.mockRejectedValueOnce(Object.assign(new Error("token expired"), { status: 401 }));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("token expired");
    expect(binding?.provisionKey).toBe("stable-key");
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
  });
  it("keeps an unclassified provisioning failure reserved when no identity is returned", async () => {
    h.create.mockRejectedValueOnce(
      Object.assign(new Error("provisioning failed"), {
        status: 422,
        code: "CREATE_FAILED",
      }),
    );
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("provisioning failed");
    expect(binding?.provisionKey).toBe("stable-key");
    expect(h.discard).not.toHaveBeenCalled();
  });
  it.each([
    { namespace: "another-namespace" },
    { slug: "another-project" },
    { id: "another-workspace" },
  ])("never adopts a failed resource with mismatching ownership: %j", async (mismatch) => {
    h.create.mockRejectedValueOnce(
      Object.assign(new Error("creation failed"), {
        status: 422,
        details: { workspace_id: "workspace-a" },
      }),
    );
    const created = await h.get();
    h.get.mockResolvedValueOnce({ ...created, ...mismatch });
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("ownership");
    expect(binding?.workspaceId).toBeNull();
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.attach).not.toHaveBeenCalled();
  });
  it("applies a larger allocation and restores only previously running containers", async () => {
    await ensureCloudDockerWorkspace(input);
    h.exec.mockResolvedValueOnce("abcdef123456\r\n123456abcdef\r\n");
    await ensureCloudDockerWorkspace({ ...input, resources: { ...resources, memoryMb: 8192 } });
    expect(h.resize).toHaveBeenCalledWith({ cpus: 2, memory_mb: 8192, disk_size_mb: 32768, apply: true });
    expect(h.exec).toHaveBeenLastCalledWith("docker start 'abcdef123456' '123456abcdef'");
    expect(h.invalidate).toHaveBeenCalledOnce();
    expect(h.create).toHaveBeenCalledOnce();
  });
  it.each(["stopped", "paused"])("resumes an existing %s VM whose record is active", async state => {
    await ensureCloudDockerWorkspace(input);
    h.get.mockResolvedValue({ namespace: "namespace-a", status: "active", info: { status: state } });
    await ensureCloudDockerWorkspace(input);
    expect(state === "stopped" ? h.start : h.resume).toHaveBeenCalledOnce();
    expect(h.create).toHaveBeenCalledOnce();
  });
  it("finishes recovering services when a deployment is cancelled during a resize", async () => {
    await ensureCloudDockerWorkspace(input);
    const controller = new AbortController();
    h.exec.mockResolvedValueOnce("abcdef123456");
    h.resize.mockImplementation(async () => { controller.abort(); return { success: true, relaunched: true }; });
    await expect(ensureCloudDockerWorkspace({ ...input, resources: { ...resources, memoryMb: 8192 }, signal: controller.signal })).rejects.toThrow();
    expect(h.exec).toHaveBeenLastCalledWith("docker start 'abcdef123456'");
    expect(h.wait).toHaveBeenLastCalledWith(expect.anything(), "workspace-a", "namespace-a");
    expect(h.dispose).toHaveBeenCalledOnce();
  });
  it("restores running services after a resize response is lost and still reports the failure", async () => {
    await ensureCloudDockerWorkspace(input);
    h.exec.mockResolvedValueOnce("abcdef123456");
    h.resize.mockRejectedValue(new Error("response lost after resizing the VM"));
    await expect(ensureCloudDockerWorkspace({ ...input, resources: { ...resources, memoryMb: 8192 } }))
      .rejects.toThrow("response lost");
    expect(h.exec).toHaveBeenLastCalledWith("docker start 'abcdef123456'");
    expect(h.invalidate).toHaveBeenCalledOnce();
    expect(h.dispose).toHaveBeenCalledOnce();
  });
  it("recovers an interrupted create for deletion without starting or replacing it", async () => {
    h.create.mockRejectedValueOnce(new Error("response lost"));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("response lost");
    const create = h.create.mock.calls[0]![0];
    h.list.mockResolvedValue({ workspaces: [{ id: "recovered-vm", slug: create.slug, namespace: "namespace-a" }], total: 1, limit: 100, page: 1 });
    expect(await cloudDockerWorkspaceForCleanup(project.id, project.organizationId)).toMatchObject({ workspaceId: "recovered-vm" });
    expect(h.attach).toHaveBeenCalledWith(project.id, project.organizationId, "namespace-a", "recovered-vm", true);
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.start).not.toHaveBeenCalled();
    expect(h.spend).toHaveBeenCalledOnce();
  });
  it("keeps an unknown creation outcome visible when deletion cannot find its workspace", async () => {
    binding = { namespace: "namespace-a", workspaceId: null, provisionKey: "stable-key" };
    h.list.mockResolvedValue({ workspaces: [], total: 0, limit: 100, page: 1 });
    await expect(cloudDockerWorkspaceForCleanup(project.id, project.organizationId)).rejects.toThrow("not yet confirmed");
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it("records the workspace even when cancellation arrives during creation", async () => {
    const controller = new AbortController();
    h.create.mockImplementation(async () => { controller.abort(); return { id: "workspace-a", namespace: "namespace-a" }; });
    await expect(ensureCloudDockerWorkspace({ ...input, signal: controller.signal })).rejects.toThrow();
    expect(binding?.workspaceId).toBe("workspace-a");
    expect(h.permanent).not.toHaveBeenCalled();
  });
  it("does not replace a missing persisted workspace with an empty disk", async () => {
    binding = { ...input, namespace: "namespace-a", workspaceId: "workspace-missing", resources, provisionKey: "stable-key" };
    h.get.mockRejectedValue(Object.assign(new Error("workspace missing"), { status: 404 }));
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("workspace missing");
    expect(h.create).not.toHaveBeenCalled();
  });
  it("grows the recorded workspace for a service add without reserving or creating another host", async () => {
    await ensureCloudDockerWorkspace(input);
    h.reserve.mockClear(); h.create.mockClear();
    await ensureCloudDockerWorkspace({ ...input, existingWorkspaceId: "workspace-a",
      resources: { ...resources, cpuCores: 3, memoryMb: 6144 } });
    expect(h.resize).toHaveBeenCalledWith({ cpus: 3, memory_mb: 6144, disk_size_mb: 32768, apply: true });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(binding?.workspaceId).toBe("workspace-a");
  });
  it.each(["missing", "different"])("refuses a service add with a %s workspace binding before provider access", async state => {
    if (state === "different") binding = { namespace: "namespace-a", workspaceId: "another-workspace", resources };
    await expect(ensureCloudDockerWorkspace({ ...input, existingWorkspaceId: "workspace-a" }))
      .rejects.toMatchObject({ code: "CLOUD_WORKSPACE_NOT_FOUND" });
    expect(h.token).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.resize).not.toHaveBeenCalled();
  });
  it("refuses a service add when namespace ownership no longer matches", async () => {
    binding = { namespace: "another-namespace", workspaceId: "workspace-a", resources };
    await expect(ensureCloudDockerWorkspace({ ...input, existingWorkspaceId: "workspace-a" }))
      .rejects.toThrow("namespace binding");
    expect(h.get).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it("rejects wrong namespace ownership and blocks new spending before provisioning", async () => {
    h.create.mockResolvedValue({ id: "workspace-other", namespace: "namespace-other" });
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("unexpected workspace namespace");
    expect(h.attach).not.toHaveBeenCalled();
    h.spend.mockRejectedValue(new Error("out of credits"));
    h.create.mockClear();
    await expect(ensureCloudDockerWorkspace(input)).rejects.toThrow("out of credits");
    expect(h.create).not.toHaveBeenCalled();
  });
  it("keeps native cloud projects and independent single-app services on their existing model", async () => {
    expect(await usesCloudDockerWorkspace(project, "services")).toBe(true);
    expect(await usesCloudDockerWorkspace(project, "single")).toBe(false);
    expect(await usesCloudDockerWorkspace({ ...project, cloudWorkspaceId: "native-workspace" }, "services")).toBe(false);
    h.active.mockResolvedValue({ id: "old", projectId: project.id, organizationId: project.organizationId, meta: { deployTarget: "cloud" } });
    expect(await usesCloudDockerWorkspace({ ...project, activeDeploymentId: "old" }, "services")).toBe(false);
  });
  it("sizes one host for enabled services and build headroom", () => {
    expect(cloudDockerResources({ services: [{ resources: { cpuCores: 1, memoryMb: 3072, diskMb: 1024 } },
      { resources: { cpuCores: 1, memoryMb: 3072, diskMb: 1024 } }, { enabled: false, resources: { cpuCores: 100, memoryMb: 999999, diskMb: 999999 } }],
      reserveBuild: true, buildResources: { cpuCores: 2, memoryMb: 1024, diskMb: 4096 } })).toEqual({ cpuCores: 2, memoryMb: 7680, diskMb: 8192 });
  });
  it("uses a 1 GB image-only host instead of permanently reserving a source builder", () => {
    const services = [{ name: "vaultwarden", image: "vaultwarden/server:latest", enabled: true }];
    expect(cloudDockerNeedsBuild(services)).toBe(false);
    expect(cloudDockerResources({ services })).toEqual({ cpuCores: 1, memoryMb: 1024, diskMb: 8192 });
    expect(cloudDockerNeedsBuild([{ ...services[0]!, build: { context: "." } }])).toBe(true);
    expect(cloudDockerResources({ services, reserveBuild: true })).toEqual({ cpuCores: 1, memoryMb: 3072, diskMb: 8192 });
  });
  it("releases unused CPU/RAM after deployment, preserving disks and previously running services", async () => {
    await ensureCloudDockerWorkspace(input);
    h.exec.mockResolvedValueOnce("abcdef123456").mockResolvedValueOnce(JSON.stringify(["abcdef123456", project.id, 512 * 1048576, 500000000, 0, 0]))
      .mockResolvedValueOnce("abcdef123456");
    expect(await reconcileCloudDockerWorkspace({ ...input, workspaceId: "workspace-a", resources: { cpuCores: 1, memoryMb: 1024, diskMb: 8192 } })).toBe(true);
    expect(h.resize).toHaveBeenCalledExactlyOnceWith({ cpus: 1, memory_mb: 1024, disk_size_mb: 32768, apply: true });
    expect(h.exec).toHaveBeenLastCalledWith("docker start 'abcdef123456'");
    expect(h.create).toHaveBeenCalledOnce();
  });
  it("never reduces below the actual running containers even if desired settings are smaller", async () => {
    await ensureCloudDockerWorkspace(input);
    h.exec.mockResolvedValueOnce("abcdef123456").mockResolvedValueOnce(JSON.stringify(["abcdef123456", project.id, 3584 * 1048576, 2000000000, 0, 0]));
    expect(await reconcileCloudDockerWorkspace({ ...input, workspaceId: "workspace-a", resources: { cpuCores: 1, memoryMb: 1024, diskMb: 8192 } })).toBe(false);
    expect(h.resize).not.toHaveBeenCalled();
  });
  it.each(["foreign", "unbounded", "incomplete"])("refuses an unsafe %s container inspection before resizing", async kind => {
    await ensureCloudDockerWorkspace(input);
    h.exec.mockResolvedValueOnce("abcdef123456").mockResolvedValueOnce(kind === "incomplete" ? "" : JSON.stringify([
      "abcdef123456", kind === "foreign" ? "project-other" : project.id, kind === "unbounded" ? 0 : 512 * 1048576, 500000000, 0, 0]));
    await expect(reconcileCloudDockerWorkspace({ ...input, workspaceId: "workspace-a", resources: { cpuCores: 1, memoryMb: 1024, diskMb: 8192 } })).rejects.toThrow();
    expect(h.resize).not.toHaveBeenCalled();
  });
  it("leaves a stopped host and a different in-flight deployment untouched", async () => {
    await ensureCloudDockerWorkspace(input);
    h.inFlight.mockResolvedValueOnce([{ id: "another-deployment" }]);
    expect(await reconcileCloudDockerWorkspace({ ...input, workspaceId: "workspace-a", deploymentId: "this-deployment" })).toBe(false);
    h.get.mockResolvedValueOnce({ namespace: "namespace-a", info: { status: "stopped" }, resources: {} });
    expect(await reconcileCloudDockerWorkspace({ ...input, workspaceId: "workspace-a" })).toBe(false);
    expect(h.resize).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled();
  });
  it("checks namespace ownership before inspecting or resizing a host", async () => {
    await ensureCloudDockerWorkspace(input);
    h.get.mockResolvedValueOnce({ namespace: "namespace-other", info: { status: "running" } });
    await expect(reconcileCloudDockerWorkspace({ ...input, workspaceId: "workspace-a" })).rejects.toThrow("namespace changed");
    expect(h.exec).not.toHaveBeenCalled(); expect(h.resize).not.toHaveBeenCalled();
  });
  it("accepts fractional Docker CPU quotas without equating them to VM core counts", () => {
    expect(runningDockerAllocation(JSON.stringify(["abcdef123456", project.id, 512 * 1048576, 0, 25000, 100000]), project.id))
      .toEqual({ cpuCores: 1, memoryMb: 1024, diskMb: 8192 });
  });
  it.each(["500000000", null, true])("refuses a nonnumeric Docker CPU allocation (%s)", cpu => {
    expect(() => runningDockerAllocation(JSON.stringify(["abcdef123456", project.id, 512 * 1048576, cpu, 0, 0]), project.id))
      .toThrow("Cannot verify");
  });
  it("does not report a saved-but-unapplied resource change as ready", async () => {
    await ensureCloudDockerWorkspace(input);
    h.resize.mockResolvedValueOnce({ success: true, relaunched: false, pending_capacity_verification: true });
    await expect(ensureCloudDockerWorkspace({ ...input, resources: { ...resources, memoryMb: 8192 } })).rejects.toThrow("pending verification");
  });
});
