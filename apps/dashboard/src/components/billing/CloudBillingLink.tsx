"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { setActiveOrganizationId } from "@/lib/api/client";
import { useI18n } from "@/components/i18n-provider";

const organizations = (
  authClient as unknown as {
    organization: {
      setActive: (input: {
        organizationId: string;
      }) => Promise<{ error?: { message?: string } | null }>;
    };
  }
).organization;

/** A billing email must never silently open checkout for a different active org. */
export function CloudBillingLink({
  organizationId,
  tab,
}: {
  organizationId: string;
  tab: "overview" | "topups";
}) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    if (!organizationId || organizationId.length > 255) {
      setFailed(true);
      return;
    }
    void organizations
      .setActive({ organizationId })
      .then((result) => {
        if (disposed) return;
        if (result.error) {
          setFailed(true);
          return;
        }
        setActiveOrganizationId(organizationId);
        window.location.assign(`/billing/${tab}`);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [organizationId, tab]);
  return (
    <div role={failed ? "alert" : "status"} className="p-6 text-sm">
      {failed ? t.billing.creditAlert.wrongOrganization : t.billing.creditAlert.opening}
    </div>
  );
}
