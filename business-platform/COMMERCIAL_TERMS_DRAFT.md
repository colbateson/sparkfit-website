# SparkFit Business Commercial Policy Draft

Status: proposed operating policy for legal, tax and commercial review before launch.

This document turns the agreed product model into practical default rules for Stripe Billing, the employer agreement and customer support. It is not a substitute for legal or tax advice.

## Confirmed product model

- Pilot length: 30 calendar days.
- Pilot capacity: up to 20 employees.
- Pilot payment: no payment details and no automatic paid conversion.
- Minimum paid order: 20 employee seats.
- Maximum self-service order: 500 employee seats.
- Larger orders: quoted by SparkFit Partnerships.
- Paid billing period: annual.
- Business pricing: quoted excluding VAT, with applicable VAT added at checkout.
- Employer reporting: invitation and activation status only.
- Employee activity and health information: never available to the employer.

## Proposed renewal terms

1. A paid subscription starts when Stripe confirms the first successful payment.
2. The initial term is 12 months.
3. The subscription renews for another 12 months unless the organisation cancels before the renewal date.
4. SparkFit sends renewal reminders 30 days and 7 days before renewal.
5. The reminder states the renewal date, current seat quantity, current annual price excluding VAT and how to cancel or request a seat reduction.
6. Price changes are notified at least 30 days before renewal.
7. No pilot converts to a paid subscription automatically.

Recommended cancellation configuration: allow cancellation at any time through the Stripe Customer Portal, with cancellation effective at the end of the current paid term.

## Proposed cancellation timing

- An organisation can turn off renewal at any time before the renewal charge is processed.
- Access continues until the end of the paid annual term.
- Employer-funded access ends at 23:59 UTC on the final paid day.
- Employee accounts and employee-created data remain intact.
- A personal App Store or Google Play subscription is unaffected.
- Cancellation does not automatically create a refund.
- SparkFit confirms cancellation by email and displays the access end date in the employer portal.

For operational clarity, ask organisations to submit seat reductions at least 30 days before renewal, but allow cancellation until the renewal payment begins.

## Proposed payment failure grace period

Use a 14-calendar-day access grace period after an annual renewal payment fails.

Suggested sequence:

1. Day 0: mark the subscription as `payment_attention`, email the billing contact and keep employee access active.
2. Day 3: retry payment and send a reminder if it still fails.
3. Day 7: retry and warn that employer-funded access will be suspended after day 14.
4. Day 12: send a final reminder.
5. Day 14: suspend employer-funded Business access if payment remains unpaid.
6. Day 30: mark the subscription ended if the invoice remains unpaid and the organisation has not agreed another arrangement.

When the outstanding invoice is paid, restore Business access promptly from the server ledger. Never alter a personal `Pro` or `Trial` entitlement.

## Proposed refund policy

### Pilots

Pilots are free, so no refund applies.

### Paid subscriptions

- Annual employer subscriptions are normally non-refundable after employee access begins.
- Provide a full refund for a duplicate charge, an incorrect charge caused by SparkFit, or a payment taken after a correctly recorded cancellation.
- Allow a full cancellation and refund within 14 calendar days of the organisation's first purchase only when no employee invitation has been activated.
- If employees have activated access, any exceptional partial refund requires manual approval and should reflect the access already supplied, processing costs and applicable law.
- Mid-term seat removals do not create cash refunds.
- Service outage credits, if offered, are decided case by case and documented.
- Refunds return to the original payment method.

The employer agreement should state that statutory rights and mandatory law are not excluded.

## Proposed seat increase policy

- Organisations may increase seats from the employer portal.
- Increases take effect after Stripe confirms the subscription change.
- Stripe calculates a prorated charge for the remainder of the annual term.
- New seats become available only after the relevant payment state is acceptable.
- Orders exceeding 500 seats require a Partnerships quote.

## Proposed seat reduction policy

- Seat reductions take effect at the next annual renewal.
- No mid-term refund or account credit is generated for unused seats.
- The requested renewal quantity cannot be lower than active employees plus unexpired pending invitations.
- The portal tells the employer how many memberships or invitations must be removed before the reduction can be accepted.
- Employers can reuse a seat during the paid term by removing one employee and inviting another.
- Removing an employee ends only employer-funded Business access.
- SparkFit sends confirmation of the new renewal quantity and estimated renewal amount.

This policy prevents unexpected mid-year entitlement removal and simplifies invoicing.

## Proposed data retention schedule

Retention must be confirmed against UK GDPR, accounting requirements, insurance requirements and the final privacy notice.

| Record | Proposed retention | End-of-period action |
| --- | --- | --- |
| Rejected or abandoned pilot application | 12 months after the decision or last activity | Delete or anonymise |
| Approved pilot application | Contract term plus 24 months | Delete or anonymise non-financial fields |
| Pending invitation | Until activated, revoked or expired | Move to the relevant status rule |
| Expired or revoked invitation token | Delete token data immediately; retain status metadata for 90 days | Delete invitation metadata |
| Active membership and activation status | While access is active | Move to ended membership rule |
| Ended membership | 24 months after access ends | Delete or anonymise email and account linkage |
| Organisation administrator access | Contract term plus 90 days | Disable immediately at end; delete after 90 days unless needed for dispute handling |
| Employer contract and billing records | 7 years after the relevant financial year | Secure deletion, subject to accounting advice |
| Stripe event record | 7 years when part of the billing record | Secure deletion |
| Security and administrator audit log | 24 months | Delete or anonymise |
| Email delivery metadata | 12 months | Delete or anonymise |
| Customer support correspondence | 24 months after closure | Delete unless attached to a continuing dispute |
| Marketing consent record | Until consent is withdrawn, plus a minimal suppression record | Keep only what is needed to honour opt-out |
| Operational backups | 35 days | Automatic expiry |

Do not retain invitation plaintext tokens. The current platform stores only token hashes.

## Employer agreement points

The final employer agreement should cover:

- Service description and eligibility.
- Seat quantity and price excluding VAT.
- Subscription start and renewal dates.
- Automatic renewal and cancellation method.
- Seat increase and reduction rules.
- Payment failure and suspension.
- Refund rules.
- Acceptable use and prohibition on sharing invitations.
- Employer responsibility for providing accurate employee email addresses lawfully.
- Employee privacy and the reporting boundary.
- Data controller and processor roles.
- Security incident process.
- Service availability and maintenance.
- Liability limits and exclusions approved by a solicitor.
- Termination and data deletion.
- Governing law and dispute process.

## Stripe implementation defaults

Configure Stripe Billing to reflect the approved version of these policies:

- Annual recurring subscription.
- Automatic tax calculation.
- Cancellation at period end through Customer Portal.
- Seat increases with proration.
- Seat reductions scheduled for renewal rather than applied immediately.
- Failed payment retries and customer emails across a 14-day grace period.
- Renewal reminders at 30 days and 7 days.
- Invoice and receipt emails enabled.

Do not activate these live settings until the final employer agreement and customer-facing wording match them.
