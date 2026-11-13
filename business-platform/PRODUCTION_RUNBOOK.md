# SparkFit Business Production Runbook

This is the ordered implementation and launch guide for SparkFit Business. Follow it from top to bottom. Do not enable payments, outgoing email or RevenueCat writes until the relevant acceptance gate says it is safe.

## 1. Current position

The following foundation is complete on the staging branch:

- Pilot application and internal approval flow.
- Employer and SparkFit administrator sign-in using expiring email links.
- Employer portal for individual invitations, pasted lists and CSV uploads.
- Pending invitations reserve seats.
- Verified email invitation activation without employee codes.
- Activation reporting without personal app usage reporting.
- Employee removal and seat recovery.
- Separate employer entitlement ledger and audit history.
- RevenueCat grant, revoke and reconciliation integration behind a disabled flag.
- Stripe annual checkout, webhook and Customer Portal integration behind a disabled flag.
- Lifecycle email queue behind a disabled flag.
- Daily pilot expiry and reminder processing.
- Cloudflare D1 migrations and staging Worker deployment.

Staging URL:

`https://sparkfit-business-platform-staging.colbateson.workers.dev`

The safety flags are deliberately disabled:

```text
PAYMENTS_ENABLED=false
REVENUECAT_WRITES_ENABLED=false
EMAIL_ENABLED=false
TURNSTILE_REQUIRED=false
```

## 2. Work that is still required

### Required before any production employee activation

- Add stable authenticated SparkFit accounts to the iOS and Android apps.
- Give each account a non-guessable immutable ID, such as a UUID.
- Verify account email addresses.
- Migrate RevenueCat identification away from email addresses to the immutable account ID.
- Add the separate RevenueCat Business entitlement to the app's premium access check.
- Add the safe flow for an invited employee whose existing SparkFit account uses another email address.
- Test that removing Business access never removes a separately purchased `Pro` entitlement or an existing `Trial` entitlement.

### Required before a public form is protected by Turnstile

- Render the Cloudflare Turnstile widget on the pilot and purchase forms.
- Send its response token as `turnstileToken` in each API request.
- Add a real Cloudflare rate-limiting binding or rule for public submission and sign-in endpoints.
- Keep `TURNSTILE_REQUIRED=false` until the widget is deployed and verified.

### Required before taking money

- Agree final commercial terms, VAT wording, refunds, cancellation rules, payment-failure grace period and renewal wording.
- Configure Stripe in test mode and complete every lifecycle test in section 9.
- Confirm the annual prices and volume tiers in `src/pricing.js` are commercially approved.
- Decide whether a seat reduction takes effect immediately or at renewal. The current implementation sends the requested subscription item quantity to Stripe.

### Required before production data is retained

- Approve the privacy notice and data-processing terms.
- Define retention periods for applications, invitations, audit events and billing records.
- Implement the approved deletion or anonymisation routine.
- Document who may use the SparkFit administrator portal.

## 3. Immediate security action

A live Stripe secret was found hard-coded in a separate local MyPT project during the implementation review. Do not copy it into this project. Rotate that key in Stripe immediately, replace it with an environment secret in the MyPT service, remove it from source and inspect its Stripe request history for unexpected use.

SparkFit Business secrets must only be stored with Cloudflare secret commands. Never commit them to Git, `.dev.vars`, screenshots, support messages or documentation.

## 4. Confirm the commercial and privacy policy

Record written answers for all of these items before enabling checkout:

1. Pilot duration. Current default is 30 days.
2. Pilot capacity. Current maximum is 20 employees.
3. Minimum paid order. Current minimum is 20 seats.
4. Maximum self-service order. Current maximum is 500 seats.
5. Orders above 500 seats. Current route is contact with SparkFit Partnerships.
6. Billing period. Current checkout is annual only.
7. Price basis. Business prices exclude VAT and Stripe adds applicable tax.
8. Renewal rule. Confirm automatic renewal wording and reminder policy.
9. Cancellation rule. Confirm whether access remains until the paid period ends.
10. Payment failure rule. Set the grace period and the exact access suspension rule.
11. Refund rule. Define who can approve a full or partial refund.
12. Seat reduction rule. Define whether it is immediate or effective at renewal.
13. Employer reporting. Keep this limited to invited, pending, active, expired and removed statuses.
14. Private employee data. Never show workouts, nutrition, weight, measurements, photos, chat or progress to an employer.
15. Retention. Approve specific periods for unsuccessful applications, expired invitations, ended organisations and audit records.

Update the legal pages and customer-facing wording before the production website is linked.

## 5. Finish the mobile identity implementation

This is the most important prerequisite. The current app identifies RevenueCat customers using a normalised onboarding email. Email is mutable and is not a safe long-term account identifier.

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

1. Create or use a dedicated sending subdomain, for example `mail.spark-fit.com`.
2. Verify the domain with the email provider and publish the required SPF and DKIM records.
3. Create a sender such as `SparkFit Partnerships <partnerships@mail.spark-fit.com>`.
4. Use `partnerships@spark-fit.com` as the reply address if that mailbox is monitored.
5. Create the Resend API key.
6. Set it as a Cloudflare secret:

```sh
cd /Users/col/Projects/sparkfit-website/business-platform
npx wrangler secret put RESEND_API_KEY
```

7. Add these variables to staging:

```toml
EMAIL_FROM = "SparkFit Partnerships <partnerships@mail.spark-fit.com>"
EMAIL_REPLY_TO = "partnerships@spark-fit.com"
PARTNERSHIPS_EMAIL = "partnerships@spark-fit.com"
```

8. Keep `EMAIL_ENABLED=false` for the first deployment.
9. Submit a pilot application and inspect the email outbox in D1.
10. Enable email in staging and deploy.
11. Test pilot received, approval, rejection, sign-in, employee invitation, pilot reminder and pilot expiry messages.
12. Verify links, sender alignment, reply handling, plain text readability, mobile readability, delivery events and spam placement.
13. Confirm that sign-in responses do not reveal whether an email is registered.

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

Before making Turnstile mandatory, add the widget and token handling to both public forms.

1. Create a Turnstile widget for the staging hostname.
2. Add the public site key as a non-secret variable.
3. Render the widget in `/pilot/` and `/buy/`.
4. Include its token as `turnstileToken` in the JSON submission.
5. Store the secret with:

```sh
npx wrangler secret put TURNSTILE_SECRET_KEY
```

6. Test valid, missing, expired and reused tokens.
7. Only after those tests pass, set `TURNSTILE_REQUIRED=true`.

### Rate limiting

Add Cloudflare rate limiting for at least:

- `POST /api/pilot-applications`
- `POST /api/checkout`
- `POST /api/auth/request-link`
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

Complete this section in Stripe test mode first.

### Stripe account configuration

1. Confirm the SparkFit legal entity and bank details.
2. Enable Stripe Tax or approve an alternative tax calculation process.
3. Configure the Customer Portal for payment method changes, invoices and the approved cancellation policy.
4. Confirm customer emails and invoice branding.
5. Confirm the statement descriptor and support contact.
6. Decide whether Stripe should automatically retry failed payments and for how long.

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
invoice.paid
invoice.payment_failed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
```

Keep `PAYMENTS_ENABLED=false` until the webhook endpoint verifies successfully.

### Stripe test checklist

Test every item:

1. Purchase 20 seats.
2. Purchase 50 seats.
3. Purchase 500 seats.
4. Confirm a request above 500 routes to Partnerships instead of checkout.
5. Confirm the displayed guide price matches the server-created Stripe line item.
6. Confirm VAT is calculated and displayed correctly.
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

After all tests pass, enable `PAYMENTS_ENABLED=true` in staging and repeat the complete purchase journey once more.

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

## 11. Create the production Cloudflare environment

Do not reuse the staging database for production.

1. Copy `wrangler.production.example.toml` to `wrangler.production.toml`.
2. Keep `wrangler.production.toml` out of Git if it contains environment-specific identifiers.
3. Create the production D1 database:

```sh
cd /Users/col/Projects/sparkfit-website/business-platform
npx wrangler d1 create sparkfit-business-production
```

4. Put the returned database ID into the production configuration.
5. Apply all migrations:

```sh
npx wrangler d1 migrations apply sparkfit-business-production --remote --config wrangler.production.toml
```

6. Add every production secret using the production configuration:

```sh
npx wrangler secret put ADMIN_API_TOKEN --config wrangler.production.toml
npx wrangler secret put RESEND_API_KEY --config wrangler.production.toml
npx wrangler secret put STRIPE_SECRET_KEY --config wrangler.production.toml
npx wrangler secret put STRIPE_WEBHOOK_SECRET --config wrangler.production.toml
npx wrangler secret put REVENUECAT_SECRET_KEY --config wrangler.production.toml
npx wrangler secret put TURNSTILE_SECRET_KEY --config wrangler.production.toml
```

7. Deploy production first with all side-effect flags set to `false`:

```sh
npx wrangler deploy --config wrangler.production.toml
```

8. Attach `business.spark-fit.com` as the custom domain.
9. Confirm `/health`, static assets, form validation, sign-in and database access.
10. Configure the production Stripe webhook using the final hostname.
11. Configure Turnstile for the final hostname.

## 12. Production launch order

Use this order so old mobile builds are not given access they cannot understand:

1. Release the stable account and Business entitlement mobile update.
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

Production is ready only when every item is true:

- [ ] Commercial and legal terms are approved.
- [ ] Data retention and deletion rules are implemented.
- [ ] The exposed MyPT Stripe key has been rotated and removed from source.
- [ ] Stable app accounts and verified email are released on iOS and Android.
- [ ] Existing paid and trial customers migrate without losing access.
- [ ] The app recognises the separate Business entitlement.
- [ ] Different-email invitation linking works safely.
- [ ] RevenueCat grant and revoke tests preserve consumer access.
- [ ] Email domain authentication and all templates pass delivery tests.
- [ ] Turnstile is present on both public forms.
- [ ] Public API rate limiting is active.
- [ ] Stripe test mode lifecycle tests all pass.
- [ ] Concurrent seat-limit tests pass.
- [ ] Employer reports contain activation status only.
- [ ] Production D1 is separate from staging.
- [ ] Production secrets are stored only in Cloudflare.
- [ ] Rollback has been rehearsed.
- [ ] One internal live employee journey passes.
- [ ] One approved live billing journey passes.
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
