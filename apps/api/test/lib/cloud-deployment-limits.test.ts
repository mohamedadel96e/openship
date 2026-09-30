import { beforeEach, describe, expect, it, vi } from "vitest";
import { planLimits, resolvePlan, type PlanTierId } from "@repo/core";
const h = vi.hoisted(() => ({ cloud: true, tier: "starter", count: vi.fn(), usage: vi.fn(), sync: vi.fn() }));
vi.mock("@repo/platform/engine/config/env", () => ({ env: { get CLOUD_MODE() { return h.cloud; } } }));
vi.mock("@repo/db", () => ({ repos: {
  organization: { findById: async () => ({ oblienNamespace: "tenant-a", planTierId: h.tier, createdAt: new Date("2026-01-01") }) },
  service: { countRunningForOrg: h.count }, deployment: { sumBuildMillisForOrg: h.usage },
} }));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", () => ({ syncOblienEntitlement: h.sync }));
import { assertCloudDeploymentLimits, assertRunningServiceQuota, assertBuildMinutesAvailable } from "@repo/platform/engine/lib/plan-guard";
import { resolveCloudServiceResources } from "@repo/platform/engine/lib/resources";
beforeEach(() => {
  vi.resetAllMocks(); h.cloud = true; h.tier = "starter";
  h.sync.mockImplementation(async () => ({
    tier: h.tier,
    limits: planLimits(h.tier as PlanTierId),
    resourceLimits: resolvePlan(h.tier as PlanTierId).oblienLimits,
  }));
  h.count.mockResolvedValue(0);
  h.usage.mockResolvedValue(0);
});
const base = { cpuCores: 1, memoryMb: 1024, diskMb: 8192 };
const services = () => [{ enabled: true }, { enabled: true }, { enabled: true }];
describe("Cloud deploy and update resource gates", () => {
  it("includes the combined Docker workspace allocation, even when each service fits", async () => {
    h.tier = "team";
    const stack = Array.from({ length: 5 }, (_, index) => ({
      name: `svc-${index}`,
      image: "redis:8",
      advanced: { resources: base },
    }));
    await expect(
      assertCloudDeploymentLimits("org-a", { services: stack }),
    ).resolves.toBeUndefined();
    await expect(
      assertCloudDeploymentLimits("org-a", { dockerWorkspace: true, services: stack }),
    ).rejects.toMatchObject({
      statusCode: 402,
      code: "PLAN_UPGRADE_REQUIRED",
      reason: "workspace-capacity",
    });
    await expect(
      assertCloudDeploymentLimits("org-a", {
        dockerWorkspace: true,
        services: [...stack.slice(0, 4), { ...stack[4], enabled: false }],
      }),
    ).resolves.toBeUndefined();
  });
  it.each([
    { resources: { ...base, memoryMb: 7168 }, count: 2, build: undefined },
    { resources: { ...base, diskMb: 81920 }, count: 1, build: undefined },
    { resources: { ...base, memoryMb: 8192 }, count: 1, build: "." },
  ])(
    "checks workspace RAM, disk and temporary build capacity: %j",
    async ({ resources, count, build }) => {
      h.tier = "team";
      await expect(
        assertCloudDeploymentLimits("org-a", {
          dockerWorkspace: true,
          buildResources: { cpuCores: 2, memoryMb: 8192, diskMb: 16384 },
          services: Array.from({ length: count }, () => ({
            image: "example/app:1",
            build,
            advanced: { resources },
          })),
        }),
      ).rejects.toMatchObject({ reason: "workspace-capacity" });
    },
  );
  it("uses the purchased workspace limit rather than hardcoding four CPUs", async () => {
    h.sync.mockResolvedValue({
      tier: "team",
      limits: planLimits("team"),
      resourceLimits: { ...resolvePlan("team").oblienLimits, max_vcpus: 6 },
    });
    await expect(
      assertCloudDeploymentLimits("org-a", {
        dockerWorkspace: true,
        services: Array.from({ length: 5 }, () => ({
          image: "redis:8",
          advanced: { resources: base },
        })),
      }),
    ).resolves.toBeUndefined();
  });
  it("counts a not-yet-created app in addition to the organization's existing services", async () => {
    h.count.mockResolvedValue(2);
    await expect(
      assertCloudDeploymentLimits("org-a", {
        services: [{ image: "redis:8" }, { image: "redis:8" }],
      }),
    ).rejects.toMatchObject({ reason: "running-services" });
  });
  it("redeploys an existing stack at its allowance without charging service slots twice", async () => {
    h.count.mockResolvedValue(3);
    await expect(
      assertCloudDeploymentLimits("org-a", {
        projectId: "existing",
        resources: base,
        services: services(),
      }),
    ).resolves.toBeUndefined();
  });
  it("checks saved project sizes even when no resource picker value is sent", async () => {
    h.count.mockResolvedValue(0);
    await expect(assertCloudDeploymentLimits("org-a", { runsApplication: true, resources: { ...base, cpuCores: 4 } }))
      .rejects.toMatchObject({ reason: "resource-tier" });
  });
  it("checks individual Compose limits instead of only checking their project default", async () => {
    await expect(assertCloudDeploymentLimits("org-a", { resources: base, services: [{ advanced: { resources: { memoryMb: 8192 } } }] }))
      .rejects.toMatchObject({ reason: "resource-tier" });
  });
  it("inherits partial service settings field by field", async () => {
    expect(resolveCloudServiceResources({ memoryMb: 512 }, base)).toEqual({ ...base, memoryMb: 512 });
    await expect(assertCloudDeploymentLimits("org-a", { resources: { ...base, cpuCores: 4 }, services: [{ advanced: { resources: { memoryMb: 512 } } }] }))
      .rejects.toMatchObject({ reason: "resource-tier" });
  });
  it("turns self-hosted unlimited settings into concrete Cloud limits", () => {
    const result = resolveCloudServiceResources({ cpuCores: 0, memoryMb: 0 }, base);
    expect(result.cpuCores).toBeGreaterThan(0); expect(result.memoryMb).toBeGreaterThan(0);
  });
  it("ignores disabled service definitions", async () => {
    await expect(assertCloudDeploymentLimits("org-a", { resources: base, services: [...services(), { enabled: false, advanced: { resources: { cpuCores: 100 } } }] }))
      .resolves.toBeUndefined();
  });
  it("rejects a large imported or frozen stack before its definitions are persisted", async () => {
    h.count.mockResolvedValue(0);
    await expect(assertCloudDeploymentLimits("org-a", { services: [...services(), { enabled: true }] }))
      .rejects.toMatchObject({ reason: "running-services" });
  });
  it("includes other projects when enforcing the customer's allowance", async () => {
    h.count.mockResolvedValue(4);
    await expect(assertCloudDeploymentLimits("org-a", { services: services() })).rejects.toMatchObject({ reason: "running-services" });
  });
  it("reserves a native application's slot alongside the organization's other services", async () => {
    h.count.mockResolvedValue(3);
    await expect(
      assertCloudDeploymentLimits("org-a", {
        projectId: "native-a",
        runsApplication: true,
        resources: base,
      }),
    ).rejects.toMatchObject({ reason: "running-services" });
    expect(h.count).toHaveBeenCalledWith("org-a", [], "native-a");
    h.count.mockResolvedValue(2);
    await expect(assertCloudDeploymentLimits("org-a", { projectId: "native-a", runsApplication: true, resources: base }))
      .resolves.toBeUndefined();
  });
  it("checks the new provider tier after a downgrade", async () => {
    h.tier = "free";
    await expect(assertCloudDeploymentLimits("org-a", { services: services() })).rejects.toMatchObject({ reason: "static-only" });
  });
  it("rejects oversized build allocations", async () => {
    await expect(assertCloudDeploymentLimits("org-a", { buildResources: { cpuCores: 16, memoryMb: 32768, diskMb: 32768 } }))
      .rejects.toMatchObject({ reason: "resource-tier" });
  });
  it("does not reserve or reject an unused build size for an image-only deployment", async () => {
    const imageOnly = [{ enabled: true, image: "vaultwarden/server:latest" }];
    await expect(assertCloudDeploymentLimits("org-a", { services: imageOnly,
      buildResources: { cpuCores: 4, memoryMb: 8192, diskMb: 32768 } })).resolves.toBeUndefined();
  });
  it.each([{ services: [] }, { services: [{ enabled: true, image: "redis:8" }] }])("still validates source builds for native applications with services $services", async ({ services }) => {
    h.count.mockResolvedValue(0);
    await expect(assertCloudDeploymentLimits("org-a", { nativeApplication: true, runsApplication: true, services,
      buildResources: { cpuCores: 4, memoryMb: 8192, diskMb: 32768 } })).rejects.toMatchObject({ reason: "resource-tier" });
  });
  it("uses the paid offer's saved build ceiling when the current catalog differs", async () => {
    h.sync.mockResolvedValue({ tier: "pro", limits: planLimits("pro"),
      resourceLimits: { ...resolvePlan("pro").oblienLimits, max_vcpus: 3, max_ram_mb: 8192 } });
    await expect(assertCloudDeploymentLimits("org-a", {
      buildResources: { cpuCores: 3, memoryMb: 8192, diskMb: 8192 } })).resolves.toBeUndefined();
    await expect(assertCloudDeploymentLimits("org-a", {
      buildResources: { cpuCores: 4, memoryMb: 8192, diskMb: 8192 } })).rejects.toMatchObject({ reason: "resource-tier" });
  });
  it("cannot turn an unavailable service count into additional capacity", async () => {
    h.count.mockRejectedValue(new Error("database unavailable"));
    await expect(assertCloudDeploymentLimits("org-a", { services: services() })).rejects.toThrow("database unavailable");
    await expect(assertRunningServiceQuota("org-a")).rejects.toThrow("database unavailable");
  });
  it("cannot turn an unavailable build meter into a new allowance", async () => {
    h.sync.mockResolvedValue({ tier: "starter", limits: { ...planLimits("starter"), buildMinutesPerMonth: 3000 },
      resourceLimits: resolvePlan("starter").oblienLimits });
    h.usage.mockRejectedValue(new Error("usage unavailable"));
    await expect(assertBuildMinutesAvailable("org-a")).rejects.toThrow("usage unavailable");
  });
  it("does not apply Cloud quotas to self-hosted workloads", async () => {
    h.cloud = false;
    await assertCloudDeploymentLimits("org-a", { resources: { ...base, cpuCores: 128 }, services: services() });
    expect(h.count).not.toHaveBeenCalled(); expect(h.sync).not.toHaveBeenCalled();
  });
});
