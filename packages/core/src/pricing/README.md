# Openship reseller catalog

`pricing.json` defines retail prices, metered credit allowances, application limits,
VM limits and combined namespace capacity. `GET /api/billing/plans` supplies the
same catalog to the dashboard, marketing and linked installations. Checkout uses
a generic Oblien offer; the subscription belongs to the customer's namespace.
The Enterprise reseller owner receives wallet funding and keeps its own plan.

## Version 3 offers

| Plan | Monthly price | Included credits | Total vCPU | Total RAM | Total disk | Workspace count | Per VM: CPU / RAM / disk |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Hobby | $5 | 400 | 1 | 4 GB | 16 GB | 1 | 1 / 4 GB / 16 GB |
| Starter | $20 | 1,700 | 2 | 6 GB | 32 GB | 3 | 2 / 6 GB / 16 GB |
| Pro | $40 | 3,500 | 4 | 8 GB | 128 GB | 6 | 2 / 8 GB / 32 GB |
| Team | $99 | 9,000 | 8 | 16 GB | 256 GB | 12 | 4 / 12 GB / 64 GB |

Hobby includes a finite allowance for light use. A continuously running Docker
host can need top-ups; $5 does not buy an unlimited always-on VM.

All limits apply together. Workspace/service counts do not promise that every
workspace or container can use its maximum size at the same time. CPU is shared
virtual CPU quota, not a dedicated physical core. An unpaid namespace has zero
workspace and total capacity. Enterprise remains contact-sales; only a verified
contract or audited operator grant can select it.

At Oblien's current 100 credits/USD wallet rate, these payments fund 500 / 2,000 / 4,000 /
9,900 wallet credits. The namespace allowances stay below that funding. Catalog
validation rejects unfunded retail allowances, top-ups and inherited retail
capacity. Oblien-admin promotions explicitly account for any promotional subsidy;
they are not an unrecorded enlargement of the namespace allowance.

Openship uses **milli-credits** internally: 1,000 milli-credits = one Oblien credit.
`billing.creditsPerCycle` and offers use whole credits; API `monthlyCredits`,
`annualCredits` and `credits_milli` use milli-credits. Credits are not minutes.
Oblien meters CPU, memory and transfer; its active rate card defines the billed dimensions. Current workspace billing does not charge disk I/O.
Neither a resource ceiling nor a credit grant promises continuous full-load
runtime for the entire month. New paid plans have no additional fixed build-minute
allowance; builds consume the same metered credits as applications.

Top-ups are 400 credits for $5, 1,700 for $20 and 4,500 for $50. They add purchased
credits without resetting consumption or changing capacity, grace, service limits
or the subscription. Only unused purchased credits carry to a later paid cycle.
Checkout idempotency includes the versioned offer reference, so a changed pack
price cannot replay an old quote accidentally. Older accepted orders retain
their saved amounts.

Grace is zero by default. `overdraft` and `suspendThreshold` can be explicitly
configured together; suspension cannot precede the blocking threshold. The
provider balance already includes grace. Annual checkout stays disabled until an
annual price and explicit funded annual allowance are published.

## Capacity enforcement

- `max_workspaces` limits the allocated count, including build workspaces.
- `max_vcpus`, `max_ram_mb`, `max_disk_gb` limit one VM.
- `max_total_vcpus`, `max_total_ram_mb`, `max_total_disk_gb` limit the combined
  namespace allocation, including stopped VMs, managed disks and pending resizes.
- Application project/service counts and per-container CPU/RAM are enforced by
  Openship. The underlying VM and namespace pools are enforced by Oblien, even
  when a caller uses the provider API directly.

Openship submits its chosen policy; it does not calculate the owner's remaining
capacity. Oblien intersects configured, paid, account and platform limits and
reserves capacity atomically on create/resize. `readCloudCapacity` supplies the
dashboard with provider allocations instead of estimating them from services.

Service slots include enabled services in deployed projects, active containers,
and accepted deployment reservations. Saving an undeployed draft consumes no
service slots. Reservations remain until activation or worker cleanup finishes;
redeploying the same service does not consume a second slot.

An image-only Compose app gets only its service allocation plus Docker/OS room:
a default 512 MB service uses a 1 CPU / 1 GB host with an 8 GB disk. Source builds
reserve additional RAM temporarily. After deployment, verified running container
limits determine whether CPU/RAM can be released under the project runtime lock.
Disks never shrink automatically. Unknown/unbounded containers prevent automatic
downsizing. Captured running services are restored after a resize; intentionally
stopped services stay stopped.

## Existing subscriptions and upgrades

`openship:<tier>:v3` saves the price, credits, grace, application limits and all
seven capacity fields. Renewals use that snapshot, even after catalog edits.
Unknown versions, missing v2/v3 capacity fields and organization/namespace mismatches
fail closed. Price and credit metadata never come from browser input.

Saved v2 subscriptions retain their original price, credits and capacity snapshot.
The new Hobby tier exists only in v3: a legacy provider `hobby` subscription still
maps to its original Openship Starter tier, never to the new $5 plan.

Legacy v1 offers left VM sizes inherited from the Enterprise owner. Reconciliation
adds the current retail safety ceilings to those offers while preserving their
paid price, credits, period and history. It also preserves tighter saved limits.
Existing allocations above a new ceiling are not destroyed; downsize CPU/RAM or
remove/migrate resources before adding more. The older API patch shape preserves
the new total fields, so a prior client cannot erase them by omission.

A paid plan change starts a new full-price cycle and replaces only that namespace's
subscription. It does not prorate or automatically refund the previous cycle.
Credit deposits cannot unlock a more expensive hardware tier. Invoice, renewal,
refund, webhook and owner-wallet settlement remain provider-managed.

## Provider and rollout

Deploy Oblien's API first. `/billing/catalog` must report `contractVersion >= 2`,
`offerPolicy`, `resourceLimits`, `effectiveResourceLimits` and
`aggregateResourceLimits` all enabled. Then deploy the Openship API and dashboard
together. Checkout/readiness fail closed when total enforcement is missing;
existing portal and cancellation actions remain available.

Openship uses published `oblien@2.5.0` transport and validates the new response
fields locally. Its existing log cancellation patch is carried forward to 2.5.0;
do not remove it until using a release with the upstream cancellation fix.
SDK 2.6.0 adds that fix and exported total-capacity types for other integrations;
Openship does not depend on an unpublished package. Admin-created promotions use
the exact hosted URL returned by Oblien. Campaign helpers and legacy Stripe price
IDs do not define reseller checkout prices.

See [capacity economics](../../../../docs/cloud-capacity-economics.md) and
[Cloud release gate](../../../../docs/openship-cloud-launch.md).
