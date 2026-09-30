import { describe, expect, it, vi } from "vitest";
import { KubernetesApiError, type KubernetesApi } from "./kubernetes-api";
import { patchKubernetesObject } from "./kubernetes-mutation";

describe("Kubernetes optimistic mutations", () => {
  it("re-reads and revalidates after a controller changes resourceVersion", async () => {
    let version = 1;
    const request = vi.fn(async (method: string, _path: string, body?: any) => {
      if (method === "GET") return { metadata: { uid: "owned", resourceVersion: String(version) } };
      if (version++ === 1) throw new KubernetesApiError(409, "status changed");
      expect(body.metadata).toEqual({ uid: "owned", resourceVersion: "2" });
      return body;
    });
    const validate = vi.fn(() => ({ spec: { replicas: 3 } }));
    await patchKubernetesObject({ request } as unknown as KubernetesApi, "/resource", validate);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("does not replay an ambiguous request or overwrite a replacement resource", async () => {
    for (const replaced of [false, true]) {
      let reads = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "GET")
          return {
            metadata: { uid: ++reads === 1 ? "original" : "replacement", resourceVersion: "1" },
          };
        throw replaced ? new KubernetesApiError(409, "changed") : new Error("connection lost");
      });
      await expect(
        patchKubernetesObject({ request } as unknown as KubernetesApi, "/resource", () => ({
          spec: {},
        })),
      ).rejects.toThrow(replaced ? /replaced/ : /connection lost/);
      expect(request.mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(1);
    }
  });
});
