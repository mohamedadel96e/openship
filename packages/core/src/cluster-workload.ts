import { AppError } from "./errors";
import { detectDbImage } from "./backup-image-detect";
import { validateClusterVolumeMounts, type ClusterVolumeMount } from "./cluster-storage";

/** Database replicas require an engine-specific workflow, not application copies. */
export function clusterWorkloadNeedsOperator(
  framework?: string | null,
  image?: string | null,
): boolean {
  return (
    !!detectDbImage(image) ||
    /^(postgres|postgresql|mysql|mariadb|redis|valkey|mongodb|clickhouse|elasticsearch)$/i.test(
      framework ?? "",
    )
  );
}

/** Persisted product intent. Kubernetes owns placement, health and reconciliation. */
export interface ClusterWorkloadConfig {
  replicas: number;
  /** Registry repository, without a tag; source builds publish immutable releases here. */
  imageRepository?: string;
  /** References to project-owned shared volumes, frozen with each release. */
  mounts?: ClusterVolumeMount[];
}

export interface ClusterWorkloadStatus {
  desired: number;
  ready: number;
  available: number;
  updated: number;
  generation: number;
  observedGeneration: number;
  message: string | null;
  pods: Array<{
    name: string;
    nodeName: string | null;
    serverId?: string | null;
    serverName?: string | null;
    ready: boolean;
    phase: string;
    restarts: number;
  }>;
}

export function validateClusterWorkload(config: ClusterWorkloadConfig): void {
  if (config.mounts) validateClusterVolumeMounts(config.mounts);
  if (!Number.isSafeInteger(config.replicas) || config.replicas < 1 || config.replicas > 100)
    throw new AppError(
      "Choose between 1 and 100 application instances.",
      422,
      "CLUSTER_CONFIG_INVALID",
    );
  if (
    config.imageRepository !== undefined &&
    (config.imageRepository.length > 255 ||
      !/^(?:[a-z0-9.-]+(?::[0-9]{1,5})?\/)[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(
        config.imageRepository,
      ))
  )
    throw new AppError(
      "Enter a registry repository without a tag, such as ghcr.io/team/api.",
      422,
      "CLUSTER_CONFIG_INVALID",
    );
}
