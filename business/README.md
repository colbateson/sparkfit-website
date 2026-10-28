# SparkFit Partnerships deployment notes

The business page is isolated under `/business/`; the consumer homepage is unchanged.

## Enquiry handoff on GitHub Pages

The live site is served by GitHub Pages, so it cannot execute the Cloudflare Pages Function in this repository. The business form validates the enquiry in the browser, then opens a pre-filled email to `partnerships@spark-fit.com` for the visitor to review and send.

## Optional Cloudflare lead capture

`/functions/api/business-enquiry.js` is retained for a future deployment on Cloudflare Pages or another compatible Functions host. If that deployment route is adopted, configure these production secrets/variables and reconnect the form to `/api/business-enquiry`:

- `RESEND_API_KEY`: API key for the verified `spark-fit.com` sending domain.
- `TURNSTILE_REQUIRED`: optional; set to `true` only after a Turnstile widget has been configured in the form.
- `TURNSTILE_SECRET_KEY`: required only when `TURNSTILE_REQUIRED=true`.

The endpoint validates origin, content type, field lengths, allowed enquiry types, positive licence/employee quantities, privacy acceptance and a honeypot. It sends the internal notification and acknowledgement from `partnerships@spark-fit.com`; the internal notification goes only to `partnerships@spark-fit.com` and includes the selected enquiry type.

Resend must verify the `spark-fit.com` domain before production email delivery. Cloudflare rate limiting should also be applied to `POST /api/business-enquiry` at deployment level.
