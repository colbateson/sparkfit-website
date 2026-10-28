# SparkFit Partnerships deployment notes

The business page is isolated under `/business/`; the consumer homepage is unchanged.

## Cloudflare lead capture

`/functions/api/business-enquiry.js` is a Cloudflare Pages Function. Configure these production secrets/variables:

- `RESEND_API_KEY` — API key for the verified `spark-fit.com` sending domain.
- `TURNSTILE_REQUIRED` — optional; set to `true` only after a Turnstile widget has been configured in the form.
- `TURNSTILE_SECRET_KEY` — required only when `TURNSTILE_REQUIRED=true`.

The endpoint validates origin, content type, field lengths, allowed enquiry types, positive licence/employee quantities, privacy acceptance and a honeypot. It sends the internal notification and acknowledgement from `partnerships@spark-fit.com`; the internal notification goes only to `partnerships@spark-fit.com` and includes the selected enquiry type.

Resend must verify the `spark-fit.com` domain before production email delivery. Cloudflare rate limiting should also be applied to `POST /api/business-enquiry` at deployment level.
