// No DOM needed: renderToStaticMarkup runs no effects and both subjects are pure.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { PLANS, pricingUi } from "@repo/core";
import { BillingSidebar } from "./billing-shared";
import { PricingCards, type ApiPlan } from "@/components/billing/PricingCards";
import type { BillingState } from "@/lib/api/billing";

function render(node: React.ReactElement) {
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
}

function text(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const state = (tier: BillingState["tier"]): BillingState =>
  ({
    tier, status: "active", monthlyCreditLimit: 1_200_000,
    plan: tier === "free" ? null : {
      ...PLANS[tier], monthlyCredits: 1_200_000,
      name: "Live Cloud plan", price: { monthly: 1700, annual: 17000 },
      features: ["Support from the live catalog"],
    },
  }) as unknown as BillingState;

describe("billing sidebar", () => {
  it("shows the paid plan's live price, credits and features", () => {
    const out = text(render(<BillingSidebar state={state("starter")} />));
    expect(out).toContain("What's included");
    expect(out).toContain("Live Cloud plan");
    expect(out).toContain("$17");
    expect(out).toContain("1,200 credits / billing cycle");
    expect(out).toContain("Support from the live catalog");
    expect(out).not.toContain("$10");
  });

  it("keeps the no-plan promotion visible when the provider has no free product", () => {
    const out = render(<BillingSidebar state={state("free")} />);
    expect(text(out)).toContain("Launch on Openship Cloud");
    expect(out).toContain("/billing/plans");
    expect(text(out)).not.toContain("Unlimited");
  });

  it("does not invent a price when the paid plan is absent from the response", () => {
    const out = text(render(<BillingSidebar state={{ ...state("pro"), plan: null }} />));
    expect(out).toContain("Compare all plans");
    expect(out).not.toContain("$39");
    expect(out).not.toContain("credits / billing cycle");
  });
});

// The catalog's real strings rather than a hand-rolled stub: the endpoint serves
// exactly this block, so the fixture can't drift from what the component receives.
const ui = pricingUi("en");

const plan = (id: string, monthly: number | null): ApiPlan =>
  ({
    id,
    name: id,
    description: "",
    popular: false,
    price: { monthly, annual: null },
    listPrice: { monthly },
    effectivePrice: { monthly },
    campaign: null,
    limits: PLANS.starter.limits,
    features: [],
    support: "email",
  }) as unknown as ApiPlan;

describe("custom plan presentation", () => {
  it("keeps the catalog's sales action and current-plan state without promising preset allowances", () => {
    const custom = {
      ...plan("enterprise", null),
      name: "Enterprise",
      description: "Limits tailored to your team.",
      contactSales: "https://sales.example.test/contact",
      limits: PLANS.enterprise.limits,
    };
    const offer = render(<PricingCards plans={[custom]} ui={ui} />);
    expect(text(offer)).toContain(custom.description);
    expect(text(offer)).toContain(ui.custom);
    expect(offer).toContain(`href="${custom.contactSales}"`);
    expect(text(offer)).toContain(ui.ctaContact);
    expect(text(offer)).not.toContain("No set limit");
    expect(text(offer)).not.toContain("Choose Enterprise");

    const current = render(<PricingCards plans={[custom]} ui={ui} currentPlan="enterprise" />);
    expect(text(current)).toContain("Current plan");
    expect(current).not.toContain(`href="${custom.contactSales}"`);
  });
});
