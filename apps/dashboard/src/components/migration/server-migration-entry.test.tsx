// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ServerMigrationWizard } from "./ServerMigrationWizard";

const h = vi.hoisted(() => ({ listServers: vi.fn(), scanStream: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/api/system", () => ({ systemApi: { listServers: h.listServers } }));
vi.mock("@/components/servers/add-server-modal", () => ({ useAddServerModal: () => vi.fn() }));
vi.mock("@/lib/api/server-migration", () => ({
  dockerMigrationApi: { scanStream: h.scanStream },
  isScanStreamStalled: () => false,
}));
vi.mock("@/context/GitHubContext", () => ({ useGitHub: () => ({ connected: false }) }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  h.listServers.mockResolvedValue([
    { id: "source-a", name: "First server", sshHost: "192.0.2.1", sshPort: 22, sshUser: "root" },
    { id: "source-b", name: "Second server", sshHost: "192.0.2.2", sshPort: 22, sshUser: "root" },
  ]);
  h.scanStream.mockImplementation(() => new Promise(() => {}));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("lets New Project select a source before scanning through the shared inline wizard", async () => {
  await act(async () => root.render(<ServerMigrationWizard variant="tab" onClose={vi.fn()} />));
  const scan = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Scan server",
  )!;
  expect(scan.disabled).toBe(true);
  expect(h.scanStream).not.toHaveBeenCalled();
  const picker = container.querySelector<HTMLButtonElement>("button[aria-haspopup]")!;
  expect(picker).not.toBeNull();
  await act(async () => picker.click());
  const source = Array.from(document.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Second server"),
  )!;
  expect(source).toBeDefined();
  await act(async () => source.click());
  expect(scan.disabled).toBe(false);
  await act(async () => scan.click());
  expect(h.scanStream).toHaveBeenCalledExactlyOnceWith(
    "source-b",
    expect.objectContaining({ flatDocker: false }),
  );
});
