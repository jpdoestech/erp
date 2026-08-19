// Philippine statutory government deductions: SSS, PhilHealth, Pag-IBIG,
// and BIR withholding tax on compensation.
//
// Figures below reflect the rates verified as in effect for 2025-2026:
//   - SSS: 15% total (5% employee / 10% employer) of Monthly Salary Credit,
//     MSC range PHP 5,000-35,000, per SSS Circular No. 2024-006 (effective
//     Jan 2025), unchanged into 2026. EC contribution (employer-paid):
//     PHP 10 below a PHP 15,000 MSC, PHP 30 at/above it.
//   - PhilHealth: 5% total (2.5% / 2.5%) of monthly basic salary, floor
//     PHP 10,000, ceiling PHP 100,000, per PhilHealth Circular 2019-0009 —
//     the 5% rate was confirmed unchanged for 2026 (PIA advisory, May 2026).
//   - Pag-IBIG (HDMF): 1% employee / 2% employer if monthly compensation is
//     <= PHP 1,500, otherwise 2% / 2%; computation base capped at PHP
//     10,000 per HDMF Circular No. 460 (effective Feb 2024), unchanged
//     into 2026. Max employee share is therefore PHP 200/month.
//   - BIR withholding tax on compensation: graduated monthly brackets from
//     BIR's Revised Withholding Tax Table ("Annex E"), effective Jan 1,
//     2023 onward and confirmed unchanged through 2026 (no new RA/RR has
//     amended individual compensation brackets as of this writing).
//
// IMPORTANT: these are set by law/circular and DO change from time to
// time. This module exists specifically so the numbers live in one place
// and are easy to find and update -- verify against SSS/PhilHealth/
// Pag-IBIG/BIR before relying on this for actual government remittances.
// This is not a certified compliance engine.

const SSS_RATE_EMPLOYEE = 0.05;
const SSS_RATE_EMPLOYER = 0.10;
const SSS_MSC_MIN_CENTS = 500000; // PHP 5,000
const SSS_MSC_MAX_CENTS = 3500000; // PHP 35,000
const SSS_EC_LOW_CENTS = 1000; // PHP 10, when MSC < PHP 15,000
const SSS_EC_HIGH_CENTS = 3000; // PHP 30, when MSC >= PHP 15,000
const SSS_EC_THRESHOLD_CENTS = 1500000; // PHP 15,000

const PHILHEALTH_RATE_TOTAL = 0.05;
const PHILHEALTH_FLOOR_CENTS = 1000000; // PHP 10,000
const PHILHEALTH_CEILING_CENTS = 10000000; // PHP 100,000

const PAGIBIG_MAX_BASE_CENTS = 1000000; // PHP 10,000 (Maximum Fund Salary)
const PAGIBIG_LOW_THRESHOLD_CENTS = 150000; // PHP 1,500
const PAGIBIG_RATE_EMPLOYEE_LOW = 0.01;
const PAGIBIG_RATE_EMPLOYEE_HIGH = 0.02;
const PAGIBIG_RATE_EMPLOYER = 0.02;

// Monthly withholding tax brackets, BIR Annex "E", effective Jan 1, 2023 onward.
// tax = base + rate * (taxable - over)
const WITHHOLDING_MONTHLY_BRACKETS = [
  { upTo: 2083300, base: 0, rate: 0, over: 0 }, // <= PHP 20,833: exempt
  { upTo: 3333300, base: 0, rate: 0.15, over: 2083300 },
  { upTo: 6666700, base: 187500, rate: 0.2, over: 3333300 },
  { upTo: 16666700, base: 854180, rate: 0.25, over: 6666700 },
  { upTo: 66666700, base: 3354180, rate: 0.3, over: 16666700 },
  { upTo: Infinity, base: 18354180, rate: 0.35, over: 66666700 },
];

// How many payroll periods of each frequency make up one calendar month —
// used to convert a period's gross pay to a monthly-equivalent for looking
// up statutory tables (which are published on a monthly basis), then scale
// the result back down to this period's share.
const PERIODS_PER_MONTH = {
  MONTHLY: 1,
  SEMI_MONTHLY: 2,
  BIWEEKLY: 26 / 12,
  WEEKLY: 52 / 12,
};

function computeSSS(monthlyCompCents) {
  const msc = Math.min(Math.max(monthlyCompCents, SSS_MSC_MIN_CENTS), SSS_MSC_MAX_CENTS);
  const employeeCents = Math.round(msc * SSS_RATE_EMPLOYEE);
  const employerBaseCents = Math.round(msc * SSS_RATE_EMPLOYER);
  const ecCents = msc < SSS_EC_THRESHOLD_CENTS ? SSS_EC_LOW_CENTS : SSS_EC_HIGH_CENTS;
  return { employeeCents, employerCents: employerBaseCents + ecCents };
}

function computePhilHealth(monthlyCompCents) {
  const base = Math.min(Math.max(monthlyCompCents, PHILHEALTH_FLOOR_CENTS), PHILHEALTH_CEILING_CENTS);
  const total = Math.round(base * PHILHEALTH_RATE_TOTAL);
  const employeeCents = Math.round(total / 2);
  return { employeeCents, employerCents: total - employeeCents };
}

function computePagIbig(monthlyCompCents) {
  const base = Math.min(Math.max(monthlyCompCents, 0), PAGIBIG_MAX_BASE_CENTS);
  const employeeRate =
    monthlyCompCents <= PAGIBIG_LOW_THRESHOLD_CENTS ? PAGIBIG_RATE_EMPLOYEE_LOW : PAGIBIG_RATE_EMPLOYEE_HIGH;
  const employeeCents = Math.round(base * employeeRate);
  const employerCents = Math.round(base * PAGIBIG_RATE_EMPLOYER);
  return { employeeCents, employerCents };
}

function computeMonthlyWithholdingTax(monthlyTaxableCents) {
  const taxable = Math.max(0, monthlyTaxableCents);
  const bracket = WITHHOLDING_MONTHLY_BRACKETS.find((b) => taxable <= b.upTo);
  const tax = bracket.base + (taxable - bracket.over) * bracket.rate;
  return Math.round(Math.max(0, tax));
}

// Derives this period's statutory deductions from this period's own gross
// pay: scales up to a monthly-equivalent, applies the monthly tables, then
// scales the result back down to this period's share. This mirrors how
// BIR's own per-frequency tables are derived from the monthly schedule, so
// it stays close to the official per-frequency tables without needing to
// hard-code each frequency's table separately.
function computeStatutoryDeductions({ periodGrossCents, payFrequency }) {
  const periodsPerMonth = PERIODS_PER_MONTH[payFrequency] || PERIODS_PER_MONTH.SEMI_MONTHLY;
  const monthlyEquivalentCents = Math.round(periodGrossCents * periodsPerMonth);

  const sss = computeSSS(monthlyEquivalentCents);
  const philhealth = computePhilHealth(monthlyEquivalentCents);
  const pagibig = computePagIbig(monthlyEquivalentCents);

  const monthlyEmployeeContributions = sss.employeeCents + philhealth.employeeCents + pagibig.employeeCents;
  const monthlyTaxableCents = monthlyEquivalentCents - monthlyEmployeeContributions;
  const monthlyWithholdingTaxCents = computeMonthlyWithholdingTax(monthlyTaxableCents);

  const scale = (cents) => Math.round(cents / periodsPerMonth);

  return {
    sssEmployeeCents: scale(sss.employeeCents),
    sssEmployerCents: scale(sss.employerCents),
    philhealthEmployeeCents: scale(philhealth.employeeCents),
    philhealthEmployerCents: scale(philhealth.employerCents),
    pagibigEmployeeCents: scale(pagibig.employeeCents),
    pagibigEmployerCents: scale(pagibig.employerCents),
    withholdingTaxCents: scale(monthlyWithholdingTaxCents),
  };
}

module.exports = {
  computeSSS,
  computePhilHealth,
  computePagIbig,
  computeMonthlyWithholdingTax,
  computeStatutoryDeductions,
  PERIODS_PER_MONTH,
  WITHHOLDING_MONTHLY_BRACKETS,
};
