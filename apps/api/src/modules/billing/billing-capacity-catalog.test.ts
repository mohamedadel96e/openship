import { describe, expect, it, vi } from "vitest";
import { PRICING } from "@repo/core";
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({ getOblienClient() { throw new Error("Capacity must be provider-enforced, not computed from owner resources"); } }));
import { cloudPlan, presentCloudPlans, subscriptionMetadata, subscriptionOffer, subscriptionPlan, topupOffer } from "@repo/platform/engine/modules/billing/billing-catalog";
import type { OblienSubscription } from "@repo/platform/engine/lib/oblien-billing-api";

const savedPro = (): NonNullable<OblienSubscription> => ({ tierId: "reseller", status: "active", billingInterval: "monthly",
  periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z", cancelAtPeriodEnd: false, canceledAt: null,
  offer: subscriptionOffer("pro", "monthly"), metadata: subscriptionMetadata("pro", "org-a", "ns-a") });

describe("funded Cloud offers and isolated capacity", () => {
  it("keeps every retail allowance within wallet funding and finite hardware limits", () => {
    for (const tier of ["hobby", "starter", "pro", "team"] as const) {
      const offer = subscriptionOffer(tier, "monthly");
      expect(offer.credits).toBeLessThanOrEqual(offer.unitAmount);
      expect(Object.values(offer.resourceLimits!).every(value => Number.isInteger(value) && value! > 0)).toBe(true);
      expect(offer.policy).toMatchObject({ overdraft: 0, suspendThreshold: 0 });
      expect(presentCloudPlans().plans.find(plan => plan.id === tier)?.resourceLimits).toEqual(offer.resourceLimits);
    }
  });
  it("a top-up only adds metered credits and cannot raise hardware limits or grace", () => {
    for (const pack of PRICING.creditPacks) {
      const offer = topupOffer(pack.id);
      expect(offer.credits * 1000).toBe(pack.creditsMilli);
      expect(offer.credits).toBeLessThanOrEqual(offer.unitAmount);
      expect(offer.resourceLimits).toBeUndefined(); expect(offer.policy).toBeUndefined();
    }
  });
  it("bounds legacy inherited capacity while preserving the customer's paid credits and price", async () => {
    const subscription = savedPro();
    subscription.offer = { ...subscription.offer!, reference: "openship:pro:v1", credits: 3000, unitAmount: 3900,
      resourceLimits: { max_workspaces: 12, max_vcpus: null, max_ram_mb: null, max_disk_gb: null } };
    subscription.metadata!.openship_offer_version = "1";
    const before = structuredClone(subscription);
    expect(subscriptionPlan(subscription, "org-a", "ns-a").resourceLimits).toEqual({ max_workspaces: 6, max_vcpus: 2,
      max_ram_mb: 8192, max_disk_gb: 32, max_total_vcpus: 4, max_total_ram_mb: 8192, max_total_disk_gb: 128 });
    expect(await cloudPlan("pro", subscription)).toMatchObject({ price: { monthly: 3900 }, monthlyCredits: 3_000_000 });
    expect(subscription).toEqual(before);
  });
  it("renewals retain the v2 paid snapshot when the public catalog changes", async () => {
    const subscription = savedPro();
    subscription.offer!.reference = "openship:pro:v2"; subscription.offer!.unitAmount = 3900;
    subscription.offer!.resourceLimits!.max_ram_mb = 6144; subscription.metadata!.openship_offer_version = "2";
    const before = structuredClone(subscription);
    const raw = PRICING.plans.find(plan => plan.id === "pro")!, old = structuredClone(raw);
    try {
      raw.billing.creditsPerCycle = 1000; raw.billing.resourceLimits.max_total_vcpus = 1; raw.price.monthly = 4900;
      expect(subscriptionPlan(subscription, "org-a", "ns-a").resourceLimits.max_total_vcpus).toBe(4);
      expect(await cloudPlan("pro", subscription)).toMatchObject({ price: { monthly: 3900 }, monthlyCredits: 3_500_000,
        resourceLimits: { max_total_vcpus: 4 } });
      expect(subscription).toEqual(before);
    } finally { Object.assign(raw, old); }
  });
  it.each([undefined, null])("rejects an incomplete or unbounded new retail capacity contract (%s)", value => {
    const subscription = savedPro(); subscription.offer!.resourceLimits!.max_total_vcpus = value;
    expect(() => subscriptionPlan(subscription, "org-a", "ns-a")).toThrow(/could not be verified/);
  });
  it("rejects a subscription copied from another organization or namespace", () => {
    expect(() => subscriptionPlan(savedPro(), "org-b", "ns-a")).toThrow(/could not be verified/);
    expect(() => subscriptionPlan(savedPro(), "org-a", "ns-b")).toThrow(/could not be verified/);
  });
});
