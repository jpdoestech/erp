// Phase 1 payroll computation: Regular pay plus standard PH premium pay types
// (Overtime, Night Differential, Rest Day, Special Holiday, Regular Holiday --
// including their combinations, e.g. a Special Holiday falling on a Rest Day).
//
// regular_pay = days_paid * daily_rate                                 (DAILY employees)
// regular_pay = days_paid * (monthly_rate / STANDARD_MONTHLY_DIVISOR)  (MONTHLY employees)
//
// STANDARD_MONTHLY_DIVISOR (26) and every multiplier below are standard,
// widely used DOLE defaults for the private sector -- NOT a certified
// compliance engine, and NOT hard-coded as unchangeable. A company/CBA may
// legally use different rates. Making these configurable per company/client
// is exactly what Payroll Studio (a later phase) is for; this module
// isolates the current fixed defaults so that swap-in is a small, contained
// change.
//
// Government contributions (SSS/PhilHealth/Pag-IBIG), withholding tax, and
// loans/cash advances are still out of scope for this phase -- gross == net
// for now.

const STANDARD_MONTHLY_DIVISOR = 26;
const STANDARD_HOURS_PER_DAY = 8;

// Each non-ordinary "day type" a worked day can fall on, and the full-day
// multiplier of the daily rate that applies when it is worked. Combinations
// (e.g. a Special Holiday that also happens to be the employee's Rest Day)
// are modeled as their own entry with the DOLE-mandated combined rate --
// NOT as two stacked lines, which would overstate pay (130% + 130% != 150%).
const DAY_TYPES = {
  REST_DAY: { label: 'Rest Day', multiplier: 1.30 },
  SPECIAL_HOLIDAY: { label: 'Special (Non-Regular) Holiday', multiplier: 1.30 },
  SPECIAL_HOLIDAY_REST_DAY: { label: 'Special Holiday on a Rest Day', multiplier: 1.50 },
  LEGAL_HOLIDAY: { label: 'Regular Holiday', multiplier: 2.00 },
  LEGAL_HOLIDAY_REST_DAY: { label: 'Regular Holiday on a Rest Day', multiplier: 2.60 },
};

const OT_ORDINARY_FACTOR = 1.25; // Ordinary-day overtime: 125% of the hourly rate.
const OT_PREMIUM_FACTOR = 1.30; // Overtime on any non-ordinary day: +30% on top of that day's rate.
const ND_FACTOR = 0.10; // Night differential: +10% of whichever hourly rate applies for that day.

// basis: 'HOURS' -> quantity is hours, valued at (hourly rate * multiplier) per hour
// basis: 'DAYS'  -> quantity is whole/half days, valued at (daily rate * multiplier) per day,
//                   already expressed as the FULL day's pay (not just the add-on premium)
function buildPayTypes() {
  const types = {};

  // Full-day premium pay for a non-ordinary day type (Rest Day / Holiday / combos).
  for (const [key, day] of Object.entries(DAY_TYPES)) {
    types[key] = {
      label: day.label,
      basis: 'DAYS',
      multiplier: day.multiplier,
      group: 'Full-day pay (Rest Day / Holiday)',
      note: `Full-day pay at ${(day.multiplier * 100).toFixed(0)}% of the daily rate.`,
    };
  }

  // Overtime: the ordinary-day rate, plus one combined rate per day type above
  // (that day's full-day multiplier, with the +30% OT premium layered on top).
  types.OT = {
    label: 'Overtime — Ordinary Day',
    basis: 'HOURS',
    multiplier: OT_ORDINARY_FACTOR,
    group: 'Overtime',
    note: `${(OT_ORDINARY_FACTOR * 100).toFixed(0)}% of the hourly rate per OT hour on an ordinary working day.`,
  };
  for (const [key, day] of Object.entries(DAY_TYPES)) {
    const combined = day.multiplier * OT_PREMIUM_FACTOR;
    types[`OT_${key}`] = {
      label: `Overtime — ${day.label}`,
      basis: 'HOURS',
      multiplier: combined,
      group: 'Overtime',
      note: `${(combined * 100).toFixed(0)}% of the hourly rate per OT hour (${(day.multiplier * 100).toFixed(0)}% day rate × ${(OT_PREMIUM_FACTOR * 100).toFixed(0)}% OT premium).`,
    };
  }

  // Night differential: the ordinary-day 10% premium, plus one combined rate
  // per day type (that day's rate scaled by the same 10% ND premium).
  types.ND = {
    label: 'Night Differential — Ordinary Day',
    basis: 'HOURS',
    multiplier: ND_FACTOR,
    group: 'Night Differential',
    note: `${(ND_FACTOR * 100).toFixed(0)}% hourly premium for hours worked 10:00 PM–6:00 AM on an ordinary day, on top of base pay.`,
  };
  for (const [key, day] of Object.entries(DAY_TYPES)) {
    const combined = day.multiplier * ND_FACTOR;
    types[`ND_${key}`] = {
      label: `Night Differential — ${day.label}`,
      basis: 'HOURS',
      multiplier: combined,
      group: 'Night Differential',
      note: `${(combined * 100).toFixed(1)}% hourly premium (${(day.multiplier * 100).toFixed(0)}% day rate × ${(ND_FACTOR * 100).toFixed(0)}% ND), on top of that day's base pay.`,
    };
  }

  return types;
}

const PAY_TYPES = buildPayTypes();

function dailyRateCents(rateType, rateAmountCents, monthlyDivisor) {
  const divisor = monthlyDivisor || STANDARD_MONTHLY_DIVISOR;
  return rateType === 'MONTHLY' ? rateAmountCents / divisor : rateAmountCents;
}

function hourlyRateCents(rateType, rateAmountCents, monthlyDivisor, hoursPerDay) {
  return dailyRateCents(rateType, rateAmountCents, monthlyDivisor) / (hoursPerDay || STANDARD_HOURS_PER_DAY);
}

// Returns the multiplier that actually applies for a pay type: a company's
// override if one is set, otherwise the standard default from PAY_TYPES.
// `rates.multipliers` is a plain { payType: multiplier } map -- see
// routes/payroll.js's getEffectiveRates(), which loads it from
// company_pay_type_rates (Payroll Studio).
function effectiveMultiplier(payType, rates) {
  const override = rates && rates.multipliers ? rates.multipliers[payType] : undefined;
  return override !== undefined && override !== null ? override : PAY_TYPES[payType].multiplier;
}

// Regular pay for ordinary days worked. `rates` (optional) is
// { monthlyDivisor, hoursPerDay, multipliers } from Payroll Studio company
// settings; omitting it uses the standard defaults, unchanged from before.
function computeEntry({ rateType, rateAmountCents, daysPaid, rates }) {
  const days = Number(daysPaid) || 0;
  const monthlyDivisor = rates && rates.monthlyDivisor;
  const basicPayCents = Math.round(dailyRateCents(rateType, rateAmountCents, monthlyDivisor) * days);
  // grossPayCents/netPayCents here reflect Regular pay only; the route layer
  // adds premium_pay_cents (from payroll_entry_lines) on top before saving.
  return { basicPayCents, grossPayCents: basicPayCents, netPayCents: basicPayCents };
}

// One premium-pay line item (any key in PAY_TYPES above). `rates` (optional,
// same shape as computeEntry) lets a company override the multiplier and/or
// the monthly-divisor/hours-per-day basis; omitting it uses standard defaults.
function computeLineAmount({ payType, quantity, rateType, rateAmountCents, rates }) {
  const def = PAY_TYPES[payType];
  if (!def) throw new Error(`Unknown pay type: ${payType}`);
  const qty = Math.max(0, Number(quantity) || 0);
  const monthlyDivisor = rates && rates.monthlyDivisor;
  const hoursPerDay = rates && rates.hoursPerDay;
  const rateCents =
    def.basis === 'HOURS'
      ? hourlyRateCents(rateType, rateAmountCents, monthlyDivisor, hoursPerDay)
      : dailyRateCents(rateType, rateAmountCents, monthlyDivisor);
  return Math.round(rateCents * effectiveMultiplier(payType, rates) * qty);
}

// Row order for the "Days Present" spreadsheet: Regular first, then each
// non-ordinary day type. Every row has a Days/OT-hours/ND-hours cell, each
// backed by its own PAY_TYPES key (or, for Regular's day count, the parent
// payroll_entries row itself rather than a line).
const DAY_ROW_ORDER = ['REGULAR', ...Object.keys(DAY_TYPES)];

function dayRowLabel(key) {
  return key === 'REGULAR' ? 'Regular' : DAY_TYPES[key].label;
}

// Builds one spreadsheet row per day type from the entry (for Regular) and
// its payroll_entry_lines (for everything else), pairing each day type with
// its own OT/ND pay-type variant so the row's three cells stay consistent
// with whichever combined rate applies to that day.
function buildDayRows(entry, lines) {
  const findLine = (payType) => lines.find((l) => l.pay_type === payType);
  return DAY_ROW_ORDER.map((key) => {
    const isRegular = key === 'REGULAR';
    const otKey = isRegular ? 'OT' : `OT_${key}`;
    const ndKey = isRegular ? 'ND' : `ND_${key}`;
    const dayLine = isRegular ? null : findLine(key);
    const otLine = findLine(otKey);
    const ndLine = findLine(ndKey);

    const dayQty = isRegular ? entry.days_paid : dayLine ? dayLine.quantity : 0;
    const dayAmount = isRegular ? entry.basic_pay_cents : dayLine ? dayLine.amount_cents : 0;
    const otQty = otLine ? otLine.quantity : 0;
    const otAmount = otLine ? otLine.amount_cents : 0;
    const ndQty = ndLine ? ndLine.quantity : 0;
    const ndAmount = ndLine ? ndLine.amount_cents : 0;

    return {
      key,
      label: dayRowLabel(key),
      dayKey: isRegular ? null : key,
      otKey,
      ndKey,
      dayQty,
      dayAmount,
      otQty,
      otAmount,
      ndQty,
      ndAmount,
      rowTotal: dayAmount + otAmount + ndAmount,
    };
  });
}

module.exports = {
  computeEntry,
  computeLineAmount,
  dailyRateCents,
  hourlyRateCents,
  effectiveMultiplier,
  buildDayRows,
  DAY_ROW_ORDER,
  PAY_TYPES,
  DAY_TYPES,
  STANDARD_MONTHLY_DIVISOR,
  STANDARD_HOURS_PER_DAY,
};
