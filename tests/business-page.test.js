'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'business/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'business/business.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'business/business.js'), 'utf8');

test('loads the central pricing module before the page behaviour', () => {
  assert.ok(html.indexOf('./pricing.js') < html.indexOf('./business.js'));
});

test('provides the required numeric input and slider limits', () => {
  assert.match(html, /type="number" min="20" max="1000" step="1" value="50"[^>]*data-price-quantity/);
  assert.match(html, /type="range" min="20" max="1000" step="1" value="50"[^>]*data-seat-slider/);
});

test('includes the three calculated package starting points', () => {
  for (const seats of [20, 50, 100]) assert.match(html, new RegExp(`data-package-seats="${seats}"`));
});

test('uses annual subscriptions in the public order flow', () => {
  assert.match(html, /Annual Employer Subscription Enquiry/);
  assert.match(html, /Get Started with 50 Employees/);
  assert.doesNotMatch(html, /3, 6, 9 or 12 months of access/);
  assert.doesNotMatch(html, /Lifetime access available/);
});

test('supports keyboard control for the seat slider', () => {
  for (const key of ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End']) assert.match(js, new RegExp(`'${key}'`));
});

test('contains responsive pricing layouts for tablet and mobile', () => {
  assert.match(css, /@media \(max-width: 980px\)[\s\S]*\.annual-calculator/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.annual-plan-results/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.package-heading/);
});

test('does not use em dashes in business-facing source', () => {
  assert.doesNotMatch(`${html}\n${css}\n${js}`, /—|&mdash;|&#8212;|&#x2014;|\\u2014/);
});
