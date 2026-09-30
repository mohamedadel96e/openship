import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClusterStorageAdapter, longhornBase, managedStorageClass } from "./storage";
import { StorageProbe } from "./storage-probe";
import { downloadClusterAddon } from "./database-addons";
import { KubernetesApiError, type KubernetesApi, type KubernetesObject } from "./kubernetes-api";

vi.mock("./database-addons", async (original) => ({
  ...(await original<typeof import("./database-addons")>()),
  downloadClusterAddon: vi.fn(async () => []),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(StorageProbe.prototype, "cleanup").mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

function setup() {
  const shared = managedStorageClass("runtime", 2);
  shared.metadata.uid = "shared-class";
  const local: KubernetesObject = {
    kind: "StorageClass",
    metadata: {
      name: "openship-local",
      uid: "local-class",
      labels: { "openship.io/runtime": "runtime", "openship.io/addon": "local" },
    },
    provisioner: "rancher.io/local-path",
  };
  const custom: KubernetesObject = {
    kind: "StorageClass",
    metadata: {
      name: "custom-storage",
      uid: "custom-class",
      labels: { "openship.io/runtime": "runtime" },
    },
    provisioner: "example.test/driver",
  };
  const objects = new Map(
    [shared, local, custom].map((object) => [
      `/apis/storage.k8s.io/v1/storageclasses/${object.metadata.name}`,
      object,
    ]),
  );
  const request = vi.fn(async (method: string, path: string, body?: any) => {
    if (method === "GET") {
      if (path.startsWith("/apis/storage.k8s.io/v1/storageclasses?"))
        // Kubernetes list entries omit apiVersion/kind; the enclosing list
        // defines their type, unlike a singular resource GET.
        return {
          items: [shared, local, custom].map(({ apiVersion, kind, ...object }) => object),
        };
      if (path === "/api/v1/persistentvolumeclaims" || path === "/api/v1/persistentvolumes")
        return { items: [] };
      const found = objects.get(path);
      if (!found) throw new KubernetesApiError(404, "Missing");
      return found;
    }
    if (method === "DELETE") {
      expect(body.preconditions.uid).toBe(objects.get(path)?.metadata.uid);
      objects.delete(path);
      return {};
    }
    throw new Error("Unexpected storage mutation");
  });
  const api = { request } as unknown as KubernetesApi;
  const adapter = new ClusterStorageAdapter(
    api,
    "runtime",
    {
      replicas: 2,
      disks: [
        { serverId: "one", path: "/var/lib/openship/storage", reservedGiB: 1 },
        { serverId: "two", path: "/var/lib/openship/storage", reservedGiB: 1 },
      ],
    },
    [],
    AbortSignal.timeout(5000),
    async () => {},
  );
  return { adapter, request, objects };
}

describe("shared-storage cleanup boundaries", () => {
  it("finishes interrupted cleanup while preserving local database and custom storage classes", async () => {
    const { adapter, request, objects } = setup();
    await adapter.remove(async () => {});
    expect([...objects.values()].map((object) => object.metadata.name)).toEqual([
      "openship-local",
      "custom-storage",
    ]);
    expect(request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
  });
  it("refuses to uninstall while a retained data disk still uses shared storage", async () => {
    const { adapter, request } = setup();
    const actual = request.getMockImplementation()!;
    request.mockImplementation((method, path, body) =>
      path === "/api/v1/persistentvolumes"
        ? Promise.resolve({
            items: [
              {
                metadata: { name: "retained-disk", uid: "retained-disk-uid" },
                spec: { csi: { driver: "driver.longhorn.io" } },
              },
            ],
          })
        : actual(method, path, body),
    );
    await expect(adapter.remove(async () => {})).rejects.toThrow(/retained volumes/);
    expect(downloadClusterAddon).not.toHaveBeenCalled();
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("keeps an unrelated storage installation untouched", async () => {
    const { adapter, objects, request } = setup();
    objects.set("/api/v1/namespaces/longhorn-system", {
      kind: "Namespace",
      metadata: { name: "longhorn-system", labels: { "openship.io/runtime": "another-runtime" } },
    });
    objects.set(`${longhornBase}/volumes`, { metadata: {}, items: [] });
    await expect(adapter.remove(async () => {})).rejects.toThrow(/ownership/);
    expect(StorageProbe.prototype.cleanup).not.toHaveBeenCalled();
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
});
