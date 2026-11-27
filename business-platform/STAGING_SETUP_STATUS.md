# SparkFit Business implementation status

Updated 27 November 2026. Work is on `main`. Staging is deployed. Production is provisioned and deployed, but deliberately closed to customers pending the owner-completed first live payment and mobile release.

## Production now

- Worker: `sparkfit-business-platform-production`, served at `https://business.spark-fit.com`.
- The current production Worker health endpoint responds with `ok: true`, `environment: production`, `paymentsEnabled: false`, `revenueCatWritesEnabled: false`, and `emailEnabled: true`.
- Production `/v1/public-config` is `testMode=false`, `paymentsEnabled=false`, `turnstileRequired=true`, and `requireAppAccountForBusiness=true`; the production Turnstile site key is returned.
- Production D1 exists and migrations `0001` through `0009` were applied.
- The Cloudflare production Worker settings were checked directly: `ENVIRONMENT=production`, `SERVICE_ORIGIN=https://business.spark-fit.com`, the production D1 binding is attached, and the secret names `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `REVENUECAT_SECRET_KEY` and `TURNSTILE_SECRET_KEY` are present as encrypted values. Secret values were not read.
- `LAUNCH_ENABLED=false`, `PAYMENTS_ENABLED=false`, and `REVENUECAT_WRITES_ENABLED=false`. `RETENTION_ENABLED=true` under the approved and published retention policy. Transactional email is enabled for approved lifecycle and admin routes; public purchasing and employee provisioning remain gated.
- Production Turnstile is configured for `business.spark-fit.com`; the required flag is on. Public form endpoints remain closed by the launch gate.
- Live Stripe account is SparkFit (`acct_1UbmXSCmqrWF2STN`). The active product `SparkFit Business Annual Access` has a £20.83/year base price; volume prices are created from the server-side schedule for 20–500 seats. The product now has tax category `txcd_10103101` (SaaS with mobile app/plugin, business use) and is eligible for Managed Payments. The account's Managed Payments setting is enabled by default; status is Ready to use and becomes Active after its first transaction. The Worker production flag is set to use Managed Payments for Checkout, while launch/payment gates remain closed. A limited live restricted key is present in Stripe, and the 11-event endpoint `https://business.spark-fit.com/v1/webhooks/stripe` is active. It covers checkout, subscription, invoice failure/payment, refund, dispute and early-fraud events; no live event has yet been delivered. Customer Portal ID is configured and reviewed: name, email, billing address, invoice access, payment-method updates and end-of-period cancellation are on; plan/quantity changes and phone collection are off because seat changes are handled in the employer portal. Invoice PDFs are enabled and brand/accent colours are SparkFit purple; Stripe still has no logo uploaded. No real production purchase has been completed.
- Production RevenueCat credentials and Business entitlement identifiers are configured, but production entitlement writes remain off. The mobile identity/entitlement work is local and has not been released through the iOS and Android stores.
- `business-mail.spark-fit.com` is verified in Resend. Its DNS records are present in Cloudflare. The sending-only key and Resend webhook signing secret were stored as production Worker secrets. Sender is `partnerships@business-mail.spark-fit.com`; replies go to the monitored `partnerships@spark-fit.com` inbox. The existing `mail.spark-fit.com` was left untouched because it belongs to another Resend team.
- Resend webhook at `https://business.spark-fit.com/v1/webhooks/resend` is configured for delivered, bounced, complained, failed and delayed events. Signed webhook routes are accepted while the customer launch gate is closed. On 27 November 2026, a controlled production sign-in email was received at `partnerships@spark-fit.com`; production D1 recorded the outbox row as `delivered` and stored the signed `email.delivered` callback. Successful delivery is confirmed; provider-supported failure/bounce/complaint scenarios and spam placement still need review.
- Approved commercial and privacy wording is published at `https://spark-fit.com/business/terms.html` and `https://spark-fit.com/business/privacy.html`. Both pages return HTTP 200 and are linked from the live Stripe Customer Portal and Checkout disclosures.
- Live Stripe product category and Managed Payments eligibility are configured. Managed Payments is enabled and Ready to use, becoming Active after a transaction. Smart Retries, overdue handling, Customer Portal, invoice PDF settings, live price/quantity calculation and the 11-event webhook were reviewed. The Worker has no public payment bypass.
- A one-time live Checkout session was prepared for the owner-confirmed SparkFit order: 20 seats, `partnerships@spark-fit.com`, £333.20/year before applicable tax (£16.66 per seat). Checkout requires the buyer's billing address to calculate tax. It is open for owner review; no payment was submitted. The temporary preparation endpoint and page were removed and production redeployed with public gates still closed.
- The latest implementation also fixes email link scanners consuming sign-in links, and fixes the launch gate so Stripe/Resend webhooks can reach signature validation while public routes stay closed.

## Staging evidence

- Employer pilot, approval, purchase ledger, employer portal, invitations, activation reporting, employee removal and seat recovery are implemented.
- Stable SparkFit UUID identity, verified email, safe invitation account linking and the separate RevenueCat Business entitlement are implemented locally. Personal Pro/Trial access is preserved when Business access is removed.
- Stripe annual GBP seat billing includes Checkout, Customer Portal, signed webhooks, idempotency, failed-renewal grace/recovery and reconciliation. A staging failed-renewal and recovery scenario passed; see [STAGING_RENEWAL_RESULTS.json](./STAGING_RENEWAL_RESULTS.json).
- Staging email templates and callbacks were tested. A mailbox review found the previews in Inbox and none in Spam. DMARC is currently `p=none`; monitor aggregate reports.
- Turnstile and rate limits are enabled in staging. The staging purchase form remains closed to payment until test Checkout acceptance is completed.
- Business data retention and legal-hold handling are implemented and staging-tested. The approved retention policy is enabled in production.
- The website and SQLite-backed flow suites passed in the latest recorded staging run. The latest code changes also received the 34-test unit run and 18-test E2E run before production deployment.

## What still blocks a public production launch

1. **Verify production configuration:** `/health`, `/v1/public-config`, the Cloudflare production Worker variables and D1 binding have now been checked. The configured secret names exist, but these checks do not prove every external credential works.
2. **Verify email failure paths:** successful controlled delivery and callback are confirmed. Review Spam placement and failure/bounce/complaint reporting with provider-supported test events.
3. **Finish Stripe live acceptance:** live configuration has been reviewed. The owner must review the prepared Checkout's business name, billing address, tax, total and recurring terms, then submit the first payment. Do not enable public payments before that owner action and acceptance.
4. **Commercial/privacy wording:** approved wording is published, and both public URLs are linked in Stripe.
5. **Release the mobile identity changes:** build, install and acceptance-test on iOS and Android; verify sign-in, verified email, Business entitlement refresh, account-email mismatch linking, restore, and preservation of personal Pro/Trial. Then publish the app update and allow adoption before enabling employee provisioning.
6. **Run production acceptance behind the closed launch gate:** finish email failure-path checks; the owner completes the prepared live Checkout; then conduct one internal employee grant/removal after mobile support is released. Verify reconciliation and personal entitlement preservation.
7. **Only after all above:** enable launch and public payment/provisioning flags, point the business website to production, and monitor payment, email and entitlement events.

## Current constraints

- SparkFit is not UK VAT registered per the user's confirmation. Employer prices are before applicable transaction tax. Stripe Managed Payments calculates/collects applicable taxes as merchant of record; the final Checkout amount must be verified before the first charge.
- Managed Payments is enabled by default in Stripe and eligible for the live product. The Worker production config will pass Managed Payments enabled, but public launch/payment flags remain closed until acceptance.
- No real live purchase has been completed. The owner must submit the prepared Checkout after reviewing the final tax-inclusive amount and recurring payment terms.
- Mobile store release and app acceptance, email failure-path acceptance, owner-completed live payment, and post-release employee grant/removal remain outstanding. Keep public launch, payments and RevenueCat writes gated until acceptance. Retention is enabled because the policy is approved and published.
- Wrangler secret inventory via CLI was blocked by the approval-service usage limit, but Cloudflare Dashboard confirms the production secret names are present. Do not work around the CLI restriction by exposing or re-entering secret values.

See [PRODUCTION_RUNBOOK.md](./PRODUCTION_RUNBOOK.md) for operating steps and safety gates.
