# Cloud capacity and unit economics — 2026-09-29

Version 3 introduces **$5 / $20 / $40 / $99** Hobby / Starter / Pro / Team offers,
with **400 / 1,700 / 3,500 / 9,000** metered credits. The prior capacity fixes and
source-builder corrections remain in place. [The catalog reference](../packages/core/src/pricing/README.md)
is the exact customer contract, including saved v1/v2 renewal behavior.

## Hardware and revenue budget

The operator supplied $70/month for 12 physical cores, 64 GB RAM and 1 TB storage.
It is a hardware cost, not a complete operating cost. Plan ceilings are shared
virtual CPU limits and maximum allocation; they are not dedicated physical cores
or a promise of continuous use for the subscription price. Keep fleet admission
and operational headroom independent of retail namespace limits.

For planning, assume another $25/node/month for operations, card fees of 2.9% plus
$0.30 per payment, and a 2% refund reserve. These assumptions need actual invoices.
With $200 revenue from ten payments, contribution is $92.20 (46.1%); with $300 from
fifteen payments it is $185.80 (61.9%). At a $20 average charge, break-even is about
$102/node/month and a 60% contribution target needs about $283. These exclude tax,
company payroll and other unmodelled expenses. Safe workload density must support
the revenue target: three $40 Pro subscriptions only leave $18.22 under this model.
Do not use CPU oversubscription or credit expiry as a substitute for measurement.

At company level, count the customer's payment once. Funding the Openship-owned
Oblien wallet is an internal transfer, not additional company revenue. At the
100 credits/USD funding rate, every ordinary allowance and top-up is funded by
its payment. Promotional subsidy must be separately budgeted and recorded.

## Usage pricing

One credit is not one minute. Current legacy Oblien workspace rates are 1.5
credits/active CPU-minute, 0.2/measured RSS GiB-minute and 0.15/GB of RX+TX transfer.
Workspace flush does not charge disk I/O. The legacy monthly discounts are 700
credits/vCPU for CPU, 100/GiB for memory and 100/vCPU for network. They are separate
from namespace budgets. The matching Oblien fix persists discount use with wallet,
namespace usage and ledger writes in one SQL transaction, scoped to owner,
namespace, workspace and UTC calendar month. Restart, top-up or quota reset cannot
replenish a consumed discount. Node billing windows must also replay unchanged
after a lost acknowledgement. Deploy and verify both halves before relying on it.

The proposed next Oblien compute card is **preview only**: $0.030/active vCPU-hour,
$0.008/reserved GiB-hour, $0.10/retained GiB-month and $0.05/public-egress GB.
Reserved RAM, retained disk and public egress require different meters from RSS,
disk I/O and RX+TX. Activating those rates requires matching meters and seven days
of usage/cost validation. They must not be advertised as the current billing rate.

Hobby is a finite trial-sized paid allowance, not a $5 always-on VM. Explain that
before checkout. Top-ups (400/$5, 1,700/$20, 4,500/$50) buy additional consumption
without changing hardware limits; a capacity increase requires a plan upgrade.
Alerts and recovery use the provider's namespace balance, including purchased
credits. Grace stays zero unless the reseller explicitly configures it.

## Verification and rollout

1. Deploy the generic Oblien aggregate-capacity API and additive schema first.
   Require `reseller.aggregateResourceLimits` before enabling new sales.
2. Deploy this Openship API/dashboard together. Published SDK 2.5.0 is sufficient.
3. Reconcile organizations through the billing sweep or guarded Cloud actions.
   v1 paid credits and periods remain unchanged; finite safety ceilings replace
   inherited capacity. v2 saved commercial terms remain intact.
4. Review oversized existing Docker hosts while no deployment is in progress.
   The shared helper reduces CPU/RAM only after checking ownership, namespace
   binding and bounded running containers. It retains disks and restores exactly
   the captured running services.
5. Verify provider allocation diagnostics, paid upgrades, top-ups, renewal replay,
   and signed webhooks. A checkout return alone does not prove credit delivery.
   Run payment tests in an isolated provider environment, not on a real customer.

Financial grants and checkpoints commit atomically in SQL. Stripe, SQL and VM
operations use durable work and idempotent recovery; they are not one distributed
transaction. Ambiguous VM operations retain capacity until provider state is known.
