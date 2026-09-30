import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainRoute, Oblien } from "oblien";
import { CloudInfraProvider } from "./cloud";

const hostname = "app.opsh.io";
const namespace = "tenant-one";
const workspaceId = "workspace-one";
const targetUrl = "http://10.103.0.9:3000";
let owner: DomainRoute;
let workspace: Record<string, unknown>;
let inventory: ReturnType<typeof vi.fn>;
let getWorkspace: ReturnType<typeof vi.fn>;
let setRoutes: ReturnType<typeof vi.fn>;
let listPorts: ReturnType<typeof vi.fn>;
let revokePort: ReturnType<typeof vi.fn>;
let provider: CloudInfraProvider;

beforeEach(() => {
  owner = {
    id: 1,
    hostname,
    slug: "app",
    domain: "opsh.io",
    namespace,
    owner_type: "port",
    owner_id: workspaceId,
    route_type: "host",
    target: targetUrl,
    is_custom: false,
    status: "active",
  };
  workspace = { id: workspaceId, namespace, ip: "10.103.0.9" };
  inventory = vi.fn(async () => ({ data: [owner] }));
  getWorkspace = vi.fn(async () => workspace);
  setRoutes = vi.fn(async (_hostname: string, input: unknown) => {
    // The real provider replaces the raw URL with a compiled JSON table.
    owner = { ...owner, route_type: "routes", target: JSON.stringify(input) };
  });
  listPorts = vi.fn(async () => [
    { port: 3000, hash: "app", domain: "opsh.io", url: `https://${hostname}` },
  ]);
  revokePort = vi.fn();
  const client = {
    domain: { routes: inventory },
    routes: { set: setRoutes },
    workspace: vi.fn(() => ({
      get: getWorkspace,
      publicAccess: { list: listPorts, revoke: revokePort },
    })),
  } as unknown as Oblien;
  provider = new CloudInfraProvider(client, { namespace });
});

describe("Cloud workspace port routes", () => {
  it.each(["port", "workspace"])(
    "updates a %s owner using the workspace identity and remains retryable",
    async (ownerType) => {
      owner.owner_type = ownerType as DomainRoute["owner_type"];
      for (let attempt = 0; attempt < 2; attempt++) {
        await provider.registerRoute({ domain: hostname, targetUrl, tls: true });
      }
      expect(setRoutes).toHaveBeenCalledTimes(2);
      expect(setRoutes).toHaveBeenLastCalledWith(hostname, {
        routes: [
          {
            match: { path: "/", type: "prefix" },
            action: { kind: "proxy", workspace: workspaceId, port: 3000 },
          },
        ],
      });
      expect(inventory).toHaveBeenCalledWith({ namespace });
    },
  );

  it("uses the owning workspace's current IP after a restart", async () => {
    workspace.ip = "10.103.0.10";
    await provider.registerRoute({
      domain: hostname,
      targetUrl: "http://10.103.0.10:3000",
      tls: true,
    });
    expect(setRoutes).toHaveBeenCalledOnce();
  });

  it("does not publish a route listed under a different namespace", async () => {
    owner.namespace = "tenant-two";
    await expect(
      provider.registerRoute({ domain: hostname, targetUrl, tls: true }),
    ).rejects.toThrow();
    expect(getWorkspace).not.toHaveBeenCalled();
    expect(setRoutes).not.toHaveBeenCalled();
  });

  it.each(["tenant-two", null, undefined])(
    "rejects a workspace whose namespace changed to %s",
    async (value) => {
      workspace.namespace = value;
      await expect(
        provider.registerRoute({ domain: hostname, targetUrl, tls: true }),
      ).rejects.toThrow();
      expect(setRoutes).not.toHaveBeenCalled();
    },
  );

  it.each([
    "http://10.103.0.10:3000",
    "http://127.0.0.1:3000",
    "http://attacker.example:3000",
    "http://user:password@10.103.0.9:3000",
    "ftp://10.103.0.9:3000",
  ])("rejects an unowned or invalid upstream %s", async (targetUrl) => {
    await expect(
      provider.registerRoute({ domain: hostname, targetUrl, tls: true }),
    ).rejects.toThrow();
    expect(setRoutes).not.toHaveBeenCalled();
  });

  it("does not trust a stale route's IP if the workspace has no current IP", async () => {
    workspace.ip = null;
    await expect(
      provider.registerRoute({ domain: hostname, targetUrl, tls: true }),
    ).rejects.toThrow();
    expect(setRoutes).not.toHaveBeenCalled();
  });

  it("propagates an unavailable workspace instead of falling back to the stored target", async () => {
    getWorkspace.mockRejectedValue(new Error("provider unavailable"));
    await expect(
      provider.registerRoute({ domain: hostname, targetUrl, tls: true }),
    ).rejects.toThrow("provider unavailable");
    expect(setRoutes).not.toHaveBeenCalled();
  });

  it.each(["page", "edge_proxy"])(
    "does not reinterpret a %s owner as a workspace",
    async (ownerType) => {
      owner.owner_type = ownerType as DomainRoute["owner_type"];
      await expect(
        provider.registerRoute({ domain: hostname, targetUrl, tls: true }),
      ).rejects.toThrow();
      expect(setRoutes).not.toHaveBeenCalled();
    },
  );

  it("revokes only the port bound to the requested managed hostname", async () => {
    listPorts.mockResolvedValue([
      { port: 8080, url: "https://sibling.opsh.io" },
      { port: 3000, url: `https://${hostname}` },
    ]);
    await provider.removeRoute(hostname);
    expect(revokePort).toHaveBeenCalledExactlyOnceWith(3000);
  });

  it("does not revoke a port after its hostname binding changed", async () => {
    listPorts.mockResolvedValue([{ port: 3000, url: "https://replacement.opsh.io" }]);
    await expect(provider.removeRoute(hostname)).rejects.toThrow();
    expect(revokePort).not.toHaveBeenCalled();
  });
});
