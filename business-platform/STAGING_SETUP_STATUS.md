# SparkFit Business implementation status and completion guide

Updated 16 November 2026. Staging is deployed; production is not launched.

## Current position

Staging: https://business-staging.spark-fit.com

Latest Worker version: `5ba977dc-2d17-4985-8a0b-68b7afd812fb`.
Migrations `0001` through `0008` are applied to the staging D1 database.

| Feature | Position |
| --- | --- |
| Pilot | 30 days, up to 20 employees, approval required, no automatic payment |
| Employer portal | Email sign-in, invitations, activation reporting and removal tested |
| Employee privacy | Reports expose activation status, never personal app activity |
| Identity backend | Stable UUID, verified email and one-use account exchange tested |
| RevenueCat | Scoped Customers read/write key encrypted; real Business grant and removal tested |
| Email | Verified domain, restricted sending key and webhook secret encrypted |
| Turnstile | Enabled for both staging hostnames; protected pilot browser submission passed |
| Rate limits | Persisted limits on pilot, Checkout, sign-in and activation |
| Stripe | Test account, annual product, webhook and Customer Portal configured |
| Public purchasing | Disabled pending remaining billing acceptance |
| VAT | No VAT charged because SparkFit confirmed it is not VAT registered |
| Mobile release | Identity branch exists; physical iOS and Android acceptance outstanding |
| Production | Separate infrastructure, live settings and launch acceptance outstanding |

Staging email and RevenueCat writes are enabled in source configuration. Email is restricted to partnerships@spark-fit.com. `PAYMENTS_ENABLED=false`. Production configuration keeps external side effects disabled.

## Evidence and limits

- 33 website/platform checks and 10 SQLite-backed flow tests passed.
- Real deployed pilot: administrator sign-in, approval, employer sign-in, stable verified account, Business grant, activation-only reporting, Business removal and re-invitation.
- Real Stripe sandbox: Checkout creation for 20, 50 and 500 seats, successful payment, zero added VAT, Customer Portal, paid prorated increase with tier repricing, renewal reduction schedule and period-end cancellation.
- Real deployed Stripe webhook: paid organisation created once; older replay did not undo cancellation; access retained during paid term; subscription removal suspended employer access.
- Real protected browser pilot submission accepted `www.spark-fit.com`. Test application: `pilot_078555176dc44fb8881e8ac348f10fa7`.
- Database guards prevent subsequent invitations exceeding a scheduled renewal reduction.
- Signed email callback tests reject tampering, deduplicate retries and prevent older delivery notifications overwriting a bounce. Real Resend callbacks recorded delivery for sign-in, approval, invitation and account verification in the latest deployed pilot journey.
- Both pilot and purchase pages produced Turnstile tokens in the browser. Only the pilot submission has completed its protected browser journey; public Checkout remains disabled.

Reports: [Stripe sandbox](./STRIPE_SANDBOX_RESULTS.json), [employee flow](./STAGING_FLOW_RESULTS.json), [deployed billing flow](./STAGING_BILLING_RESULTS.json), [email template delivery](./STAGING_EMAIL_RESULTS.json).

Checkout creation is not a completed browser purchase at every quantity. Provider email acceptance does not prove inbox placement. Personal Pro preservation passed a provider-stub test, but still needs a real store purchase on physical mobile devices.

## Service configuration

- Worker: `sparkfit-business-platform-staging`.
- RevenueCat project: `proj6f23ac58`; internal Business ID: `entl736559a420`; app identifier: `business`.
- Resend: verified `mail.spark-fit.com`, Ireland.
- Sender: `SparkFit Partnerships <partnerships@mail.spark-fit.com>`; replies: `partnerships@spark-fit.com`.
- Email webhook: `https://business-staging.spark-fit.com/v1/webhooks/resend`. Delivery, delay, bounce, complaint and failure only, without open/click tracking.
- Stripe sandbox: `acct_1UblTe2SRn2PAsMs`.
- Product: `prod_VdSiz9mECAEbw3`; portal: `bpc_1Uc7312SRn2PAsMsKTgnOiqM`.
- Stripe webhook: `https://sparkfit-business-platform-staging.colbateson.workers.dev/v1/webhooks/stripe`.
- Lifecycle and reconciliation run every five minutes.

The first email callback arrived before its signing secret was installed and returned 503. After installation, a real signed delivery replay was accepted and recorded in `email_delivery_events`.

## Remaining work, in order

### 1. Complete email acceptance

1. Real delivery callbacks now update the outbox. Verify each remaining delivery state in the employer portal.
2. Exercise provider bounce, complaint, delay and failure events.
3. Twelve labelled template previews have provider-confirmed delivery, one send attempt each. Review their wording and presentation, and separately trigger lifecycle-specific rejection, expiry, renewal and payment-attention messages. Previews do not demonstrate lifecycle timing.
4. Mailbox owner: check inbox/spam placement and reply handling.
5. Consolidate duplicate `_dmarc.spark-fit.com` TXT records into one approved policy. Existing records showed `p=none` and `p=quarantine`; neither was removed. Preserve Google Workspace mail records.

### 2. Finish billing acceptance

1. Use Stripe test clocks for failed annual renewal, recovery, 14-day grace expiry and restoration against the deployed ledger.
2. Verify Dashboard retry/reminder settings, invoice branding, invoice emails and receipt delivery.
3. Enable staging test payments for acceptance and repeat the browser journey through Turnstile, hosted Checkout, success polling, employer sign-in and employee invitation.
4. Verify unpaid seat increases do not release seats, repeated requests converge, and reductions remain correct through renewal.
5. Exercise refund, dispute and fraud review workflows.
6. Keep automatic tax disabled while SparkFit is not VAT registered. Revisit registration before any tax change.

### 3. Test and release mobile identity

Mobile repo: `/Users/col/Projects/sparkfit`, branch `codex/business-account-identity`.

1. Build and install on physical iOS and Android devices.
2. Use one new account and one existing customer with a real personal Pro purchase.
3. Verify UUID persistence after sign-in/reinstall, email verification and migration from the existing RevenueCat identity.
4. Follow invitation links from each device's mail app, including an invitation to a different email from the existing account.
5. Confirm linking requires authentication and explicit confirmation, without creating a duplicate customer.
6. Grant, refresh and remove Business; verify personal Pro after removal, app restart and purchase restoration.
7. Release the tested identity update before opening employer access publicly.

### 4. Finish operational safeguards

1. Implement and test automated retention/anonymisation. A proposed schedule exists; automatic deletion is not yet implemented.
2. Review commercial terms, privacy notices and employer agreement. Some refunds, reminders and retry settings remain operational procedures.
3. Rotate the Stripe test secret pasted in chat and update staging. Prefer a restricted key with only required permissions.
4. Rehearse rollback and alerts for failed webhooks, email delivery and RevenueCat reconciliation.

### 5. Launch production

Follow [PRODUCTION_RUNBOOK.md](./PRODUCTION_RUNBOOK.md), sections 11 to 14.

1. Create separate production Worker and D1, apply migrations and bind `business.spark-fit.com`.
2. Configure live Stripe product, portal and webhook, production Turnstile and production-scoped secrets.
3. Deploy initially with external side effects disabled; verify health and authentication.
4. Enable and test production email, then Business access for an internal employee.
5. After mobile and billing acceptance, enable live purchasing and complete one approved real payment.
6. Update the main website to production links and deploy. Local copy changes do not prove the public website has been updated.

## Commands

No Homebrew repair is required. Official Stripe CLI 1.55.11 is installed temporarily at `/private/tmp/stripe-cli-1.55.11/stripe` and authenticated to SparkFit test mode. macOS may clear the temporary directory later.

```sh
cd /Users/col/Projects/sparkfit-website
npm test
npm run test:e2e --prefix business-platform
git diff --check
```

Deploy staging after tests:

```sh
cd /Users/col/Projects/sparkfit-website/business-platform
npx wrangler d1 migrations apply sparkfit-business-staging --remote
npx wrangler deploy
curl https://business-staging.spark-fit.com/health
curl https://business-staging.spark-fit.com/v1/public-config
```

To rerun `test-staging-flow.mjs` with mandatory Turnstile, submit a disposable E2E pilot through the browser, then set `STAGING_TEST_APPLICATION_ID` to its reference when running the script. Alternatively supply a fresh `TURNSTILE_TOKEN`. The script checks that an existing application belongs to the monitored staging address and is labelled as a test. Never disable protection just to make a test pass.

Never put keys or invitation tokens in Git, this guide or logs. Stripe's plugin is installed, but the requested planner remained unavailable. Implementation used official documentation skills and the CLI; no generated planner result is claimed.
