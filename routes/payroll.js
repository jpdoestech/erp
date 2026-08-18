const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireLogin, requireRole, getScopedCompanyId, assertCompanyScope } = require('../middleware/auth');
const { logAction } = require('../db/audit');
const { computeEntry } = require('../utils/payroll-calc');

router.use(requireLogin);

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
        `INSERT INTO payroll_periods (company_id, name, period_start, period_end, pay_date, status, created_by)
         VALUES (?, ?, ?, ?, ?, 'DRAFT', ?)`
      )
      .run(companyId, name.trim(), period_start, period_end, pay_date || null, user.id);
    const periodId = info.lastInsertRowid;

    const insertEntry = db.prepare(
      `INSERT INTO payroll_entries
         (payroll_period_id, employee_id, days_paid, rate_type, rate_amount_cents,
          basic_pay_cents, gross_pay_cents, net_pay_cents)
       VALUES (?, ?, 0, ?, ?, 0, 0, 0)`
    );
    for (const emp of employees) {
      insertEntry.run(periodId, emp.id, emp.rate_type, emp.rate_amount_cents);
    }
    return periodId;
  });

  const periodId = createPeriodTxn();
  logAction(user.id, 'CREATE', 'payroll_period', periodId, `Created payroll period ${name} with ${employees.length} employee(s)`);
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
      acc.gross += e.gross_pay_cents;
      acc.net += e.net_pay_cents;
      return acc;
    },
    { gross: 0, net: 0 }
  );

  res.render('payroll/view', { period, entries, totals, canEdit: period.status === 'DRAFT' });
});

// ---- Update one entry's days paid (DRAFT only) ----
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
  const { basicPayCents, grossPayCents, netPayCents } = computeEntry({
    rateType: entry.rate_type,
    rateAmountCents: entry.rate_amount_cents,
    daysPaid,
  });

  db.prepare(
    `UPDATE payroll_entries
     SET days_paid = ?, basic_pay_cents = ?, gross_pay_cents = ?, net_pay_cents = ?
     WHERE id = ?`
  ).run(daysPaid, basicPayCents, grossPayCents, netPayCents, entry.id);

  logAction(
    req.session.user.id,
    'UPDATE',
    'payroll_entry',
    entry.id,
    `Set days_paid=${daysPaid} for employee ${entry.employee_id} in period ${period.id}`
  );
  res.redirect(`/payroll/${period.id}`);
});

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
