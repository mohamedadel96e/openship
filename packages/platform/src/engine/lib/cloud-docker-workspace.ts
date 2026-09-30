import { createHash } from "node:crypto";
import {
  CLOUD_DOCKER_IMAGE,
  CloudWorkspaceExecutor,
  Oblien,
  cloudWorkspaceCreationFailure,
  cloudWorkspaceStatus,
  sq,
  waitForCloudDockerWorkspace,
  type ResourceConfig,
} from "@repo/adapters";
import { repos, type Project } from "@repo/db";
import { AppError, deploymentBelongsToProject } from "@repo/core";
import { env } from "../config/env";
import { issueNamespaceToken } from "./openship-cloud";
import { getOrgCloudToken } from "./cloud/client";
import { createProvisionLock } from "./provision-lock";
import { assertCloudCanSpend } from "../modules/billing/billing-oblien-quota";
import type { DeploymentMeta } from "./deployment-runtime";
import { withProjectRuntimeLock } from "./project-runtime-lock";

function workspaceSlug(projectId: string): string {
  return `os-docker-${createHash("sha256").update(projectId).digest("hex").slice(0, 24)}`;
}

/** Recover provider identity by the exact project slug within its namespace.
 * A negative lookup cannot rule out an earlier POST still in progress. */
async function findProjectWorkspace(client: Oblien, projectId: string, namespace: string) {
  let found: Awaited<ReturnType<typeof client.workspaces.get>> | undefined;
  for (let page = 1; ; page++) {
    const result = await client.workspaces.list({ page, limit: 100 });
    const matches = result.workspaces.filter(
      item => item.slug === workspaceSlug(projectId) && item.namespace === namespace,
    );
    for (const workspace of matches) {
      if (found && found.id !== workspace.id)
        throw new Error("Multiple Cloud workspaces match this project. Contact support@openship.io to verify its workspace before retrying.");
      found = workspace;
    }
    if (!result.workspaces.length || page * result.limit >= result.total) return found;
  }
}

/** Reconcile an interrupted create before teardown. This only reads provider
 * state; it never provisions or starts a workspace in order to delete it. */
export async function cloudDockerWorkspaceForCleanup(projectId: string, organizationId: string) {
  return createProvisionLock(`cloud:docker-project:${projectId}`).run(async () => {
    const binding = await repos.cloudDockerWorkspace.find(projectId, organizationId);
    if (!binding || binding.workspaceId) return binding;
    const credentials = env.CLOUD_MODE ? await issueNamespaceToken(organizationId) : await getOrgCloudToken(organizationId);
    if (!credentials || credentials.namespace !== binding.namespace) throw new Error("Cannot verify the project's cloud namespace for cleanup");
    const client = new Oblien({ token: credentials.token, baseUrl: env.OBLIEN_API_URL });
    const workspace = await findProjectWorkspace(client, projectId, binding.namespace);
    if (workspace) {
      await repos.cloudDockerWorkspace.attach(projectId, organizationId, binding.namespace, workspace.id, true);
      return { ...binding, workspaceId: workspace.id };
    }
    throw new Error(
      `Cloud Docker provisioning is not yet confirmed. Retry deletion; if it keeps failing, contact support@openship.io with project ${projectId}.`,
    );
  });
}

/** Existing native cloud projects need an explicit data migration. Added services
 * on a single-app project retain their own native workspaces. */
export async function usesCloudDockerWorkspace(project: Project, mode?: "single" | "services"): Promise<boolean> {
  const binding = await repos.cloudDockerWorkspace.find(project.id, project.organizationId);
  if (binding) return true;
  if (mode === "single" || project.cloudWorkspaceId) return false;
  if (project.activeDeploymentId) {
    const active = await repos.deployment.findById(project.activeDeploymentId);
    if (active && !deploymentBelongsToProject(project, active)) throw new Error("Active deployment belongs to a different project");
    if (active && ((active.meta as DeploymentMeta | null)?.deployTarget === "cloud" ||
        (env.CLOUD_MODE && !(active.meta as DeploymentMeta | null)?.deployTarget))) return false;
  }
  return true;
}

export { cloudDockerNeedsBuild, cloudDockerResources } from "./resources";

/** Only selected, non-secret inspect fields enter this parser. Unknown or
 * unbounded containers forbid automatic downsizing. Never guess their needs. */
export function runningDockerAllocation(output: string, projectId: string): ResourceConfig {
  let cpu = 0, memory = 0;
  for (const line of output.trim().split(/\r?\n/).filter(Boolean)) {
    const row: unknown = JSON.parse(line);
    if (!Array.isArray(row) || row.length !== 6 || row[1] !== projectId || typeof row[0] !== "string" || !/^[a-f0-9]{12,64}$/.test(row[0])) {
      throw new Error("Cannot safely reduce a Cloud workspace with an unverified container");
    }
    const [, , bytes, nanoCpu, quota, period] = row;
    if (![bytes, nanoCpu, quota, period].every(Number.isSafeInteger)) {
      throw new Error("Cannot verify the running container's resource allocation");
    }
    const cores = nanoCpu > 0 ? nanoCpu / 1e9 : (quota > 0 && period > 0 ? quota / period : 0);
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || !Number.isFinite(cores) || cores <= 0) {
      throw new Error("Set explicit container CPU and memory limits before reducing this Cloud workspace");
    }
    cpu += cores; memory += bytes / 1048576;
  }
  return { cpuCores: Math.max(1, Math.ceil(cpu)), memoryMb: Math.max(1024, Math.ceil((memory + 512) / 256) * 256), diskMb: 8192 };
}

async function resizeDockerWorkspace(input: {
  client: Oblien; workspaceId: string; namespace: string; projectId: string;
  resources: ResourceConfig; signal?: AbortSignal; onProgress?: (message: string) => void;
}) {
  const ws = input.client.workspace(input.workspaceId);
  const executor = new CloudWorkspaceExecutor(() => ws.runtime());
  try {
    const inspect = () => executor.exec(`docker ps --filter ${sq(`label=openship.project=${input.projectId}`)} --filter status=running --format '{{.ID}}'`, { timeout: 30_000 });
    const previous = await (input.signal ? executor.runWithAbortSignal(input.signal, inspect) : inspect());
    const running = previous.trim().split(/\s+/).filter(Boolean);
    if (running.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw new Error("Invalid container identity during Cloud workspace resizing");
    input.signal?.throwIfAborted();
    let failure: { error: unknown } | undefined;
    try {
      const result = await ws.resources.update({ cpus: input.resources.cpuCores, memory_mb: input.resources.memoryMb,
        disk_size_mb: input.resources.diskMb, apply: true });
      if (result.success === false || result.relaunched === false || result.pending_capacity_verification) {
        throw new Error("The Cloud resource change is still pending verification; retry once the provider confirms it");
      }
    } catch (error) { failure = { error }; }
    // Finish restoration even after cancellation or a lost provider response.
    try {
      await waitForCloudDockerWorkspace(input.client, input.workspaceId, input.namespace);
      ws.invalidateRuntime();
      if (running.length) await executor.exec(`docker start ${running.map(sq).join(" ")}`);
    } catch (error) {
      throw new AggregateError(failure ? [failure.error, error] : [error],
        "Could not restore running services after resizing the Cloud workspace. Check the workspace before retrying.", { cause: error });
    }
    if (failure) throw failure.error;
    input.signal?.throwIfAborted();
  } finally { await executor.dispose(); }
}

/** Release temporary CPU/RAM on an existing, running project host. The caller
 * holds deployment admission for this project; the provider serializes actual
 * namespace capacity. Disks, stopped services and other projects are preserved. */
export async function reconcileCloudDockerWorkspace(input: {
  projectId: string; organizationId: string; workspaceId: string; resources: ResourceConfig;
  deploymentId?: string; onProgress?: (message: string) => void;
}): Promise<boolean> {
  return withProjectRuntimeLock(input.projectId, () => createProvisionLock(`cloud:docker-project:${input.projectId}`).run(async () => {
    const project = await repos.project.findByIdInOrganization(input.projectId, input.organizationId);
    const binding = await repos.cloudDockerWorkspace.find(input.projectId, input.organizationId);
    if (!project || project.deletedAt || project.deletionInProgress || !binding || binding.workspaceId !== input.workspaceId) return false;
    const inFlight = await repos.deployment.listInFlightByProject(input.projectId);
    if (inFlight.some(dep => dep.id !== input.deploymentId)) return false;
    const credentials = env.CLOUD_MODE ? await issueNamespaceToken(input.organizationId) : await getOrgCloudToken(input.organizationId);
    if (!credentials || credentials.namespace !== binding.namespace) throw new Error("Cloud workspace namespace binding does not match this project");
    const client = new Oblien({ token: credentials.token, baseUrl: env.OBLIEN_API_URL });
    const ws = client.workspace(input.workspaceId);
    const current = await ws.get();
    if (current.namespace !== binding.namespace) throw new Error("Cloud workspace namespace changed");
    if (cloudWorkspaceStatus(current) !== "running" && cloudWorkspaceStatus(current) !== "active") return false;
    const allocated = current.resources;
    if (!allocated || !allocated.cpus || !allocated.memory_mb || !allocated.disk_size_mb) return false;
    const executor = new CloudWorkspaceExecutor(() => ws.runtime());
    let running: ResourceConfig;
    try {
      const ids = (await executor.exec("docker ps --quiet --no-trunc", { timeout: 30_000 })).trim().split(/\s+/).filter(Boolean);
      if (ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw new Error("Invalid container identity during Cloud workspace resizing");
      const format = '[{{json .Id}},{{json (index .Config.Labels "openship.project")}},{{json .HostConfig.Memory}},{{json .HostConfig.NanoCpus}},{{json .HostConfig.CpuQuota}},{{json .HostConfig.CpuPeriod}}]';
      const output = ids.length ? await executor.exec(`docker inspect --format ${sq(format)} ${ids.map(sq).join(" ")}`, { timeout: 30_000 }) : "";
      if (output.trim().split(/\r?\n/).filter(Boolean).length !== ids.length) throw new Error("Cloud container allocation changed during inspection");
      running = runningDockerAllocation(output, input.projectId);
    } finally { await executor.dispose(); }
    const next = { cpuCores: Math.max(input.resources.cpuCores, running.cpuCores),
      memoryMb: Math.max(input.resources.memoryMb, running.memoryMb), diskMb: allocated.disk_size_mb };
    // This path only reduces CPU/RAM, never asks a resize to grow capacity.
    if (next.cpuCores > allocated.cpus || next.memoryMb > allocated.memory_mb ||
        (next.cpuCores === allocated.cpus && next.memoryMb === allocated.memory_mb)) return false;
    input.onProgress?.("Releasing unused Cloud build resources; running services will briefly restart.\n");
    await resizeDockerWorkspace({ ...input, client, namespace: binding.namespace, resources: next });
    return true;
  }));
}

/** Reserve identity before a provider write. Retries use exactly the same POST
 * and idempotency key, then attach its id before waiting for the VM to boot. */
export async function ensureCloudDockerWorkspace(input: {
  projectId: string; organizationId: string; resources: ResourceConfig; signal?: AbortSignal;
  /** Service actions must reuse their recorded host, never provision a replacement. */
  existingWorkspaceId?: string;
  onProgress?: (message: string) => void;
}): Promise<NonNullable<DeploymentMeta["cloudDockerWorkspace"]>> {
  return createProvisionLock(`cloud:docker-project:${input.projectId}`).run(async () => {
    input.signal?.throwIfAborted();
    const project = await repos.project.findByIdInOrganization(
      input.projectId,
      input.organizationId,
    );
    if (!project || project.deletedAt || project.deletionInProgress)
      throw new AppError("Project not found", 404, "PROJECT_NOT_FOUND");
    const existing = await repos.cloudDockerWorkspace.find(input.projectId, input.organizationId);
    if (
      input.existingWorkspaceId !== undefined &&
      (!existing || existing.workspaceId !== input.existingWorkspaceId)
    ) {
      throw new AppError(
        "Cloud Docker workspace does not belong to this project",
        404,
        "CLOUD_WORKSPACE_NOT_FOUND",
      );
    }
    if (env.CLOUD_MODE) await assertCloudCanSpend(input.organizationId);
    const credentials = env.CLOUD_MODE ? await issueNamespaceToken(input.organizationId) : await getOrgCloudToken(input.organizationId);
    if (!credentials) throw new AppError("Connect Openship Cloud before deploying", 503, "CLOUD_NOT_CONNECTED");
    const { namespace, token } = credentials;
    const client = new Oblien({ token, baseUrl: env.OBLIEN_API_URL });
    if (!existing?.workspaceId && project.cloudWorkspaceId) {
      throw new Error("An existing native workspace must be migrated before enabling Docker");
    }
    const binding =
      existing ??
      (await repos.cloudDockerWorkspace.reserve(
        {
          projectId: input.projectId,
          namespace,
          image: CLOUD_DOCKER_IMAGE,
          resources: input.resources,
        },
        input.organizationId,
      ));
    if (binding.namespace !== namespace)
      throw new Error("Cloud workspace namespace binding does not match this project");
    let workspaceId = binding.workspaceId;
    if (!workspaceId) {
      if (input.signal?.aborted) {
        // This attempt has sent nothing. An older reservation can still belong
        // to an uncertain POST, so only release a key allocated by this call.
        if (!existing) {
          await repos.cloudDockerWorkspace.discardUncreated(
            input.projectId,
            input.organizationId,
            binding.provisionKey,
          );
        }
        input.signal.throwIfAborted();
      }
      const workspace = await client.workspaces
        .create({
          name: `Openship Compose ${input.projectId}`,
          slug: workspaceSlug(input.projectId),
          namespace,
          image: binding.image,
          mode: "temporary",
          wait_ready: false,
          idempotency_key: binding.provisionKey,
          config: {
            cpus: binding.resources.cpuCores,
            memory_mb: binding.resources.memoryMb,
            disk_size_mb: binding.resources.diskMb,
            wait_for_init: true,
            ttl: "1h",
            ttl_action: "remove",
            remove_on_exit: false,
            network_config: { allow_internet: true, public_ingress: false },
          },
        })
        .catch(async (error) => {
          const failure = cloudWorkspaceCreationFailure(error);
          if (failure.workspaceId) {
            // A failed create may already own a disk. Persist its verified
            // identity before reporting the failure so normal deletion finds it.
            const created = await client.workspaces.get(failure.workspaceId);
            if (
              created.id !== failure.workspaceId ||
              created.namespace !== namespace ||
              created.slug !== workspaceSlug(input.projectId)
            ) {
              throw new Error("Could not verify the failed Cloud workspace's ownership");
            }
            await repos.cloudDockerWorkspace.attach(
              input.projectId,
              input.organizationId,
              namespace,
              failure.workspaceId,
            );
          } else if (failure.capacityRejected && existing) {
            // Admission may reject a replay before returning its earlier result.
            // Adopt a verified workspace instead of provisioning a replacement.
            // If none is visible, preserve the key: list absence does not cancel
            // an earlier uncertain request, even after a quota rejection.
            const recovered = await findProjectWorkspace(client, input.projectId, namespace);
            if (recovered) return recovered;
          } else if (failure.rejected && !existing) {
            // Quota refusals are documented 409s too. They allocated nothing;
            // unknown conflicts, timeouts and outages must retain the retry key.
            // A rejection of this retry cannot disprove an earlier uncertain POST.
            await repos.cloudDockerWorkspace.discardUncreated(
              input.projectId,
              input.organizationId,
              binding.provisionKey,
            );
          }
          throw error;
        });
      if (!workspace.id || workspace.namespace !== namespace)
        throw new Error("Oblien returned an unexpected workspace namespace");
      workspaceId = workspace.id;
      // Complete this write even when cancellation arrived during POST. Teardown
      // and retries must know which resource exists outside our process.
      await repos.cloudDockerWorkspace.attach(input.projectId, input.organizationId, namespace, workspaceId);
    }
    const ws = client.workspace(workspaceId);
    const current = await ws.get();
    if (current.namespace !== namespace) throw new Error("Cloud workspace namespace changed");
    input.signal?.throwIfAborted();
    const status = cloudWorkspaceStatus(current);
    const provisioning = current.provisioning as { state?: string } | undefined;
    if (binding.state === "provisioning" && provisioning?.state === "failed") {
      // Only initial creation is retryable here. A host that already held
      // customer containers must never go through creation again.
      input.onProgress?.("Retrying the Docker workspace's initial provisioning with its existing disk.\n");
      const retried = await client.workspaces.retryCreation(workspaceId);
      if (retried.id !== workspaceId || retried.namespace !== namespace) {
        throw new Error("Cloud provisioning retry returned an unexpected workspace");
      }
    } else if (status === "stopped") await ws.start();
    else if (status === "paused" || status === "suspended") await ws.resume();
    const ready = await waitForCloudDockerWorkspace(client, workspaceId, namespace, { signal: input.signal });
    // Permanence precedes the first container/volume write; a failed later build
    // must never expire a disk already holding customer data.
    await ws.lifecycle.makePermanent();
    const allocated = ready.resources;
    if (allocated && (input.resources.cpuCores > (allocated.cpus ?? binding.resources.cpuCores) ||
        input.resources.memoryMb > (allocated.memory_mb ?? binding.resources.memoryMb) ||
        input.resources.diskMb > (allocated.disk_size_mb ?? binding.resources.diskMb))) {
      input.onProgress?.("Increasing the shared Cloud workspace allocation; running services will briefly restart.\n");
      await resizeDockerWorkspace({ ...input, client, workspaceId, namespace, resources: {
        cpuCores: Math.max(input.resources.cpuCores, allocated.cpus ?? binding.resources.cpuCores),
        memoryMb: Math.max(input.resources.memoryMb, allocated.memory_mb ?? binding.resources.memoryMb),
        diskMb: Math.max(input.resources.diskMb, allocated.disk_size_mb ?? binding.resources.diskMb),
      } });
    }
    await repos.cloudDockerWorkspace.markReady(input.projectId, input.organizationId, workspaceId);
    return { projectId: input.projectId, workspaceId };
  }, input.signal);
}
