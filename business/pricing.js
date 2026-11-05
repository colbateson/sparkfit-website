(function initialiseSparkFitPricing(root, factory) {
  const pricing = factory();
  if (typeof module === 'object' && module.exports) module.exports = pricing;
  if (root) root.SparkFitPricing = pricing;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const CONFIG = Object.freeze({
    version: 'annual-v1-preview',
    currency: 'GBP',
    vatRateBps: 2000,
    consumerAnnualGrossPennies: 2499,
    minimumSeats: 20,
    maximumSeats: 1000,
    approvedMaximumSeats: 500,
    provisionalExtensionDiscountBps: 5000,
    tiers: Object.freeze([
      Object.freeze({ minimum: 500, discountBps: 5000 }),
      Object.freeze({ minimum: 250, discountBps: 4000 }),
      Object.freeze({ minimum: 100, discountBps: 3500 }),
      Object.freeze({ minimum: 75, discountBps: 3000 }),
      Object.freeze({ minimum: 50, discountBps: 2500 }),
      Object.freeze({ minimum: 20, discountBps: 2000 })
    ])
  });

  const roundDivide = (numerator, denominator) => Math.round(numerator / denominator);
  const formatPercent = (basisPoints) => `${basisPoints / 100}%`;
  const formatPounds = (pennies) => new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: CONFIG.currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(pennies / 100);

  const validateSeats = (seats) => Number.isInteger(seats)
    && seats >= CONFIG.minimumSeats
    && seats <= CONFIG.maximumSeats;

  const tierForSeats = (seats) => {
    if (!validateSeats(seats)) throw new RangeError(`Seats must be a whole number from ${CONFIG.minimumSeats} to ${CONFIG.maximumSeats}.`);
    return CONFIG.tiers.find((tier) => seats >= tier.minimum);
  };

  const calculateAnnualPlan = (seats) => {
    const tier = tierForSeats(seats);
    const vatDivisorBps = 10000 + CONFIG.vatRateBps;
    const directPerSeatExVat = roundDivide(CONFIG.consumerAnnualGrossPennies * 10000, vatDivisorBps);
    const employerPerSeatExVat = roundDivide(directPerSeatExVat * (10000 - tier.discountBps), 10000);
    const employerPerSeatIncVat = roundDivide(employerPerSeatExVat * vatDivisorBps, 10000);
    const directTotalExVat = directPerSeatExVat * seats;
    const directTotalIncVat = CONFIG.consumerAnnualGrossPennies * seats;
    const employerTotalExVat = employerPerSeatExVat * seats;
    const employerTotalIncVat = employerPerSeatIncVat * seats;
    const savingExVat = directTotalExVat - employerTotalExVat;
    const savingIncVat = directTotalIncVat - employerTotalIncVat;
    const provisional = seats > CONFIG.approvedMaximumSeats;

    return Object.freeze({
      pricingVersion: CONFIG.version,
      seats,
      discountBps: tier.discountBps,
      discountLabel: formatPercent(tier.discountBps),
      tierMinimum: tier.minimum,
      provisional,
      directPerSeatExVat,
      directPerSeatIncVat: CONFIG.consumerAnnualGrossPennies,
      directTotalExVat,
      directTotalIncVat,
      employerPerSeatExVat,
      employerPerSeatIncVat,
      employerTotalExVat,
      employerTotalIncVat,
      savingExVat,
      savingIncVat,
      employerMonthlyPerSeatExVat: roundDivide(employerPerSeatExVat, 12),
      employerMonthlyPerSeatIncVat: roundDivide(employerPerSeatIncVat, 12),
      employerMonthlyTotalExVat: roundDivide(employerTotalExVat, 12),
      employerMonthlyTotalIncVat: roundDivide(employerTotalIncVat, 12)
    });
  };

  const valuesForVatMode = (plan, vatMode = 'ex') => {
    if (!plan || (vatMode !== 'ex' && vatMode !== 'inc')) throw new TypeError('A valid plan and VAT mode are required.');
    const suffix = vatMode === 'inc' ? 'IncVat' : 'ExVat';
    return Object.freeze({
      vatMode,
      vatLabel: vatMode === 'inc' ? 'including VAT' : 'excluding VAT',
      directPerSeat: plan[`directPerSeat${suffix}`],
      directTotal: plan[`directTotal${suffix}`],
      employerPerSeat: plan[`employerPerSeat${suffix}`],
      employerTotal: plan[`employerTotal${suffix}`],
      saving: plan[`saving${suffix}`],
      employerMonthlyPerSeat: plan[`employerMonthlyPerSeat${suffix}`],
      employerMonthlyTotal: plan[`employerMonthlyTotal${suffix}`]
    });
  };

  const buildEnquirySummary = (plan, vatMode = 'ex') => {
    const values = valuesForVatMode(plan, vatMode);
    const provisionalText = plan.provisional ? ', provisional 501 to 1,000 seat pricing requiring commercial approval' : '';
    return `Pricing selection: Annual subscription, ${plan.seats} employee licences, ${plan.discountLabel} volume discount applied, ${formatPounds(values.employerTotal)} annual employer subscription ${values.vatLabel}, ${formatPounds(values.saving)} annual saving ${values.vatLabel}, ${values.vatLabel} display selected${provisionalText}.`;
  };

  return Object.freeze({
    CONFIG,
    validateSeats,
    tierForSeats,
    calculateAnnualPlan,
    valuesForVatMode,
    buildEnquirySummary,
    formatPounds
  });
}));
