import type { Oblien, DomainRoute } from "oblien";
import { isIP } from "node:net";
import { AppError } from "@repo/core";
import type { ManualCert, RouteConfig, SslResult } from "../types";
import type { RoutingProvider, SslProvider, ProvisionCertOptions } from "./types";
import type { CloudAdminProxy } from "../runtime/cloud";
import { cloudPageHostnames } from "../runtime/cloud/page-hostnames";

/** Older Page GET responses use flat fields; connect/renew and newer GETs use
 * the SDK's nested shape. Both must retain an explicit hostname binding. */
interface PageDomainInfo {
  domain?: string;
  customDomain?: string;
  ssl?: { status?: string | null; expiresAt?: string | null } | null;
  sslStatus?: string | null;
  sslExpiry?: string | null;
}

const normalizeHostname = (hostname: string) => hostname.trim().toLowerCase();
const disconnected = () => new AppError(
  "This domain has no Cloud route for this project. Retry routing from Domains & Routes, then verify HTTPS.",
  409, "CLOUD_DOMAIN_NOT_CONNECTED",
);

function checkDomainBinding(bound: string | null | undefined, domain: string): void {
  if (typeof bound !== "string" || normalizeHostname(bound) !== normalizeHostname(domain)) {
    throw new AppError("The Cloud domain binding changed. Refresh Domains & Routes and retry.", 409, "CLOUD_DOMAIN_CHANGED");
  }
}

/** Routing and certificates are provider-owned; no host proxy or certbot here. */
export class CloudInfraProvider implements RoutingProvider, SslProvider {
  readonly certificateManagement = "provider" as const;
  constructor(private readonly client: Oblien, private readonly options: {
    namespace?: string; adminProxy?: CloudAdminProxy; dockerWorkspaceId?: string;
  } = {}) {}

  private get pages() { return this.options.adminProxy?.pages ?? this.client.pages; }

  private async pageForDomain(domain: string) {
    if (!this.options.namespace) throw new Error("Cloud infrastructure requires an organization-scoped platform");
    const normalized = normalizeHostname(domain);
    const matches = (await this.pages.list()).pages.filter(page =>
      page.namespace === this.options.namespace && cloudPageHostnames(page).includes(normalized));
    if (matches.length > 1) throw new Error("Cloud hostname has ambiguous Page ownership");
    if (!matches[0]) return undefined;
    let page;
    try { page = (await this.pages.get(matches[0].slug)).page; }
    catch (error) { if ((error as { status?: number }).status === 404) return undefined; throw error; }
    if (page.namespace !== this.options.namespace || !cloudPageHostnames(page).includes(normalized)) {
      throw new Error("Cloud Page ownership changed while applying its route");
    }
    return page;
  }

  private async pageDomain(slug: string, domain: string): Promise<PageDomainInfo> {
    const { domain: info } = await this.pages.getDomain(slug) as { domain: PageDomainInfo | null };
    checkDomainBinding(info?.customDomain ?? info?.domain, domain);
    return info!;
  }

  private async workspaceDomain(workspaceId: string, domain: string) {
    if (this.options.dockerWorkspaceId && workspaceId !== this.options.dockerWorkspaceId) throw disconnected();
    const domains = this.client.workspace(workspaceId).domains;
    const info = await domains.get();
    checkDomainBinding(info?.customDomain, domain);
    return { domains, info: info! };
  }

  private async certificatePage(domain: string) {
    const page = await this.pageForDomain(domain);
    if (!page || (this.options.dockerWorkspaceId && (page.source_workspace_id !== this.options.dockerWorkspaceId ||
        page.exported_path !== `/opt/openship/cloud-docker/routes/${page.slug}`))) throw disconnected();
    return page;
  }

  private async owner(domain: string): Promise<DomainRoute | undefined> {
    if (!this.options.namespace) throw new Error("Cloud infrastructure requires an organization-scoped platform");
    const result = this.options.adminProxy?.domainRoutes
      ? await this.options.adminProxy.domainRoutes()
      : await this.client.domain.routes({ namespace: this.options.namespace });
    const matches = result.data.filter((route) =>
      normalizeHostname(route.hostname) === normalizeHostname(domain) &&
      route.namespace === this.options.namespace);
    if (matches.length > 1) throw new AppError("Cloud hostname ownership is ambiguous. Retry after the provider state updates.", 502, "CLOUD_DOMAIN_AMBIGUOUS");
    return matches[0];
  }

  async registerRoute(route: RouteConfig): Promise<void> {
    const owner = await this.owner(route.domain);
    if (!owner) throw new Error("Connect this domain to a cloud workspace or page before applying its routes");
    // Advanced deployment rules go through compileRoutingToOblien. A generic
    // host route cannot silently discard those settings.
    if (route.proxyLocations?.length || route.redirects?.length || route.headerRules?.length ||
        route.redirectHost || route.webhookProxy) {
      throw new Error("Cloud routing rules must be applied through the cloud deployment route table");
    }
    const setRoutes = this.options.adminProxy?.setRoutes ??
      ((hostname, input) => this.client.routes.set(hostname, input));
    if (owner.owner_type === "page" && route.staticRoot) {
      const page = await this.pageForDomain(route.domain);
      if (!page) throw new Error("Cloud route Page is unavailable");
      await setRoutes(route.domain, {
        static: { page: page.slug }, routes: [],
        cleanUrls: route.cleanUrls,
        trailingSlash: route.trailingSlash === undefined ? undefined : route.trailingSlash ? "enforce" : "strip",
      });
      return;
    }
    // Public workspace ports are registered as `port`; custom workspace
    // domains use `workspace`. In both cases owner_id is the workspace ID.
    if (!["workspace", "port"].includes(owner.owner_type) || !route.targetUrl) {
      throw new Error("Cloud route target does not match its owning resource");
    }
    const target = new URL(route.targetUrl);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
      throw new Error("Cloud route target must belong to its owning workspace");
    }
    // `target` becomes a compiled JSON table after routes.set(), and a stored
    // raw IP can become stale after a restart. Revalidate the live resource;
    // neither representation of the previous target is ownership evidence.
    const workspace = await this.client.workspace(owner.owner_id).get();
    if (
      workspace.id !== owner.owner_id ||
      workspace.namespace !== this.options.namespace ||
      (this.options.dockerWorkspaceId && owner.owner_id !== this.options.dockerWorkspaceId)
    ) {
      throw new AppError(
        "Cloud route workspace is no longer in this project or organization",
        409,
        "CLOUD_ROUTE_OWNER_CHANGED",
      );
    }
    const ip = workspace.ip;
    if (typeof ip !== "string" || !isIP(ip)) {
      throw new AppError(
        "The Cloud workspace has no current network address. Start it and retry routing.",
        409,
        "CLOUD_WORKSPACE_NOT_READY",
      );
    }
    const current = new URL(`http://${isIP(ip) === 6 ? `[${ip}]` : ip}`);
    if (target.hostname !== current.hostname) {
      throw new Error("Cloud route target must belong to its owning workspace");
    }
    const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    await setRoutes(route.domain, { routes: [{ match: { path: "/", type: "prefix" },
      action: { kind: "proxy", workspace: owner.owner_id, port } }] });
  }

  async removeRoute(domain: string, opts?: { signal?: AbortSignal }): Promise<void> {
    opts?.signal?.throwIfAborted();
    if (this.options.dockerWorkspaceId) {
      // Disabled Pages have no route-registry entry but still own exported
      // files. Inventory by Page hostname also makes their cleanup retryable.
      const page = await this.pageForDomain(domain);
      if (!page) return;
      if (page.source_workspace_id !== this.options.dockerWorkspaceId ||
          page.exported_path !== `/opt/openship/cloud-docker/routes/${page.slug}`) {
        throw new Error("Cloud route is not owned by this Docker project");
      }
      opts?.signal?.throwIfAborted();
      await this.pages.delete(page.slug);
      return;
    }
    const owner = await this.owner(domain);
    if (!owner) return; // authoritative absent route: idempotent retry
    opts?.signal?.throwIfAborted();
    if (owner.owner_type === "page") {
      const page = await this.pageForDomain(domain);
      if (!page) throw new Error("Cloud route Page is unavailable");
      if (owner.is_custom) {
        await this.pageDomain(page.slug, domain);
        await this.pages.disconnectDomain(page.slug);
      }
      else await this.pages.disable(page.slug);
      return;
    }
    if (!["workspace", "port"].includes(owner.owner_type))
      throw new Error("Cloud route is owned by an unsupported resource type");
    if (owner.is_custom) {
      const { domains } = await this.workspaceDomain(owner.owner_id, domain);
      await domains.disconnect();
    } else {
      const ws = this.client.workspace(owner.owner_id);
      const ports = await ws.publicAccess.list();
      let removed = false;
      for (const exposed of ports) {
        const hostnames = [exposed.url ? new URL(exposed.url).hostname : "", exposed.domain ?? "",
          typeof exposed.slug === "string" && exposed.domain ? `${exposed.slug}.${exposed.domain}` : ""];
        if (hostnames.some((hostname) => hostname.toLowerCase() === domain.toLowerCase())) {
          opts?.signal?.throwIfAborted();
          await ws.publicAccess.revoke(exposed.port);
          removed = true;
        }
      }
      if (!removed) throw new Error("Cloud route has no matching exposed port; retry after the provider state updates");
    }
  }

  private certificate(domain: string, status: string | null | undefined, expiry: string | null | undefined): SslResult {
    const time = expiry ? Date.parse(expiry) : NaN;
    const verified = ["active", "valid", "issued", "ready"].includes(status ?? "") && Number.isFinite(time) && time > Date.now();
    return {
      domain, expiresAt: Number.isFinite(time) ? new Date(time).toISOString() : "",
      issuer: "oblien", verified, reason: verified ? "issued" : expiry ? "invalid" : "missing",
    };
  }

  async verifyCert(domain: string): Promise<SslResult> {
    const owner = await this.owner(domain);
    if (!owner) throw disconnected();
    if (!owner.is_custom) return { domain, expiresAt: "", issuer: "oblien", verified: false, reason: "not_local" };
    if (owner.owner_type === "page") {
      const page = await this.certificatePage(domain);
      const info = await this.pageDomain(page.slug, domain);
      return this.certificate(domain, info.ssl?.status ?? info.sslStatus, info.ssl?.expiresAt ?? info.sslExpiry);
    }
    if (owner.owner_type !== "workspace") throw new Error("Certificate is owned by an unsupported cloud resource");
    const { info } = await this.workspaceDomain(owner.owner_id, domain);
    return this.certificate(domain, info.sslStatus, info.sslExpiry);
  }

  async provisionCert(domain: string, opts?: ProvisionCertOptions): Promise<SslResult> {
    const current = await this.verifyCert(domain);
    if ((current.verified && !opts?.force) || current.reason === "not_local") return current;
    return this.renewCert(domain);
  }

  async renewCert(domain: string): Promise<SslResult> {
    const owner = await this.owner(domain);
    if (!owner) throw disconnected();
    if (!owner.is_custom) return this.verifyCert(domain);
    if (owner.owner_type === "page") {
      const page = await this.certificatePage(domain);
      await this.pageDomain(page.slug, domain);
      await this.pages.renewSSL(page.slug);
    }
    else if (owner.owner_type === "workspace") {
      const { domains } = await this.workspaceDomain(owner.owner_id, domain);
      await domains.renewSSL();
    }
    else throw new Error("Certificate is owned by an unsupported cloud resource");
    const result = await this.verifyCert(domain);
    return result.verified ? { ...result, reason: "renewed" } : result;
  }

  async installCert(_domain: string, _cert: ManualCert): Promise<SslResult> {
    throw new Error("Manual certificates are not supported on Openship Cloud");
  }
}
