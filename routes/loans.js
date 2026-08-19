const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireLogin, requireRole, getScopedCompanyId, assertCompanyScope } = require('../middleware/auth');
const { logAction } = require('../db/audit');
const { pesosToCents } = require('../utils/money');
const { LOAN_TYPES } = require('../utils/loan-types');

router.use(requireLogin);

// ---- List ----
router.get('/', (req, res) => {
  const companyId = getScopedCompanyId(req);
  const companies =
    req.session.user.role === 'SUPER_ADMIN'
      ? db.prepare('SELECT * FROM companies ORDER BY name').all()
      : null;

  if (!companyId) {
    return res.render('loans/list', { loans: [], companies, selectedCompanyId: null, loanTypes: LOAN_TYPES });
  }
  const loans = db
    .prepare(
      `SELECT l.*, e.employee_no, e.first_name, e.last_name
       FROM employee_loans l JOIN employees e ON e.id = l.employee_id
       WHERE l.company_id = ?
       ORDER BY l.status = 'ACTIVE' DESC, l.created_at DESC`
    )
    .all(companyId);
  res.render('loans/list', { loans, companies, selectedCompanyId: companyId, loanTypes: LOAN_TYPES });
});

// ---- New loan form ----
router.get('/new', requireRole('SUPER_ADMIN', 'COMPANY_ADMIN'), (req, res) => {
  const companyId = getScopedCompanyId(req);
  const companies =
    req.session.user.role === 'SUPER_ADMIN'
      ? db.prepare('SELECT * FROM companies ORDER BY name').all()
      : null;
  const employees = companyId
    ? db.prepare("SELECT * FROM employees WHERE company_id = ? AND status = 'ACTIVE' ORDER BY last_name").all(companyId)
    : [];
  res.render('loans/new', {
    error: null,
    companies,
    employees,
    selectedCompanyId: companyId,
    loanTypes: LOAN_TYPES,
    values: {},
  });
});

// ---- Create loan ----
router.post('/', requireRole('SUPER_ADMIN', 'COMPANY_ADMIN'), (req, res) => {
  const user = req.session.user;
  const companyId = user.role === 'SUPER_ADMIN' ? Number(req.body.company_id) : user.company_id;
  const { employee_id, loan_type, description, principal, installment } = req.body;

  const employee = employee_id
    ? db.prepare('SELECT * FROM employees WHERE id = ? AND company_id = ?').get(employee_id, companyId)
    : null;

  const rerender = (error) => {
    const employees = companyId
      ? db.prepare("SELECT * FROM employees WHERE company_id = ? AND status = 'ACTIVE' ORDER BY last_name").all(companyId)
      : [];
    return res.status(400).render('loans/new', {
      error,
      companies: user.role === 'SUPER_ADMIN' ? db.prepare('SELECT * FROM companies ORDER BY name').all() : null,
      employees,
      selectedCompanyId: companyId,
      loanTypes: LOAN_TYPES,
      values: req.body,
    });
  };

  if (!companyId || !employee || !LOAN_TYPES[loan_type]) {
    return rerender('Company, a valid employee, and a loan type are required.');
  }
  const principalCents = pesosToCents(principal);
  const installmentCents = pesosToCents(installment);
  if (!principalCents || principalCents <= 0) {
    return rerender('Principal amount must be a positive number.');
  }
  if (!installmentCents || installmentCents <= 0) {
    return rerender('Installment (per-period deduction) amount must be a positive number.');
  }
  if (installmentCents > principalCents) {
    return rerender('Installment amount cannot be greater than the principal.');
  }

  const info = db
    .prepare(
      `INSERT INTO employee_loans
         (employee_id, company_id, loan_type, description, principal_cents, balance_cents, installment_cents, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`
    )
    .run(employee.id, companyId, loan_type, (description || '').trim(), principalCents, principalCents, installmentCents, user.id);

  logAction(
    user.id,
    'CREATE',
    'employee_loan',
    info.lastInsertRowid,
    `Created ${LOAN_TYPES[loan_type]} of ₱${(principalCents / 100).toFixed(2)} for employee ${employee.id}`
  );
  res.redirect(`/loans/${info.lastInsertRowid}`);
});

// ---- Loan detail: balance + deduction history ----
router.get('/:id', (req, res) => {
  const loan = db.prepare('SELECT * FROM employee_loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).render('error', { message: 'Loan not found.' });
  if (!assertCompanyScope(req, loan.company_id)) {
    return res.status(403).render('error', { message: 'You do not have access to this loan.' });
  }
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(loan.employee_id);
  const deductions = db
    .prepare(
      `SELECT d.*, pp.name AS period_name, pp.period_start, pp.period_end, pp.status AS period_status
       FROM payroll_loan_deductions d
       JOIN payroll_entries pe ON pe.id = d.payroll_entry_id
       JOIN payroll_periods pp ON pp.id = pe.payroll_period_id
       WHERE d.loan_id = ?
       ORDER BY pp.period_start DESC`
    )
    .all(loan.id);

  res.render('loans/view', { loan, employee, deductions, loanTypes: LOAN_TYPES });
});

// ---- Cancel a loan (only if no deductions have been applied yet) ----
router.post('/:id/cancel', requireRole('SUPER_ADMIN', 'COMPANY_ADMIN'), (req, res) => {
  const loan = db.prepare('SELECT * FROM employee_loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).render('error', { message: 'Loan not found.' });
  if (!assertCompanyScope(req, loan.company_id)) {
    return res.status(403).render('error', { message: 'You do not have access to this loan.' });
  }
  if (loan.balance_cents !== loan.principal_cents) {
    return res.status(409).render('error', {
      message: 'This loan already has deductions applied against it and cannot be cancelled. Let the balance reach zero, or contact support for a manual correction.',
    });
  }
  db.prepare("UPDATE employee_loans SET status = 'CANCELLED' WHERE id = ?").run(loan.id);
  logAction(req.session.user.id, 'CANCEL', 'employee_loan', loan.id, 'Cancelled loan with no deductions applied');
  res.redirect(`/loans/${loan.id}`);
});

module.exports = router;
