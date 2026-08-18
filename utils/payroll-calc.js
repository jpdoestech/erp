// Phase 1 payroll computation: basic pay only.
//
// basic_pay = days_paid * daily_rate                         (DAILY employees)
// basic_pay = days_paid * (monthly_rate / STANDARD_MONTHLY_DIVISOR)   (MONTHLY employees)
//
// STANDARD_MONTHLY_DIVISOR is a placeholder (26 working days), NOT a hard-coded
// government rule. Overtime, night differential, holiday pay, government
// contributions, and withholding tax are intentionally out of scope for Phase 1
// (see the phased plan) and will be added as configurable payroll components /
// Payroll Studio formulas in a later phase, per the build spec's rule against
// hard-coding client- or government-specific formulas into the codebase.

const STANDARD_MONTHLY_DIVISOR = 26;

function computeEntry({ rateType, rateAmountCents, daysPaid }) {
  const days = Number(daysPaid) || 0;
  let basicPayCents = 0;

  if (rateType === 'DAILY') {
    basicPayCents = Math.round(rateAmountCents * days);
  } else if (rateType === 'MONTHLY') {
    const dailyEquivalentCents = rateAmountCents / STANDARD_MONTHLY_DIVISOR;
    basicPayCents = Math.round(dailyEquivalentCents * days);
  }

  // Phase 1: no deductions/allowances engine yet, so gross == basic and net == gross.
  const grossPayCents = basicPayCents;
  const netPayCents = grossPayCents;

  return { basicPayCents, grossPayCents, netPayCents };
}

module.exports = { computeEntry, STANDARD_MONTHLY_DIVISOR };
