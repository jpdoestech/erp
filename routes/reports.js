const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireLogin, getScopedCompanyId } = require('../middleware/auth');
const { toCsv, centsToDecimal } = require('../utils/csv');

router.use(requireLogin);

function buildSummaryRows(companyId) {
  return db
    .prepare(
      `SELECT
         pp.id, pp.name, pp.period_start, pp.period_end, pp.pay_frequency, pp.status,
         COUNT(pe.id) AS employee_count,
         COALESCE(SUM(pe.basic_pay_cents), 0) AS regular,
         COALESCE(SUM(pe.premium_pay_cents), 0) AS premium,
         COALESCE(SUM(pe.adjustments_cents), 0) AS additions,
         COALESCE(SUM(pe.gross_pay_cents), 0) AS gross,
         COALESCE(SUM(pe.sss_employee_cents), 0) AS sss,
         COALESCE(SUM(pe.philhealth_employee_cents), 0) AS philhealth,
         COALESCE(SUM(pe.pagibig_employee_cents), 0) AS pagibig,
         COALESCE(SUM(pe.withholding_tax_cents), 0) AS wtax,
         COALESCE(SUM(pe.loan_deduction_cents), 0) AS loan,
         COALESCE(SUM(pe.total_deductions_cents), 0) AS deductions,
         COALESCE(SUM(pe.net_pay_cents), 0) AS net
       FROM payroll_periods pp
       LEFT JOIN payroll_entries pe ON pe.payroll_period_id = pp.id
       WHERE pp.company_id = ?
       GROUP BY pp.id
       ORDER BY pp.period_start DESC`
    )
    .all(companyId);
}

// ---- Payroll Summary: on-screen view ----
router.get('/', (req, res) => {
  const companyId = getScopedCompanyId(req);
  const companies =
    req.session.user.role === 'SUPER_ADMIN'
      ? db.prepare('SELECT * FROM companies ORDER BY name').all()
      : null;

  if (!companyId) {
    return res.render('reports/summary', { rows: [], totals: null, companies, selectedCompanyId: null });
  }

  const rows = buildSummaryRows(companyId);
  const totals = rows.reduce(
    (acc, r) => {
      ['regular', 'premium', 'additions', 'gross', 'sss', 'philhealth', 'pagibig', 'wtax', 'loan', 'deductions', 'net'].forEach(
        (k) => (acc[k] = (acc[k] || 0) + r[k])
      );
      acc.employee_count = (acc.employee_count || 0) + r.employee_count;
      return acc;
    },
    {}
  );

  res.render('reports/summary', { rows, totals, companies, selectedCompanyId: companyId });
});

// ---- Payroll Summary: CSV export ----
router.get('/summary.csv', (req, res) => {
  const companyId = getScopedCompanyId(req);
  if (!companyId) return res.status(400).render('error', { message: 'Select a company first.' });

  const rows = buildSummaryRows(companyId);
  const header = [
    'Period', 'Coverage', 'Frequency', 'Status', 'Employees',
    'Regular', 'Premium', 'Additions', 'Gross',
    'SSS', 'PhilHealth', 'Pag-IBIG', 'Withholding Tax', 'Loan', 'Total Deductions', 'Net Pay',
  ];
  const dataRows = rows.map((r) => [
    r.name, `${r.period_start} to ${r.period_end}`, r.pay_frequency, r.status, r.employee_count,
    centsToDecimal(r.regular), centsToDecimal(r.premium), centsToDecimal(r.additions), centsToDecimal(r.gross),
    centsToDecimal(r.sss), centsToDecimal(r.philhealth), centsToDecimal(r.pagibig), centsToDecimal(r.wtax),
    centsToDecimal(r.loan), centsToDecimal(r.deductions), centsToDecimal(r.net),
  ]);

  const csv = toCsv([header, ...dataRows]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="payroll-summary.csv"');
  res.send(csv);
});

module.exports = router;
