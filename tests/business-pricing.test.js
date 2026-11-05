'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pricing = require('../business/pricing.js');

const { CONFIG, calculateAnnualPlan, valuesForVatMode, buildEnquirySummary, validateSeats } = pricing;

test('keeps the approved annual consumer reference and VAT configuration', () => {
  assert.equal(CONFIG.consumerAnnualGrossPennies, 2499);
  assert.equal(CONFIG.vatRateBps, 2000);
  assert.equal(calculateAnnualPlan(20).directPerSeatExVat, 2083);
});

test('accepts every whole-number quantity from 20 to 1,000', () => {
  for (let seats = 20; seats <= 1000; seats += 1) {
    assert.equal(validateSeats(seats), true);
    assert.equal(calculateAnnualPlan(seats).seats, seats);
  }
});

test('rejects invalid, decimal and out-of-range quantities', () => {
  for (const seats of [-20, 0, 19, 20.5, 1001, NaN, '50']) assert.equal(validateSeats(seats), false);
  assert.throws(() => calculateAnnualPlan(19), RangeError);
  assert.throws(() => calculateAnnualPlan(1001), RangeError);
});

test('preserves every published discount milestone', () => {
  const milestones = new Map([[20, 2000], [50, 2500], [75, 3000], [100, 3500], [250, 4000], [500, 5000]]);
  for (const [seats, discountBps] of milestones) assert.equal(calculateAnnualPlan(seats).discountBps, discountBps);
});

test('calculates VAT-exclusive and VAT-inclusive annual totals consistently', () => {
  const plan = calculateAnnualPlan(100);
  assert.equal(plan.employerPerSeatExVat, 1354);
  assert.equal(plan.employerPerSeatIncVat, 1625);
  assert.equal(plan.employerTotalExVat, 135400);
  assert.equal(plan.employerTotalIncVat, 162500);
  assert.equal(plan.directTotalExVat, 208300);
  assert.equal(plan.directTotalIncVat, 249900);
});

test('calculates like-for-like savings and monthly equivalents', () => {
  const plan = calculateAnnualPlan(50);
  const exVat = valuesForVatMode(plan, 'ex');
  const incVat = valuesForVatMode(plan, 'inc');
  assert.equal(exVat.saving, exVat.directTotal - exVat.employerTotal);
  assert.equal(incVat.saving, incVat.directTotal - incVat.employerTotal);
  assert.equal(exVat.employerMonthlyPerSeat, 130);
  assert.equal(exVat.employerMonthlyTotal, 6508);
  assert.equal(incVat.employerMonthlyTotal, 7808);
});

test('uses consistent penny rounding at the 20-seat starting point', () => {
  const plan = calculateAnnualPlan(20);
  assert.equal(plan.employerPerSeatExVat, 1666);
  assert.equal(plan.employerPerSeatIncVat, 1999);
  assert.equal(plan.employerTotalExVat, 33320);
  assert.equal(plan.employerTotalIncVat, 39980);
});

test('documents the expected whole-order pricing cliffs and no others', () => {
  const expectedCliffs = [50, 75, 100, 250, 500];
  const observedCliffs = [];
  let previous = calculateAnnualPlan(20).employerTotalExVat;
  for (let seats = 21; seats <= 1000; seats += 1) {
    const total = calculateAnnualPlan(seats).employerTotalExVat;
    if (total < previous) observedCliffs.push(seats);
    previous = total;
  }
  assert.deepEqual(observedCliffs, expectedCliffs);
});

test('marks the 501 to 1,000 seat extension as provisional at 50%', () => {
  for (const seats of [501, 750, 1000]) {
    const plan = calculateAnnualPlan(seats);
    assert.equal(plan.discountBps, CONFIG.provisionalExtensionDiscountBps);
    assert.equal(plan.provisional, true);
  }
  assert.equal(calculateAnnualPlan(500).provisional, false);
});

test('builds enquiry data from the same calculated values', () => {
  const summary = buildEnquirySummary(calculateAnnualPlan(100), 'ex');
  assert.match(summary, /100 employee licences/);
  assert.match(summary, /35% volume discount applied/);
  assert.match(summary, /£1,354\.00 annual employer subscription excluding VAT/);
  assert.match(summary, /£729\.00 annual saving excluding VAT/);
  assert.doesNotMatch(summary, /app-store price/);
});
