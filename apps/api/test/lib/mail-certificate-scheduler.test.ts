import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cloud: false,
  domains: vi.fn(),
  list: vi.fn(),
  renewMail: vi.fn(),
  manage: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    domain: { findExpiringSsl: h.domains, findByHostname: async () => ({ id: "dom-mail" }) },
    mailServer: { list: h.list },
    project: { findById: async () => ({ organizationId: "org-1", name: "Project" }) },
  },
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    get CLOUD_MODE() {
      return h.cloud;
    },
  },
}));
vi.mock("@repo/platform/engine/lib/domain-ssl", () => ({
  MAIL_DOMAIN_OWNER: "mail",
  manageDomainSsl: h.manage,
  tlsIssuedElsewhere: () => null,
  resolveMailOwner: async () => ({ organizationId: "org-1", serverId: "srv-mail" }),
}));
vi.mock("@repo/platform/engine/modules/mail/mail-certificate.service", () => ({
  renewMailCertificate: h.renewMail,
}));
vi.mock("@repo/platform/engine/lib/notification-dispatcher", () => ({
  notification: { emit: h.notify },
}));
import { renewExpiringCerts } from "@repo/platform/engine/lib/ssl-scheduler";

const mail = () => ({
  serverId: "srv-mail",
  domain: "example.test",
  installedAt: new Date(),
  certificateAutoRenew: true,
  certificateHealth: null,
});
beforeEach(() => {
  vi.clearAllMocks();
  h.cloud = false;
  h.domains.mockResolvedValue([]);
  h.list.mockResolvedValue([mail()]);
  h.renewMail.mockResolvedValue({});
  h.manage.mockResolvedValue({ verified: true });
});

describe("shared mail certificate scheduler", () => {
  it("repairs legacy mail installs without a domain row", async () => {
    expect(await renewExpiringCerts()).toMatchObject({ renewed: 1 });
    expect(h.renewMail).toHaveBeenCalledWith("srv-mail", true);
  });

  it("never renews mail twice through both its domain and install records", async () => {
    h.domains.mockResolvedValue([{ ownerType: "mail", hostname: "mail.example.test" }]);
    await renewExpiringCerts();
    expect(h.renewMail).toHaveBeenCalledTimes(1);
    expect(h.manage).not.toHaveBeenCalled();
  });

  it("respects disabled renewal even if the mail domain is expired", async () => {
    h.domains.mockResolvedValue([{ ownerType: "mail", hostname: "mail.example.test" }]);
    h.list.mockResolvedValue([{ ...mail(), certificateAutoRenew: false }]);
    expect(await renewExpiringCerts()).toMatchObject({ total: 0 });
    expect(h.renewMail).not.toHaveBeenCalled();
    expect(h.manage).not.toHaveBeenCalled();
  });

  it("notifies the mail server's organization when renewal or reload fails", async () => {
    h.renewMail.mockRejectedValueOnce(new Error("SMTP still serves an expired certificate"));
    expect(await renewExpiringCerts()).toMatchObject({ failed: 1 });
    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", eventType: "ssl.renewal_failed" }),
    );
  });

  it("performs no mail or domain work in cloud mode", async () => {
    h.cloud = true;
    expect(await renewExpiringCerts()).toMatchObject({ total: 0 });
    expect(h.domains).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
  });
});
