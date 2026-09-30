import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Oblien } from "oblien";
import { CloudInfraProvider } from "./cloud";

const hostname = "app.opsh.io";
const namespace = "tenant-one";
const workspaceId = "workspace-one";
let workspaceNamespace: string;
let routeType: string;
let storedTarget: string;
let writes: Array<{ hostname: string; input: Record<string, unknown> }>;
let reads: URL[];
let provider: CloudInfraProvider;

beforeEach(() => {
  workspaceNamespace = namespace;
  routeType = "host";
  storedTarget = "http://10.103.0.9:3000";
  writes = [];
  reads = [];
  // Use the published SDK's real URL, query and response handling. Only the
  // HTTP peer is simulated; no production credential or resource is involved.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      if (url.origin !== "https://oblien.test") throw new Error("Unexpected network origin");
      if (method === "GET") reads.push(url);
      if (method === "GET" && url.pathname === "/domain/routes") {
        return Response.json({
          success: true,
          data: [
            {
              id: 1,
              hostname,
              slug: "app",
              domain: "opsh.io",
              namespace,
              status: "active",
              owner_type: "port",
              owner_id: workspaceId,
              is_custom: 0,
              route_type: routeType,
              target: storedTarget,
            },
          ],
        });
      }
      if (method === "GET" && url.pathname === `/workspace/${workspaceId}`) {
        return Response.json({
          success: true,
          workspace: {
            id: workspaceId,
            namespace: workspaceNamespace,
            status: "active",
            ip: "10.103.0.9",
            info: { status: "running", is_running: true },
          },
        });
      }
      if (method === "PUT" && url.pathname === `/domain/routes/${hostname}`) {
        const body = JSON.parse(String(init?.body));
        writes.push({ hostname, input: body });
        routeType = "routes";
        storedTarget = JSON.stringify({
          v: 1,
          rules: [{ action: { k: "proxy", backend: "http://10.103.0.9:3000", vm: workspaceId } }],
        });
        return Response.json({
          success: true,
          hostname,
          version: writes.length,
          config: JSON.parse(storedTarget),
        });
      }
      throw new Error(`Unexpected provider request: ${method} ${url.pathname}`);
    }),
  );
  provider = new CloudInfraProvider(
    new Oblien({ token: "test-namespace-token", baseUrl: "https://oblien.test" }),
    { namespace },
  );
});

afterEach(() => vi.unstubAllGlobals());

it("updates a native port route twice through the SDK after the provider switches to a compiled table", async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    await provider.registerRoute({
      domain: hostname,
      targetUrl: "http://10.103.0.9:3000",
      tls: true,
    });
  }
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual({
    hostname,
    input: {
      routes: [
        {
          match: { path: "/", type: "prefix" },
          action: { kind: "proxy", workspace: workspaceId, port: 3000 },
        },
      ],
    },
  });
  const inventories = reads.filter((url) => url.pathname === "/domain/routes");
  expect(inventories).toHaveLength(2);
  expect(inventories.every((url) => url.searchParams.get("namespace") === namespace)).toBe(true);
});

it("sends no update when the provider's workspace response belongs to a different namespace", async () => {
  workspaceNamespace = "tenant-two";
  await expect(
    provider.registerRoute({ domain: hostname, targetUrl: "http://10.103.0.9:3000", tls: true }),
  ).rejects.toMatchObject({ code: "CLOUD_ROUTE_OWNER_CHANGED", statusCode: 409 });
  expect(writes).toEqual([]);
});
