# SparkFit Business Production Runbook

This runbook documents the SparkFit Business implementation and production operation. On 27 November 2026, the owner explicitly enabled customer-facing launch, public payments and RevenueCat writes while waiving the internal live purchase and app-store acceptance checks. Complete the remaining post-launch checks promptly and be ready to disable affected flags if a live issue appears.

For the latest completed configuration, CLI recovery instructions and outstanding integration checks, read [STAGING_SETUP_STATUS.md](./STAGING_SETUP_STATUS.md) first. Code implemented behind a flag is not a completed end-to-end test.

## 1. Current position

The following foundation is complete on local `main` and deployed to staging:

- Pilot application and internal approval flow.
- Employer and SparkFit administrator sign-in using expiring email links.
- Employer portal for individual invitations, pasted lists and CSV uploads.
- Pending invitations reserve seats.
- Verified email invitation activation without employee codes.
- Activation reporting without personal app usage reporting.
- Employee removal and seat recovery.
- Separate employer entitlement ledger and audit history.
- RevenueCat grant, revoke and reconciliation tested with staging writes; production writes are enabled by owner direction.
- Stripe annual checkout, webhooks, Customer Portal and tested renewal failure and recovery. Live product category, price, quantity limit, Managed Payments eligibility, portal, invoice branding, retry and webhook settings have been reviewed; public purchasing is enabled. No live purchase has yet occurred.
- Lifecycle email queue and Resend verification are enabled in staging. A controlled production admin email was received and its signed delivered callback recorded in production D1; failure-path acceptance remains.
- Automated business-data retention and legal-hold safeguards are enabled in production.
- Mobile identity source is on local `main`; compatibility of current store builds with Business entitlement support remains unverified.
- Daily pilot expiry and reminder processing.
- Cloudflare D1 migrations and staging Worker deployment.

Staging URL:

`https://sparkfit-business-platform-staging.colbateson.workers.dev`

Current production flags:

```text
LAUNCH_ENABLED=true
PAYMENTS_ENABLED=true
REVENUECAT_WRITES_ENABLED=true
EMAIL_ENABLED=true
TURNSTILE_REQUIRED=true
RETENTION_ENABLED=true (approved retention policy)
STRIPE_MANAGED_PAYMENTS_ENABLED=true
```

## 2. Work that is still required

### Required before any production employee activation

- Build and install the current local mobile identity changes on iOS and Android, then complete the acceptance steps in `STAGING_SETUP_STATUS.md`.
- Confirm personal purchases remain active through Business activation, removal and restore on both stores.

### Required before public purchase is enabled

- The pilot Turnstile journey has passed. Complete a browser purchase journey with the purchase form's Turnstile challenge and Stripe test Checkout.
- Confirm rate limits for pilot, checkout, sign-in and activation endpoints before production.

### Required before taking money

- Commercial and privacy wording has been approved by the SparkFit owner on 27 November 2026 and published in the Business terms and Business privacy pages. Live payment acceptance is still gated on the first owner-completed Checkout.
- Complete the outstanding Stripe acceptance items in section 9, including a hosted Checkout browser purchase.
- Confirm the annual prices and volume tiers in `src/pricing.js` are commercially approved.
- Test the proposed renewal-only seat reduction schedule against a real Stripe test subscription. Confirm that increases, scheduled changes and cancellation interact correctly before launch.

### Required before production retention is enabled

- Approve the privacy notice and data-processing terms.
- Confirm retention periods, legal hold operations and privacy wording with an adviser.
- The anonymisation routine and legal-hold safeguards are implemented and staging-tested. The approved retention policy is enabled in production.

## 3. Immediate security action

A live Stripe secret was found hard-coded in a separate local MyPT project during the implementation review. Do not copy it into this project. Rotate that key in Stripe immediately, replace it with an environment secret in the MyPT service, remove it from source and inspect its Stripe request history for unexpected use.

SparkFit Business secrets must only be stored with Cloudflare secret commands. Never commit them to Git, `.dev.vars`, screenshots, support messages or documentation.

## 4. Confirm the commercial and privacy policy

The owner-approved operating policy is recorded in [COMMERCIAL_TERMS.md](./COMMERCIAL_TERMS.md), and customer-facing pages are [Business terms](../business/terms.html) and [Business privacy information](../business/privacy.html).

Record written answers for all of these items before enabling checkout:

1. Pilot duration. Current default is 30 days.
2. Pilot capacity. Current maximum is 20 employees.
3. Minimum paid order. Current minimum is 20 seats.
4. Maximum self-service order. Current maximum is 500 seats.
5. Orders above 500 seats. Current route is contact with SparkFit Partnerships.
6. Billing period. Current checkout is annual only.
7. Price basis. Business prices are before applicable transaction tax. Stripe Managed Payments is enabled for eligible transactions and displays calculated tax and final amount in Checkout. SparkFit is not UK VAT registered; Managed Payments acts as merchant of record for supported transactions.
8. Renewal rule. Confirm automatic renewal wording and reminder policy.
9. Cancellation rule. Confirm whether access remains until the paid period ends.
10. Payment failure rule. Set the grace period and the exact access suspension rule.
11. Refund rule. Define who can approve a full or partial refund.
12. Seat reduction rule. Define whether it is immediate or effective at renewal.
13. Employer reporting. Keep this limited to invited, pending, active, expired and removed statuses.
14. Private employee data. Never show workouts, nutrition, weight, measurements, photos, chat or progress to an employer.
15. Retention. The approved periods are recorded in the Business privacy notice. Financial/tax record duration remains subject to applicable law and legal holds.

Update the legal pages and customer-facing wording before the production website is linked.

## 5. Finish the mobile identity implementation

The stable account identity, verified email, RevenueCat UUID migration and separate Business entitlement are implemented locally. The current local `main` changes still need an iOS and Android build and device acceptance before release.

### Account model

Add a backend account with at least:

```text
account_id: immutable UUID
primary_email: normalised email
email_verified_at: timestamp
created_at: timestamp
disabled_at: optional timestamp
```

Use `account_id` as the RevenueCat App User ID on iOS and Android. Do not use email, device ID or an ID supplied by an unauthenticated client.

### Migration for existing app users

1. Ask the existing user to verify the email already stored in the app.
2. Create or retrieve the immutable account ID.
3. Sign in to RevenueCat with that account ID using the SDK's supported customer identification flow.
4. Confirm that the existing purchase history and entitlement state transfer or alias correctly in the RevenueCat test project.
5. Refresh `CustomerInfo` and compare it with the pre-migration state.
6. Store the migration result so the same user is not repeatedly migrated.
7. Provide a support path for duplicate or conflicting accounts.

Test this with anonymous users, email-based users, paid users, trial users, restored purchases and users changing devices.

### Business entitlement access check

The app's effective premium rule must be:

```text
premium access = Pro is active OR Trial is active OR Business is active
```

Do not replace the existing checks. Add `Business` as another route to premium access.

After employee activation, removal, pilot expiry or paid expiry, refresh RevenueCat customer information. The app should also refresh it at launch, after sign-in and when returning to the foreground.

### Invited email differs from an existing account email

Implement an authenticated linking endpoint in the account backend:

1. The employee signs into their existing SparkFit account.
2. They open the one-time invitation link sent to the employer-provided address.
3. The backend verifies the invitation token and the signed-in account.
4. If the addresses differ, the employee confirms that the invitation should be linked to the signed-in account.
5. The server stores the immutable account ID against the membership.
6. RevenueCat receives only the immutable account ID derived by the server.

Do not let the browser submit an arbitrary RevenueCat App User ID.

### Mobile release gate

Do not proceed to production RevenueCat writes until:

- Both iOS and Android use the same stable account identity.
- Email verification works.
- `Pro`, `Trial` and `Business` access have automated tests.
- Store purchase and restore flows still work.
- A released app version containing this logic is available to the intended employees.

## 6. Configure RevenueCat

Use a RevenueCat test project or test identities first.

1. In RevenueCat, create a separate entitlement for employer access.
2. Use a clear identifier such as `Business` and record its internal entitlement ID.
3. Do not attach Business access to the consumer `Pro` entitlement.
4. Create a RevenueCat API v2 secret key with only the customer read and write permission required by this Worker.
5. Record the RevenueCat project ID.
6. Set the staging values:

```sh
cd /Users/col/Projects/sparkfit-website/business-platform
npx wrangler secret put REVENUECAT_SECRET_KEY
```

Add these non-secret staging variables to `wrangler.toml`:

```toml
REVENUECAT_PROJECT_ID = "your_project_id"
REVENUECAT_BUSINESS_ENTITLEMENT_ID = "your_business_entitlement_id"
```

7. Leave `REVENUECAT_WRITES_ENABLED=false` for the first deployment.
8. Activate one internal test employee while writes are disabled and confirm the local ledger is correct.
9. Change the flag to `true`, deploy, and activate a new test employee.
10. Confirm RevenueCat shows only the separate Business grant.
11. Confirm the app unlocks premium access.
12. Remove that employee from the employer portal.
13. Confirm Business access is removed while any personal `Pro` or `Trial` access remains.
14. Run the reconciliation action and confirm it makes no unnecessary changes.

Only then is the RevenueCat integration ready for the full staging test.

## 7. Configure transactional email

Production email setup is now configured on the verified `business-mail.spark-fit.com` domain. The existing `mail.spark-fit.com` belongs to another Resend team and was left untouched. The production sender is `SparkFit Partnerships <partnerships@business-mail.spark-fit.com>` and replies go to the monitored `partnerships@spark-fit.com` inbox. A sending-only key restricted to the verified domain and a webhook signing secret are stored as Cloudflare Worker secrets. The production webhook is subscribed to delivered, bounced, complained, failed and delayed events.

Before enabling production email, keep the customer launch gate closed and perform a controlled internal send to `partnerships@spark-fit.com`. Confirm the message in Inbox and Spam, and confirm the signed delivery callback is recorded. Then test provider failure events. `EMAIL_ENABLED` must remain false until this controlled acceptance succeeds.

For a new environment, use the following steps:

1. Create a dedicated sending subdomain and verify SPF/DKIM with the provider.
2. Create a sender and monitored reply address.
3. Create a domain-restricted sending key and store it as a Worker secret:

```sh
cd /Users/col/Projects/sparkfit-website/business-platform
npx wrangler secret put RESEND_API_KEY --config wrangler.production.toml
```

4. Add the sender variables to the relevant environment:

```toml
EMAIL_FROM = "SparkFit Partnerships <partnerships@business-mail.spark-fit.com>"
EMAIL_REPLY_TO = "partnerships@spark-fit.com"
PARTNERSHIPS_EMAIL = "partnerships@spark-fit.com"
```

5. Keep `EMAIL_ENABLED=false` for initial deployment.
6. Test every email template, links, reply handling, mobile readability, delivery events and spam placement in staging.
7. Confirm that sign-in responses do not reveal whether an email is registered.

Use monitored email addresses during testing. Do not use real employee lists in staging.

## 8. Complete Cloudflare security

### Administrator access

1. Create a long random admin API token.
2. Store it with:

```sh
npx wrangler secret put ADMIN_API_TOKEN
```

3. Add a comma-separated allowlist:

```toml
ADMIN_EMAILS = "approved.admin@spark-fit.com"
```

4. Test that an allowlisted address can sign in.
5. Test that an unlisted address receives no usable session.
6. Use individual addresses rather than a broad email domain.

### Turnstile

The staging widgets, token verification, staging hostname and required flag are configured. Before production, create a separate Turnstile widget for `business.spark-fit.com`, set its public site key and allowed hostname in the production config, store its secret with `wrangler secret put TURNSTILE_SECRET_KEY --config wrangler.production.toml`, then test valid, missing, expired and reused tokens before opening public forms.

### Rate limiting

Add Cloudflare rate limiting for at least:

- `POST /v1/pilot-applications`
- `POST /v1/checkout/sessions`
- `POST /v1/auth/request`
- Invitation activation requests

Start with conservative per-IP limits and log blocked requests. Ensure shared company networks are not permanently locked out. Test the configured limits before production.

### Custom hostnames

Use separate hostnames for staging and production, for example:

```text
business-staging.spark-fit.com
business.spark-fit.com
```

Keep staging protected from indexing. Update `PUBLIC_APP_ORIGIN` and the Turnstile hostname whenever the public hostname changes.

## 9. Configure and test Stripe

Production uses Stripe Managed Payments for eligible employer Checkout. Keep the public launch and employee provisioning gates closed until the owner has reviewed and submitted the first live Checkout and completed final acceptance.

### Stripe account configuration

1. Confirm the SparkFit legal entity and bank details.
2. Keep Stripe Billing `automatic_tax` and tax-ID collection disabled on Managed Payments Checkout. Managed Payments calculates transaction taxes and shows the total to the buyer. Do not describe the seller as VAT-free.
3. Configure the Customer Portal for payment method changes, invoices and the approved cancellation policy.
4. Confirm customer emails and invoice branding.
5. Confirm the statement descriptor and support contact.
6. Decide whether Stripe should automatically retry failed payments and for how long.
7. Managed Payments is enabled by default in the live Stripe Dashboard and eligible product. The product is classified as `txcd_10103101` (SaaS with mobile app/plugin, business use). Managed Payments acts as merchant of record for supported transactions and handles applicable tax, transaction emails, fraud, disputes and transaction-level support. The Worker passes `managed_payments[enabled]=true`; its Checkout omits tax-ID collection and `automatic_tax`.

### Worker secrets

Set test secrets in the staging Worker:

```sh
cd /Users/col/Projects/sparkfit-website/business-platform
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

Create the webhook endpoint using the staging hostname and subscribe to:

```text
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
invoice.paid
invoice.payment_failed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
charge.dispute.created
charge.refunded
radar.early_fraud_warning.created
```

Keep `PAYMENTS_ENABLED=false` until the webhook endpoint verifies successfully. `STRIPE_MANAGED_PAYMENTS_ENABLED` is a separate setting and stays `false` for standard employer billing.

### Stripe test checklist

Test every item:

1. Purchase 20 seats.
2. Purchase 50 seats.
3. Purchase 500 seats.
4. Confirm a request above 500 routes to Partnerships instead of checkout.
5. Confirm the displayed guide price matches the server-created Stripe line item.
6. Confirm the live Checkout displays any applicable tax and the final amount due, and that the invoice reflects the Managed Payments transaction.
7. Complete a successful payment.
8. Confirm the organisation and subscription are created once.
9. Replay the same webhook and confirm it is idempotent.
10. Deliver webhooks out of order and confirm the final state is correct.
11. Simulate a failed payment and confirm the approved grace policy.
12. Recover the payment and confirm access returns correctly.
13. Increase seat quantity and verify proration follows the approved rule.
14. Reduce seat quantity when active seats exceed the requested amount and confirm the portal blocks or clearly resolves it.
15. Cancel in the Customer Portal and confirm access ends at the approved time.
16. Confirm invoices and receipts reach the billing contact.
17. Confirm no client request can override the server pricing table.

After the standard test items pass, set `PAYMENTS_ENABLED=true` in staging and repeat the complete purchase journey once more with test payment methods. To test Managed Payments, separately set `STRIPE_MANAGED_PAYMENTS_ENABLED=true`, confirm `managed_payments[enabled]=true`, confirm automatic tax and tax ID collection are omitted, and test the product, tax calculation, customer name/address collection, invoices, subscription lifecycle, receipts and support path. Return the flag to `false` after the test if SparkFit has not approved Managed Payments for employer sales.

## 10. Full staging acceptance test

Use two test employees:

- Employee A has no consumer purchase.
- Employee B already has a personal consumer `Pro` subscription.

Run this exact sequence:

1. Submit a valid pilot application.
2. Submit invalid data and confirm validation is clear.
3. Confirm `www.google.com` and a full `https://` company URL are accepted and normalised.
4. Sign into the admin portal and approve a 30-day, 20-seat pilot.
5. Sign into the employer portal.
6. Invite Employee A.
7. Confirm the pending invitation reserves one seat.
8. Resend the invitation.
9. Correct a deliberately mistyped invitation.
10. Cancel an invitation and confirm the seat returns.
11. Upload a CSV containing valid, duplicate and invalid addresses.
12. Confirm duplicates are not double counted.
13. Activate Employee A through the emailed link.
14. Confirm the employer sees activation status and no usage information.
15. Confirm Employee A receives Business access in the app.
16. Invite and activate Employee B.
17. Remove Employee B.
18. Confirm Employee B keeps personal `Pro` access.
19. Remove Employee A and confirm the seat returns.
20. Reinvite Employee A and confirm reactivation works.
21. Attempt concurrent invitations at the seat limit and confirm the database never exceeds capacity.
22. Trigger 7-day and 3-day pilot reminders.
23. Expire the pilot and confirm Business access ends.
24. Extend the pilot and confirm the intended access state returns.
25. Convert the organisation to paid access using Stripe test mode.
26. Open the Customer Portal and change the subscription as permitted.
27. Review all audit events, email deliveries and webhook records.
28. Confirm secrets and personal invitation tokens do not appear in logs.

Repeat the employee activation, removal and restore cases on both iOS and Android.

## 11. Current production state and post-launch checks

Production D1 migrations `0001` through `0009` are applied. The production Worker is deployed to `business.spark-fit.com`; launch, public payments and RevenueCat writes are on by explicit owner direction. Approved transactional email and retention are on. `/health` verifies production, payments enabled, RevenueCat writes enabled and email enabled. Public config verifies `testMode=false`, payments enabled, Turnstile required and app accounts required.

The production Turnstile hostname and keys, live Stripe product/price and restricted credentials, RevenueCat credentials, and verified Resend domain and credentials have been configured. Live Stripe has an active £20.83/year base price; the Worker calculates volume prices from the approved server-side schedule. The live product uses tax category `txcd_10103101`; Managed Payments is enabled. The active webhook has 11 required events. The Customer Portal enables payment-method updates, invoice access/downloads and end-of-period cancellation, with plan changes disabled. Invoice colours use SparkFit purple; Stripe has no uploaded SparkFit logo yet. Smart Retries run for up to 8 attempts over 2 weeks, and the final failure action leaves the subscription overdue so SparkFit can apply day-14 suspension/day-30 closure. Secret values are stored in Cloudflare and must never be copied into source or chat.

The owner opened production before the remaining checks below. Complete them promptly and use the rollback plan if a live check fails:

1. Verify the public config, required environment bindings and secret names without displaying secret values.
2. Successful production email delivery and its signed delivered callback are confirmed. Review spam placement and provider-supported failed, bounced and complained message scenarios.
3. Live Stripe settings, published Terms/Privacy links, tax behavior, 20–500 server-validated quantity and 11-event webhook coverage have been reviewed. The owner waived the internal live purchase; monitor the first customer checkout, tax, invoice and payment webhook.
4. Acceptance-test the current iOS and Android app builds for UUID identity and Business entitlement support. If activation fails, disable RevenueCat writes and employee invitation/activation routes until fixed.
5. Run a controlled internal employee grant/removal, verify reconciliation, and confirm personal Pro/Trial access survives removal.
6. Public routes and payments are already enabled. Monitor webhooks, email delivery, billing and entitlement reconciliation closely.

## 12. Production launch order

Use this order so old mobile builds are not given access they cannot understand:

1. Build, install and accept the stable account and Business entitlement mobile update on iOS and Android, then release it.
2. Confirm the minimum supported app version is installed by pilot testers.
3. Deploy the production Worker with all side effects disabled.
4. Verify production database, hostnames, authentication and logs.
5. Enable outgoing email and test one internal invitation.
6. Enable Turnstile and rate limiting.
7. Enable RevenueCat writes and activate one internal employee.
8. Remove the internal employee and verify personal access is untouched.
9. Enable Stripe payments and complete one low-volume live purchase using an approved real payment method.
10. Refund or retain that test purchase according to the approved finance process.
11. Update the main business website links from staging URLs to `https://business.spark-fit.com`.
12. Deploy the website.
13. Open the pilot and paid routes to external organisations.
14. Monitor every activation, webhook and email delivery closely for the first 48 hours.

Do not change the existing `revcat-sparkfit-trial-worker` as part of this launch. It is a separate consumer trial service. Plan its authentication and rate-limiting hardening as a separate tested release.

## 13. Rollback plan

If email, payment or entitlement behaviour is wrong:

1. Set the relevant feature flag to `false` and deploy immediately.
2. Do not delete the D1 database or audit records.
3. Roll the Worker back to the last known good version in Cloudflare if necessary.
4. Keep the employer portal read-only or display a maintenance notice while resolving the issue.
5. For a RevenueCat incident, reconcile the employer ledger against the exact stored RevenueCat account mapping.
6. Never remove `Pro` or `Trial` to correct a Business incident.
7. For a Stripe incident, disable new checkout before modifying subscriptions.
8. Record affected organisation IDs, membership IDs, Stripe event IDs and timestamps.
9. Notify affected customers using the approved incident process.
10. Test the correction in staging before restoring the production flag.

## 14. Launch acceptance gate

Production is open by owner direction, with these checks outstanding or waived:

- [x] Commercial and legal terms are approved, published, and linked from Stripe.
- [x] Data retention and deletion rules are implemented, approved, and enabled.
- [ ] The exposed MyPT Stripe key has been rotated and removed from source.
- [ ] Stable app accounts and verified email are confirmed in the current iOS and Android builds.
- [ ] Existing paid and trial customers migrate without losing access.
- [ ] The app recognises the separate Business entitlement.
- [ ] Different-email invitation linking works safely.
- [ ] RevenueCat grant and revoke tests preserve consumer access.
- [ ] Email domain authentication and all templates pass delivery tests; successful production delivery is confirmed, while spam and failure-path review remain.
- [ ] Turnstile is present on both public forms.
- [ ] Public API rate limiting is active.
- [ ] Stripe test mode lifecycle tests all pass.
- [ ] Concurrent seat-limit tests pass.
- [ ] Employer reports contain activation status only.
- [ ] Production D1 is separate from staging.
- [ ] Production secrets are stored only in Cloudflare.
- [ ] Rollback has been rehearsed.
- [ ] One internal live employee journey passes.
- [ ] First live billing journey passes; the owner waived the internal purchase, so observe and verify the first customer transaction.
- [ ] The business website points only to the production hostname.

## 15. Routine operation after launch

Daily:

- Review failed email deliveries.
- Review failed and repeatedly retried Stripe webhooks.
- Review RevenueCat reconciliation failures.
- Review unusual sign-in or form submission rates.

Weekly:

- Review pilots approaching expiry.
- Review paid organisations near their seat limits.
- Review invitations that remain pending.
- Review administrator audit events.

Monthly:

- Reconcile Stripe subscriptions with the organisation ledger.
- Reconcile active Business grants with active memberships.
- Review data scheduled for deletion under the retention policy.
- Review rate limits, error rates and support themes.
- Export finance reports using the approved finance process.

## 16. Local verification commands

Before every deployment:

```sh
cd /Users/col/Projects/sparkfit-website
npm test
node --check business-platform/src/index.js
rg -P '\x{2014}|\x{2013}' business-platform business/index.html
git diff --check
git status --short
```

The `rg` command should return no matches. SparkFit customer-facing content must not use em dashes or en dashes.

Deploy staging only after tests pass:

```sh
cd /Users/col/Projects/sparkfit-website/business-platform
npx wrangler d1 migrations apply sparkfit-business-staging --remote
npx wrangler deploy
```

Check the deployed health endpoint:

```sh
curl https://sparkfit-business-platform-staging.colbateson.workers.dev/health
```

Confirm the returned flags match the action you intended. A deployment is not approval to enable a side effect.
