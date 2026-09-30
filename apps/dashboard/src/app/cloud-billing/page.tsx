import { redirect } from "next/navigation";
import { CloudBillingLink } from "@/components/billing/CloudBillingLink";
import { getSession } from "@/lib/server/session";

/** Keep the linked organization through login, before the active-org dashboard gate. */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string; tab?: string }>;
}) {
  const input = await searchParams;
  const organizationId =
    typeof input.organizationId === "string" && input.organizationId.length <= 255
      ? input.organizationId
      : "";
  const tab = input.tab === "topups" ? "topups" : "overview";
  if (!(await getSession())) {
    const destination = `/cloud-billing?${new URLSearchParams({ organizationId, tab })}`;
    redirect(`/login?${new URLSearchParams({ returnTo: destination })}`);
  }
  return <CloudBillingLink organizationId={organizationId} tab={tab} />;
}
