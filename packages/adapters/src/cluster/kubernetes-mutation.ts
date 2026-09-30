import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "@repo/core";
import { KubernetesApiError, type KubernetesApi, type KubernetesObject } from "./kubernetes-api";

/** Re-read after an explicit resource-version conflict. Never replay a mutation
 * after an ambiguous transport failure, or touch a replacement object. Callers
 * check ownership and their operation fence on every attempt. */
export async function patchKubernetesObject(
  api: KubernetesApi,
  path: string,
  update: (current: KubernetesObject) => Record<string, unknown> | Promise<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<KubernetesObject> {
  let uid: string | undefined;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const current = await api.request("GET", path, undefined, signal);
    if (
      !current.metadata.uid ||
      !current.metadata.resourceVersion ||
      current.metadata.deletionTimestamp
    )
      throw new AppError(
        "The Kubernetes resource is unavailable or being deleted.",
        409,
        "CLUSTER_RESOURCE_CHANGED",
      );
    if (uid && current.metadata.uid !== uid)
      throw new AppError(
        "The Kubernetes resource was replaced while applying the change.",
        409,
        "CLUSTER_RESOURCE_CHANGED",
      );
    uid = current.metadata.uid;
    const patch = await update(current);
    try {
      return await api.request(
        "PATCH",
        path,
        {
          ...patch,
          metadata: {
            ...(patch.metadata as Record<string, unknown> | undefined),
            uid,
            resourceVersion: current.metadata.resourceVersion,
          },
        },
        signal,
      );
    } catch (error) {
      if (!(error instanceof KubernetesApiError) || error.statusCode !== 409 || attempt >= 4)
        throw error;
      await delay(25 * (attempt + 1), undefined, { signal });
    }
  }
}
