# SparkFit annual employer pricing and future Stripe Billing

## Status

This specification supports the annual employer pricing preview on the `codex/annual-business-pricing` branch. It does not activate checkout, payment, renewal or automated licence management.

Pricing configuration version: `annual-v1-preview`.

## Reused commercial rules

- Direct annual consumer subscription: £24.99 including VAT.
- Illustrative UK VAT rate: 20%.
- Annual consumer reference excluding VAT: £20.83 after penny rounding.
- Minimum employer order: 20 licences.
- Existing whole-order discount bands:
  - 20 to 49 licences: 20%.
  - 50 to 74 licences: 25%.
  - 75 to 99 licences: 30%.
  - 100 to 249 licences: 35%.
  - 250 to 499 licences: 40%.
  - 500 licences: 50%.
- Preview-only proposed extension:
  - 501 to 1,000 licences: 50%.

The browser and automated tests use `business/pricing.js` as the single pricing source. Money is calculated in integer pennies.

## Whole-order pricing cliffs

The current volume model changes the price of every licence when an order reaches a threshold. This creates these VAT-exclusive annual total reductions:

| Threshold | Total immediately below | Total at threshold | Order total reduction |
| --- | ---: | ---: | ---: |
| 50 | £816.34 for 49 | £781.00 for 50 | £35.34 |
| 75 | £1,155.88 for 74 | £1,093.50 for 75 | £62.38 |
| 100 | £1,443.42 for 99 | £1,354.00 for 100 | £89.42 |
| 250 | £3,371.46 for 249 | £3,125.00 for 250 | £246.46 |
| 500 | £6,237.50 for 499 | £5,210.00 for 500 | £1,027.50 |

The preview preserves these cliffs because they are part of the current published commercial model.

### Recommended smoother alternative

Before automated checkout launches, consider graduated pricing. Each discount would apply only to licences inside its band. This avoids an additional licence reducing the full order total. Changing to graduated pricing requires commercial approval because it changes quoted totals and the meaning of the published discounts.

## Proposed Stripe architecture

1. Keep a versioned server-side pricing configuration. Each employer subscription stores the agreed pricing version.
2. Send only the requested licence quantity and pricing version from the browser. Never accept a client-calculated total as authoritative.
3. Validate the integer quantity on the Cloudflare endpoint.
4. Recalculate the annual amount on the server from the versioned configuration.
5. Create a Stripe Checkout Session in subscription mode for annual recurring billing.
6. Use one recurring subscription item with quantity equal to the purchased licence count.
7. Use Stripe Tax or the chosen server-side tax treatment to determine actual tax. The website VAT toggle remains illustrative.
8. Handle `checkout.session.completed`, subscription updates, invoice payments and cancellations through verified Stripe webhooks.
9. Activate the employer organisation only after verified payment or an approved invoiced arrangement.
10. Set the organisation's licence allowance from the verified subscription quantity.
11. Recalculate seat changes on the server. Define the proration policy before enabling self-service changes.
12. Preserve historical commercial terms by keeping old pricing versions available for existing subscriptions.

### Stripe product and price strategy

Do not create a product for every possible quantity. Use one SparkFit employer subscription product and a server-controlled annual price strategy.

The existing whole-order model maps conceptually to Stripe volume tiers. Confirm Stripe's supported rounding and tax behaviour against the penny-based SparkFit calculations before launch. If a custom amount is required for each pricing version, create and reuse server-side recurring Prices for approved unit amounts instead of maintaining 981 manual products.

If SparkFit moves to graduated pricing, configure graduated tiers only after the commercial model is approved and customer-facing examples have been updated.

## Current and planned capabilities

Available now:

- Partnership enquiry workflow.
- Employee activation instructions.
- Employee activation.
- Activation-status reporting.
- Private employee use of SparkFit.

Planned, not currently live:

- Stripe Checkout.
- Automatic annual renewal.
- Automated seat changes and proration.
- Self-service employer invitations.
- Self-service licence reassignment.
- Employer licence dashboard.

## Approval gates

The following require commercial approval before production deployment:

- Publishing the 50% discount for 501 to 1,000 licences.
- Keeping the current whole-order pricing cliffs or replacing them with graduated pricing.
- Annual renewal and cancellation terms.
- Seat-change and proration policy.
- Licence reassignment rules.
- Final VAT and tax treatment.
- Stripe price versioning and grandfathering policy.
