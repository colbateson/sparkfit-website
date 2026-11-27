# SparkFit Business implementation status

Updated 27 November 2026. Work is on `main`. Production launch, payments and RevenueCat writes were enabled at the owner's explicit direction, waiving the internal live purchase and app-store acceptance checks. Monitor employee activation and the first customer billing journey closely.

## Production now

- Worker: `sparkfit-business-platform-production`, served at `https://business.spark-fit.com`.
- The current production Worker health endpoint responds with `ok: true`, `environment: production`, `paymentsEnabled: true`, `revenueCatWritesEnabled: true`, and `emailEnabled: true`.
- Production `/v1/public-config` is `testMode=false`, `paymentsEnabled=true`, `turnstileRequired=true`, and `requireAppAccountForBusiness=true`; the production Turnstile site key is returned.
- Production D1 exists and migrations `0001` through `0009` were applied.
- The Cloudflare production Worker settings were checked directly: `ENVIRONMENT=production`, `SERVICE_ORIGIN=https://business.spark-fit.com`, the production D1 binding is attached, and the secret names `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `REVENUECAT_SECRET_KEY` and `TURNSTILE_SECRET_KEY` are present as encrypted values. Secret values were not read.
- `LAUNCH_ENABLED=true`, `PAYMENTS_ENABLED=true`, and `REVENUECAT_WRITES_ENABLED=true`. `RETENTION_ENABLED=true` under the approved and published retention policy. Transactional email is enabled. Turnstile and rate limiting remain on.
- Production Turnstile is configured for `business.spark-fit.com`; public pilot and purchase routes are open.
- Live Stripe account is SparkFit (`acct_1UbmXSCmqrWF2STN`). The active product `SparkFit Business Annual Access` has a £20.83/year base price; volume prices are created from the server-side schedule for 20–500 seats. The product uses tax category `txcd_10103101` and Managed Payments is enabled. A limited live restricted key is present in Stripe, and the 11-event endpoint `https://business.spark-fit.com/v1/webhooks/stripe` is active. It covers checkout, subscription, invoice failure/payment, refund, dispute and early-fraud events. Customer Portal ID is configured: name, email, billing address, invoice access, payment-method updates and end-of-period cancellation are on; plan/quantity changes and phone collection are off because seat changes are handled in the employer portal. Invoice PDFs are enabled with SparkFit purple branding; Stripe still has no logo uploaded. No real production purchase has been completed.
- Production RevenueCat credentials and Business entitlement identifiers are configured, and writes are enabled. The latest identity/entitlement app build was not confirmed in the iOS or Android store at launch; disable provisioning if current store builds cannot complete employee activation.
- `business-mail.spark-fit.com` is verified in Resend. Its DNS records are present in Cloudflare. The sending-only key and Resend webhook signing secret were stored as production Worker secrets. Sender is `partnerships@business-mail.spark-fit.com`; replies go to the monitored `partnerships@spark-fit.com` inbox. The existing `mail.spark-fit.com` was left untouched because it belongs to another Resend team.
- Resend webhook at `https://business.spark-fit.com/v1/webhooks/resend` is configured for delivered, bounced, complained, failed and delayed events. Signed webhook routes remain available. On 27 November 2026, a controlled production sign-in email was received at `partnerships@spark-fit.com`; production D1 recorded the outbox row as `delivered` and stored the signed `email.delivered` callback. Successful delivery is confirmed; provider-supported failure/bounce/complaint scenarios and spam placement still need review.
- Approved commercial and privacy wording is published at `https://spark-fit.com/business/terms.html` and `https://spark-fit.com/business/privacy.html`. Both pages return HTTP 200 and are linked from the live Stripe Customer Portal and Checkout disclosures.
- Live Stripe product category and Managed Payments eligibility are configured. Managed Payments is enabled and Ready to use, becoming Active after a transaction. Smart Retries, overdue handling, Customer Portal, invoice PDF settings, live price/quantity calculation and the 11-event webhook were reviewed. The Worker has no public payment bypass.
- A one-time live Checkout was prepared for SparkFit at 20 seats, but the owner did not submit it because of the cost. The temporary preparation endpoint and page were removed. Public purchases are available through the normal purchase flow; no real production purchase has yet been completed.
- The latest implementation also fixes email link scanners consuming sign-in links, and ensures Stripe/Resend webhooks can reach signature validation while the public launch gate is active.

## Staging evidence

- Employer pilot, approval, purchase ledger, employer portal, invitations, activation reporting, employee removal and seat recovery are implemented.
- Stable SparkFit UUID identity, verified email, safe invitation account linking and the separate RevenueCat Business entitlement are implemented locally. Personal Pro/Trial access is preserved when Business access is removed.
- Stripe annual GBP seat billing includes Checkout, Customer Portal, signed webhooks, idempotency, failed-renewal grace/recovery and reconciliation. A staging failed-renewal and recovery scenario passed; see [STAGING_RENEWAL_RESULTS.json](./STAGING_RENEWAL_RESULTS.json).
- Staging email templates and callbacks were tested. A mailbox review found the previews in Inbox and none in Spam. DMARC is currently `p=none`; monitor aggregate reports.
- Turnstile and rate limits are enabled in staging. The staging purchase form remains closed to payment until test Checkout acceptance is completed.
- Business data retention and legal-hold handling are implemented and staging-tested. The approved retention policy is enabled in production.
- The website and SQLite-backed flow suites passed in the latest recorded staging run. The latest code changes also received the 34-test unit run and 18-test E2E run before production deployment.

## Post-launch acceptance and monitoring

1. **Verify production configuration:** `/health`, `/v1/public-config`, the Cloudflare production Worker variables and D1 binding have now been checked. The configured secret names exist, but these checks do not prove every external credential works.
2. **Verify email failure paths:** successful controlled delivery and callback are confirmed. Review Spam placement and failure/bounce/complaint reporting with provider-supported test events.
3. **Stripe live acceptance:** live configuration is reviewed, but no live transaction has confirmed the complete customer journey. Monitor the first customer checkout, tax, invoice, renewal and webhook events closely.
4. **Commercial/privacy wording:** approved wording is published, and both public URLs are linked in Stripe.
5. **Mobile compatibility:** acceptance-test the released iOS and Android apps for sign-in, verified email, Business entitlement refresh, account-email mismatch linking, restore, and preservation of personal Pro/Trial. Provisioning is live; disable it promptly if store builds cannot complete activation.
6. **Production acceptance:** conduct an internal employee grant/removal and verify reconciliation and personal entitlement preservation. The owner waived the internal live purchase; monitor the first customer transaction and invoice.
7. **Email failure paths:** review spam placement and provider-supported failure/bounce/complaint callbacks.

## Current constraints

- SparkFit is not UK VAT registered per the user's confirmation. Employer prices are before applicable transaction tax. Stripe Managed Payments calculates/collects applicable taxes as merchant of record; the final Checkout amount must be verified before the first charge.
- Managed Payments is enabled for the live product. Public launch, payments and RevenueCat writes are enabled at the owner's explicit direction.
- No real live purchase has been completed; the owner waived the internal purchase. Customers can use the public purchase flow.
- Mobile store compatibility, email failure-path acceptance, first customer payment and internal employee grant/removal remain unverified post-launch checks. Disable affected gates if any check fails. Retention is enabled under the approved policy.
- Wrangler secret inventory via CLI was blocked by the approval-service usage limit, but Cloudflare Dashboard confirms the production secret names are present. Do not work around the CLI restriction by exposing or re-entering secret values.

See [PRODUCTION_RUNBOOK.md](./PRODUCTION_RUNBOOK.md) for operating steps and safety gates.
