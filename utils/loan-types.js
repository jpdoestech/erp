// Loan/cash-advance categories. Shared between routes/loans.js and
// routes/payroll.js (which needs it to render the "apply a deduction"
// dropdown on a payroll entry).
const LOAN_TYPES = {
  SSS_LOAN: 'SSS Loan',
  PAGIBIG_LOAN: 'Pag-IBIG Loan',
  COMPANY_LOAN: 'Company Loan',
  CASH_ADVANCE: 'Cash Advance',
  OTHER: 'Other',
};

module.exports = { LOAN_TYPES };
