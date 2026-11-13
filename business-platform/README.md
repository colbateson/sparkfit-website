# SparkFit Business Platform

This directory contains the isolated Cloudflare staging implementation for employer pilots, annual employer subscriptions, reusable employee seats, email invitation activation, employer and admin portals, Stripe lifecycle handling, RevenueCat business entitlement reconciliation, lifecycle emails and audit logging.

## Staging deployment

- Worker: `sparkfit-business-platform-staging`
- Database: `sparkfit-business-staging`
- URL: `https://sparkfit-business-platform-staging.colbateson.workers.dev`
- Cron: daily at 08:15 UTC

The staging configuration deliberately sets payments, outgoing email, RevenueCat writes and mandatory Turnstile verification to `false`. Do not change those flags until the corresponding test credentials, product configuration and review steps are complete.

## Identity and entitlement policy

The current mobile release identifies RevenueCat customers using the normalised email collected during onboarding. Employer eligibility is therefore matched by verified invited email. The activation endpoint does not accept a client-supplied email or RevenueCat App User ID. It derives the current RevenueCat identity from the server-side invitation after the employee proves possession of the one-time emailed link.

The membership stores both the exact RevenueCat identity used at activation and an internal account reference. Revocation uses the stored mapping, not the employee's current email. The separate RevenueCat Business entitlement is reconciled from the employer entitlement ledger. Consumer `Pro` and onboarding `Trial` access are never revoked by this service.

Before production, the mobile app needs a stable authenticated account ID and verified-email service. That migration is required to support linking an invited second email to an existing account and to remain stable after account email changes. Until that release exists, production RevenueCat writes must stay disabled.

## Commands

```sh
npm test
cd business-platform
npx wrangler d1 migrations apply sparkfit-business-staging --remote
npx wrangler deploy
```

## Required secrets

Add secrets with `wrangler secret put` only. Never add them to this repository.

- `ADMIN_API_TOKEN`
- `RESEND_API_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `REVENUECAT_SECRET_KEY`
- `TURNSTILE_SECRET_KEY`

Required non-secret production variables include `ADMIN_EMAILS`, `REVENUECAT_PROJECT_ID`, `REVENUECAT_BUSINESS_ENTITLEMENT_ID`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `PARTNERSHIPS_EMAIL` and the approved public application origin.

## Safe production sequence

1. Approve pilot terms, pricing, VAT treatment, cancellation policy, payment-failure grace policy and privacy wording.
2. Implement and release stable authenticated app accounts with verified email and support for the separate Business entitlement.
3. Create the separate RevenueCat Business entitlement and test with non-production identities.
4. Configure a verified email sender and run invitation delivery tests.
5. Configure Stripe test mode, automatic tax, Customer Portal and webhook delivery. Complete the full lifecycle in test mode.
6. Enable Turnstile and rate limiting.
7. Run employer and employee acceptance tests on iOS and Android.
8. Create production D1 and Worker environments with production secrets.
9. Deploy the website links to the production Worker hostname.
10. Enable production side effects one at a time, with logs and rollback available.

The existing `revcat-sparkfit-trial-worker` is not modified by this implementation. Its consumer trial route remains a separate production dependency until regression coverage and a safe hardening deployment are approved.

## Production implementation guide

Follow [PRODUCTION_RUNBOOK.md](./PRODUCTION_RUNBOOK.md) for the complete ordered implementation, test, launch and rollback process. Start with the mobile identity work. RevenueCat writes must remain disabled until stable authenticated app accounts and verified email are released on both mobile platforms.

Use `wrangler.production.example.toml` as the safe starting point for the production Worker configuration. It intentionally keeps every external side effect disabled and contains no secrets.
