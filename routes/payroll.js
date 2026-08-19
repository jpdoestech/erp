const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireLogin, requireRole, getScopedCompanyId, assertCompanyScope } = require('../middleware/auth');
const { logAction } = require('../db/audit');
const { computeEntry, computeLineAmount, PAY_TYPES } = require('../utils/payroll-calc');
const { computeStatutoryDeductions } = require('../utils/gov-deductions');

router.use(requireLogin);

// Recomputes an entry's premium_pay_cents, statutory deductions, and gross/net
// totals. Regular pay (basic_pay_cents) is left untouched -- callers update
// that separately. Deductions are derived from THIS period's own gross pay,
// scaled to a monthly-equivalent via the period's pay_frequency -- see
// utils/gov-deductions.js for the full methodology and caveats.
function recomputeEntryTotals(entryId) {
  const entry = db.prepare('SELECT * FROM payroll_entries WHERE id = ?').get(entryId);
  const period = db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(entry.payroll_period_id);
  const premium = db
    .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payroll_entry_lines WHERE payroll_entry_id = ?')
    .get(entryId).total;
  const gross = entry.basic_pay_cents + premium;

  const ded = computeStatutoryDeductions({ periodGrossCents: gross, payFrequency: period.pay_frequency });
  const totalDeductions =
    ded.sssEmployeeCents + ded.philhealthEmployeeCents + ded.pagibigEmployeeCents + ded.withholdingTaxCents;
  const net = gross - totalDeductions;

  db.prepare(
    `UPDATE payroll_entries SET
       premium_pay_cents = ?, gross_pay_cents = ?,
       sss_employee_cents = ?, sss_employer_cents = ?,
       philhealth_employee_cents = ?, philhealth_employer_cents = ?,
       pagibig_employee_cents = ?, pagibig_employer_cents = ?,
       withholding_tax_cents = ?, total_deductions_cents = ?, net_pay_cents = ?
     WHERE id = ?`
  ).run(
    premium,
    gross,
    ded.sssEmployeeCents,
    ded.sssEmployerCents,
    ded.philhealthEmployeeCents,
    ded.philhealthEmployerCents,
    ded.pagibigEmployeeCents,
    ded.pagibigEmployerCents,
    ded.withholdingTaxCents,
    totalDeductions,
    net,
    entryId
  );
}

// ---- List ----
router.get('/', (req, res) => {
  const companyId = getScopedCompanyId(req);
  const companies =
    req.session.user.role === 'SUPER_ADMIN'
      ? db.prepare('SELECT * FROM companies ORDER BY name').all()
      : null;

  if (!companyId) {
    return res.render('payroll/list', { periods: [], companies, selectedCompanyId: null });
  }
  const periods = db
    .prepare('SELECT * FROM payroll_periods WHERE company_id = ? ORDER BY period_start DESC')
    .all(companyId);
  res.render('payroll/list', { periods, companies, selectedCompanyId: companyId });
});

// ---- New period form ----
router.get('/new', requireRole('SUPER_ADMIN', 'COMPANY_ADMIN'), (req, res) => {
  const companyId = getScopedCompanyId(req);
  const companies =
    req.session.user.role === 'SUPER_ADMIN'
      ? db.prepare('SELECT * FROM companies ORDER BY name').all()
      : null;
  res.render('payroll/new', { error: null, companies, selectedCompanyId: companyId, values: {} });
});

// ---- Create period: auto-loads every ACTIVE employee of the company as a draft entry ----
router.post('/', requireRole('SUPER_ADMIN', 'COMPANY_ADMIN'), (req, res) => {
  const user = req.session.user;
  const companyId = user.role === 'SUPER_ADMIN' ? Number(req.body.company_id) : user.company_id;
  const { name, period_start, period_end, pay_date } = req.body;
  const validFrequencies = ['MONTHLY', 'SEMI_MONTHLY', 'BIWEEKLY', 'WEEKLY'];
  const payFrequency = validFrequencies.includes(req.body.pay_frequency) ? req.body.pay_frequency : 'SEMI_MONTHLY';

  if (!companyId || !name || !period_start || !period_end) {
    return res.render('payroll/new', {
      error: 'Company, name, period start, and period end are required.',
      companies: user.role === 'SUPER_ADMIN' ? db.prepare('SELECT * FROM companies ORDER BY name').all() : null,
      selectedCompanyId: companyId,
      values: req.body,
    });
  }

  const employees = db
    .prepare("SELECT * FROM employees WHERE company_id = ? AND status = 'ACTIVE' ORDER BY last_name")
    .all(companyId);

  const createPeriodTxn = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO payroll_periods (company_id, name, period_start, period_end, pay_date, pay_frequency, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?)`
      )
      .run(companyId, name.trim(), period_start, period_end, pay_date || null, payFrequency, user.id);
    const periodId = info.lastInsertRowid;

    const insertEntry = db.prepare(
      `INSERT INTO payroll_entries
         (payroll_period_id, employee_id, days_paid, rate_type, rate_amount_cents,
          basic_pay_cents, premium_pay_cents, gross_pay_cents, net_pay_cents)
       VALUES (?, ?, 0, ?, ?, 0, 0, 0, 0)`
    );
    for (const emp of employees) {
      insertEntry.run(periodId, emp.id, emp.rate_type, emp.rate_amount_cents);
    }
    return periodId;
  });

  const periodId = createPeriodTxn();
  logAction(user.id, 'CREATE', 'payroll_period', periodId, `Created payroll period ${name} (${payFrequency}) with ${employees.length} employee(s)`);
  res.redirect(`/payroll/${periodId}`);
});

// ---- View / edit a period ----
router.get('/:id', (req, res) => {
  const period = db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(req.params.id);
  if (!period) return res.status(404).render('error', { message: 'Payroll period not found.' });
  if (!assertCompanyScope(req, period.company_id)) {
    return res.status(403).render('error', { message: 'You do not have access to this payroll period.' });
  }

  const entries = db
    .prepare(
      `SELECT pe.*, e.employee_no, e.first_name, e.last_name
       FROM payroll_entries pe
       JOIN employees e ON e.id = pe.employee_id
       WHERE pe.payroll_period_id = ?
       ORDER BY e.last_name, e.first_name`
    )
    .all(period.id);

  const totals = entries.reduce(
    (acc, e) => {
      acc.regular += e.basic_pay_cents;
      acc.premium += e.premium_pay_cents;
      acc.gross += e.gross_pay_cents;
      acc.deductions += e.total_deductions_cents;
      acc.net += e.net_pay_cents;
      return acc;
    },
    { regular: 0, premium: 0, gross: 0, deductions: 0, net: 0 }
  );

  res.render('payroll/view', { period, entries, totals, canEdit: period.status === 'DRAFT' });
});

// ---- Single entry detail: regular days + premium pay-type lines (OT/ND/holiday/rest day) ----
router.get('/:id/entries/:entryId', (req, res) => {
  const period = db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(req.params.id);
  if (!period) return res.status(404).render('error', { message: 'Payroll period not found.' });
  if (!assertCompanyScope(req, period.company_id)) {
    return res.status(403).render('error', { message: 'You do not have access to this payroll period.' });
  }
  const entry = db
    .prepare(
      `SELECT pe.*, e.employee_no, e.first_name, e.last_name
       FROM payroll_entries pe JOIN employees e ON e.id = pe.employee_id
       WHERE pe.id = ? AND pe.payroll_period_id = ?`
    )
    .get(req.params.entryId, period.id);
  if (!entry) return res.status(404).render('error', { message: 'Payroll entry not found.' });

  const lines = db
    .prepare('SELECT * FROM payroll_entry_lines WHERE payroll_entry_id = ? ORDER BY id')
    .all(entry.id);

  res.render('payroll/entry', {
    period,
    entry,
    lines,
    payTypes: PAY_TYPES,
    canEdit: period.status === 'DRAFT',
    error: null,
  });
});

// ---- Update one entry's Regular days paid (DRAFT only) ----
router.post('/:id/entries/:entryId', requireRole('SUPER_ADMIN', 'COMPANY_ADMIN'), (req, res) => {
  const period = db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(req.params.id);
  if (!period) return res.status(404).render('error', { message: 'Payroll period not found.' });
  if (!assertCompanyScope(req, period.company_id)) {
    return res.status(403).render('error', { message: 'You do not have access to this payroll period.' });
  }
  if (period.status !== 'DRAFT') {
    return res.status(409).render('error', {
      message: 'This payroll period is no longer in Draft and cannot be edited. Use an adjustment for corrections.',
    });
  }

  const entry = db
    .prepare('SELECT * FROM payroll_entries WHERE id = ? AND payroll_period_id = ?')
    .get(req.params.entryId, period.id);
  if (!entry) return res.status(404).render('error', { message: 'Payroll entry not found.' });

  const daysPaid = Math.max(0, Number(req.body.days_paid) || 0);
  const { basicPayCents } = computeEntry({
    rateType: entry.rate_type,
    rateAmountCents: entry.rate_amount_cents,
    daysPaid,
  });

  db.prepare('UPDATE payroll_entries SET days_paid = ?, basic_pay_cents = ? WHERE id = ?').run(
    daysPaid,
    basicPayCents,
    entry.id
  );
  recomputeEntryTotals(entry.id);

  logAction(
    req.session.user.id,
    'UPDATE',
    'payroll_entry',
    entry.id,
    `Set days_paid=${daysPaid} (Regular) for employee ${entry.employee_id} in period ${period.id}`
  );
  res.redirect(`/payroll/${period.id}/entries/${entry.id}`);
});

// ---- Add a premium pay-type line (OT / ND / Rest Day / Special Holiday / Regular Holiday) ----
router.post('/:id/entries/:entryId/lines', requireRole('SUPER_ADMIN', 'COMPANY_ADMIN'), (req, res) => {
  const period = db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(req.params.id);
  if (!period) return res.status(404).render('error', { message: 'Payroll period not found.' });
  if (!assertCompanyScope(req, period.company_id)) {
    return res.status(403).render('error', { message: 'You do not have access to this payroll period.' });
  }
  const entry = db
    .prepare('SELECT * FROM payroll_entries WHERE id = ? AND payroll_period_id = ?')
    .get(req.params.entryId, period.id);
  if (!entry) return res.status(404).render('error', { message: 'Payroll entry not found.' });

  const renderWithError = (error) => {
    const lines = db
      .prepare('SELECT * FROM payroll_entry_lines WHERE payroll_entry_id = ? ORDER BY id')
      .all(entry.id);
    const entryWithEmp = db
      .prepare(
        `SELECT pe.*, e.employee_no, e.first_name, e.last_name
         FROM payroll_entries pe JOIN employees e ON e.id = pe.employee_id WHERE pe.id = ?`
      )
      .get(entry.id);
    return res.status(400).render('payroll/entry', {
      period,
      entry: entryWithEmp,
      lines,
      payTypes: PAY_TYPES,
      canEdit: period.status === 'DRAFT',
      error,
    });
  };

  if (period.status !== 'DRAFT') {
    return res.status(409).render('error', {
      message: 'This payroll period is no longer in Draft and cannot be edited. Use an adjustment for corrections.',
    });
  }

  const { pay_type, quantity } = req.body;
  if (!PAY_TYPES[pay_type]) {
    return renderWithError('Select a valid pay type.');
  }
  const qty = Number(quantity);
  if (!qty || qty <= 0) {
    return renderWithError('Enter a quantity greater than zero.');
  }

  const amountCents = computeLineAmount({
    payType: pay_type,
    quantity: qty,
    rateType: entry.rate_type,
    rateAmountCents: entry.rate_amount_cents,
  });

  db.prepare(
    'INSERT INTO payroll_entry_lines (payroll_entry_id, pay_type, quantity, amount_cents) VALUES (?, ?, ?, ?)'
  ).run(entry.id, pay_type, qty, amountCents);
  recomputeEntryTotals(entry.id);

  logAction(
    req.session.user.id,
    'CREATE',
    'payroll_entry_line',
    entry.id,
    `Added ${pay_type} line: qty=${qty} for employee ${entry.employee_id} in period ${period.id}`
  );
  res.redirect(`/payroll/${period.id}/entries/${entry.id}`);
});

// ---- Delete a premium pay-type line ----
router.post(
  '/:id/entries/:entryId/lines/:lineId/delete',
  requireRole('SUPER_ADMIN', 'COMPANY_ADMIN'),
  (req, res) => {
    const period = db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(req.params.id);
    if (!period) return res.status(404).render('error', { message: 'Payroll period not found.' });
    if (!assertCompanyScope(req, period.company_id)) {
      return res.status(403).render('error', { message: 'You do not have access to this payroll period.' });
    }
    if (period.status !== 'DRAFT') {
      return res.status(409).render('error', {
        message: 'This payroll period is no longer in Draft and cannot be edited. Use an adjustment for corrections.',
      });
    }
    const entry = db
      .prepare('SELECT * FROM payroll_entries WHERE id = ? AND payroll_period_id = ?')
      .get(req.params.entryId, period.id);
    if (!entry) return res.status(404).render('error', { message: 'Payroll entry not found.' });

    const line = db
      .prepare('SELECT * FROM payroll_entry_lines WHERE id = ? AND payroll_entry_id = ?')
      .get(req.params.lineId, entry.id);
    if (!line) return res.status(404).render('error', { message: 'Pay type line not found.' });

    db.prepare('DELETE FROM payroll_entry_lines WHERE id = ?').run(line.id);
    recomputeEntryTotals(entry.id);

    logAction(
      req.session.user.id,
      'DELETE',
      'payroll_entry_line',
      entry.id,
      `Removed ${line.pay_type} line (qty=${line.quantity}) for employee ${entry.employee_id} in period ${period.id}`
    );
    res.redirect(`/payroll/${period.id}/entries/${entry.id}`);
  }
);

// ---- Workflow transitions ----
// DRAFT -> FOR_REVIEW  (maker submits; records who submitted, for segregation-of-duties below)
router.post('/:id/submit', requireRole('SUPER_ADMIN', 'COMPANY_ADMIN'), (req, res) =>
  transition(req, res, 'DRAFT', 'FOR_REVIEW', 'SUBMIT', { submitted_by: req.session.user.id })
);

// FOR_REVIEW -> APPROVED  (approver)
// Segregation of duties: whoever submitted a period cannot also approve it.
// SUPER_ADMIN is the only role allowed to override this (e.g. a 2-person company in demo/testing).
router.post('/:id/approve', requireRole('SUPER_ADMIN', 'COMPANY_ADMIN', 'PAYROLL_APPROVER'), (req, res) => {
  const period = db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(req.params.id);
  if (!period) return res.status(404).render('error', { message: 'Payroll period not found.' });
  if (!assertCompanyScope(req, period.company_id)) {
    return res.status(403).render('error', { message: 'You do not have access to this payroll period.' });
  }
  const user = req.session.user;
  if (user.role !== 'SUPER_ADMIN' && period.submitted_by === user.id) {
    return res.status(403).render('error', {
      message: 'Segregation of duties: you submitted this payroll period, so you cannot also approve it. Ask another authorized approver to review it.',
    });
  }
  return transition(req, res, 'FOR_REVIEW', 'APPROVED', 'APPROVE', { approved_by: user.id });
});

// FOR_REVIEW -> DRAFT  (approver sends back)
router.post('/:id/return', requireRole('SUPER_ADMIN', 'COMPANY_ADMIN', 'PAYROLL_APPROVER'), (req, res) =>
  transition(req, res, 'FOR_REVIEW', 'DRAFT', 'RETURN')
);
// APPROVED -> FINALIZED  (locks editing permanently)
router.post('/:id/finalize', requireRole('SUPER_ADMIN', 'COMPANY_ADMIN'), (req, res) =>
  transition(req, res, 'APPROVED', 'FINALIZED', 'FINALIZE', { finalized_at: new Date().toISOString() })
);
// FINALIZED -> POSTED
router.post('/:id/post', requireRole('SUPER_ADMIN', 'COMPANY_ADMIN'), (req, res) =>
  transition(req, res, 'FINALIZED', 'POSTED', 'POST', { posted_at: new Date().toISOString() })
);

function transition(req, res, fromStatus, toStatus, actionLabel, extraFields = {}) {
  const period = db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(req.params.id);
  if (!period) return res.status(404).render('error', { message: 'Payroll period not found.' });
  if (!assertCompanyScope(req, period.company_id)) {
    return res.status(403).render('error', { message: 'You do not have access to this payroll period.' });
  }
  if (period.status !== fromStatus) {
    return res.status(409).render('error', {
      message: `This period is currently "${period.status}" and cannot move to "${toStatus}" from here.`,
    });
  }

  const setClauses = ['status = ?'];
  const params = [toStatus];
  for (const [col, val] of Object.entries(extraFields)) {
    setClauses.push(`${col} = ?`);
    params.push(val);
  }
  params.push(period.id);

  db.prepare(`UPDATE payroll_periods SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
  logAction(req.session.user.id, actionLabel, 'payroll_period', period.id, `${fromStatus} -> ${toStatus}`);
  res.redirect(`/payroll/${period.id}`);
}

module.exports = router;
