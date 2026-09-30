import { AppError, resolvePlan, type PlanTierId } from "@repo/core";
import { getOblienClient } from "./oblien-client";
import { z } from "zod";

type NamespaceLimits = ReturnType<typeof cloudNamespaceLimits>;

/** Customer policy is explicit in the catalog. Oblien resolves current usage,
 * enforces aggregate allocation atomically and meters the credit balance. */
export function cloudNamespaceLimits(tier: PlanTierId) {
  return { ...resolvePlan(tier).oblienLimits };
}

export async function initialCloudNamespaceLimits(): Promise<NamespaceLimits> {
  return cloudNamespaceLimits("free");
}

/** Submit the verified subscription's declared policy under the billing lock.
 * The provider also enforces the saved paid contract before any client sync.
 * This updates no credits, usage or balance. Retail plans declare finite VM
 * and total caps; stricter saved caps are sent unchanged, including on renewal. */
export async function syncCloudResourceLimits(
  namespace: string,
  tier: PlanTierId,
  desired: NamespaceLimits = cloudNamespaceLimits(tier),
): Promise<void> {
  const client = getOblienClient();
  const { data: current } = await client.namespaces.get(namespace);
  if (current.slug !== namespace) throw new AppError("Cloud namespace ownership changed", 502, "CLOUD_NAMESPACE_MISMATCH");
  // Compare declared policy, never Oblien's effective_resource_limits: account
  // capacity may change without changing the customer's purchase contract.
  const matches = (limits: Partial<NamespaceLimits> | null | undefined) =>
    (Object.keys(desired) as Array<keyof NamespaceLimits>).every(key => (limits?.[key] ?? null) === desired[key]);
  if (matches(current.resource_limits)) return;
  const { data: updated } = await client.namespaces.update(current.id, { resource_limits: { ...desired } });
  if (updated.slug !== namespace || !matches(updated.resource_limits)) {
    throw new AppError("Cloud resource limits were not confirmed", 502, "CLOUD_RESOURCE_LIMITS_UNCONFIRMED");
  }
}

const capacityResponse = z.object({ success: z.literal(true), data: z.object({
  slug: z.string(),
  effective_resource_limits: z.object({ max_workspaces: z.number().nonnegative().nullable(),
    max_total_vcpus: z.number().nonnegative().nullable(), max_total_ram_mb: z.number().nonnegative().nullable(),
    max_total_disk_gb: z.number().nonnegative().nullable() }).optional(),
  allocated_resource_usage: z.object({ workspaces: z.number().nonnegative(), vcpus: z.number().nonnegative(),
    ram_mb: z.number().nonnegative(), disk_gb: z.number().nonnegative(), pending_updates: z.number().int().nonnegative() }).optional(),
}) });

/** Read actual reserved capacity from Oblien. Openship never reconstructs this
 * from service counts, cached VM rows or the customer's credit balance. */
export async function readCloudCapacity(namespace: string) {
  const { data } = capacityResponse.parse(await getOblienClient().namespaces.get(namespace));
  if (data.slug !== namespace) throw new AppError("Cloud namespace ownership changed", 502, "CLOUD_NAMESPACE_MISMATCH");
  const limits = data.effective_resource_limits, used = data.allocated_resource_usage;
  if (!limits || !used) return {};
  return {
    workspaces: { used: used.workspaces, max: limits.max_workspaces },
    vcpus: { used: used.vcpus, max: limits.max_total_vcpus },
    ramMb: { used: used.ram_mb, max: limits.max_total_ram_mb },
    diskGb: { used: used.disk_gb, max: limits.max_total_disk_gb },
  };
}
