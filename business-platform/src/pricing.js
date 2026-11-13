export const PRICING_VERSION = 'annual-v1-preview';
export const ANNUAL_CONSUMER_GROSS_PENCE = 2499;
export const VAT_BPS = 2000;
export const MIN_SEATS = 20;
export const MAX_SEATS = 1000;
export const APPROVED_MAX_SEATS = 500;

export const TIERS = Object.freeze([
  { min: 20, discountBps: 2000 },
  { min: 50, discountBps: 2500 },
  { min: 75, discountBps: 3000 },
  { min: 100, discountBps: 3500 },
  { min: 250, discountBps: 4000 },
  { min: 500, discountBps: 5000 },
]);

export function priceAnnual(seats) {
  if (!Number.isInteger(seats) || seats < MIN_SEATS || seats > MAX_SEATS) throw new RangeError(`Seats must be a whole number from ${MIN_SEATS} to ${MAX_SEATS}.`);
  const tier = [...TIERS].reverse().find((candidate) => seats >= candidate.min);
  const directUnitExVat = Math.round(ANNUAL_CONSUMER_GROSS_PENCE * 10000 / (10000 + VAT_BPS));
  const unitExVat = Math.round(directUnitExVat * (10000 - tier.discountBps) / 10000);
  return {
    seats,
    discountBps: tier.discountBps,
    directUnitExVat,
    unitExVat,
    subtotalExVat: unitExVat * seats,
    illustrativeVat: Math.round(unitExVat * seats * VAT_BPS / 10000),
    provisional: seats > APPROVED_MAX_SEATS,
    pricingVersion: PRICING_VERSION,
  };
}
