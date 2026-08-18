const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireLogin, requireRole, getScopedCompanyId, assertCompanyScope } = require('../middleware/auth');
const { logAction } = require('../db/audit');
const { pesosToCents } = require('../utils/money');

router.use(requireLogin);

router.get('/', (req, res) => {
  const companyId = getScopedCompanyId(req);
  const companies =
    req.session.user.role === 'SUPER_ADMIN'
      ? db.prepare('SELECT * FROM companies ORDER BY name').all()
      : null;

  if (!companyId) {
    return res.render('employees/list', { employees: [], companies, selectedCompanyId: null });
  }

  const employees = db
    .prepare(
      `SELECT e.*, b.name AS branch_name, c.name AS client_name
       FROM employees e
       LEFT JOIN employee_deployments d ON d.employee_id = e.id AND d.is_current = 1
       LEFT JOIN branches b ON b.id = d.branch_id
       LEFT JOIN clients c ON c.id = d.client_id
       WHERE e.company_id = ?
       ORDER BY e.last_name, e.first_name`
    )
    .all(companyId);

  res.render('employees/list', { employees, companies, selectedCompanyId: companyId });
});

router.get('/new', requireRole('SUPER_ADMIN', 'COMPANY_ADMIN'), (req, res) => {
  const companyId = getScopedCompanyId(req);
  const companies =
    req.session.user.role === 'SUPER_ADMIN'
      ? db.prepare('SELECT * FROM companies ORDER BY name').all()
      : null;
  const branches = companyId
    ? db.prepare('SELECT * FROM branches WHERE company_id = ? ORDER BY name').all(companyId)
    : [];
  const clients = companyId
    ? db.prepare('SELECT * FROM clients WHERE company_id = ? ORDER BY name').all(companyId)
    : [];
  res.render('employees/new', {
    error: null,
    companies,
    branches,
    clients,
    selectedCompanyId: companyId,
    values: {},
  });
});

router.post('/', requireRole('SUPER_ADMIN', 'COMPANY_ADMIN'), (req, res) => {
  const user = req.session.user;
  const companyId = user.role === 'SUPER_ADMIN' ? Number(req.body.company_id) : user.company_id;
  const { employee_no, first_name, last_name, rate_type, rate_amount, branch_id, client_id } = req.body;

  const branch = branch_id
    ? db.prepare('SELECT * FROM branches WHERE id = ? AND company_id = ?').get(branch_id, companyId)
    : null;
  const client = client_id
    ? db.prepare('SELECT * FROM clients WHERE id = ? AND company_id = ?').get(client_id, companyId)
    : null;

  const rerender = (error) => {
    const branches = companyId
      ? db.prepare('SELECT * FROM branches WHERE company_id = ? ORDER BY name').all(companyId)
      : [];
    const clients = companyId
      ? db.prepare('SELECT * FROM clients WHERE company_id = ? ORDER BY name').all(companyId)
      : [];
    res.render('employees/new', {
      error,
      companies: user.role === 'SUPER_ADMIN' ? db.prepare('SELECT * FROM companies ORDER BY name').all() : null,
      branches,
      clients,
      selectedCompanyId: companyId,
      values: req.body,
    });
  };

  if (!companyId || !employee_no || !first_name || !last_name || !branch) {
    return rerender('Company, employee no., name, and a valid branch are required.');
  }
  if (!['DAILY', 'MONTHLY'].includes(rate_type)) {
    return rerender('Rate type must be Daily or Monthly.');
  }
  const rateCents = pesosToCents(rate_amount);
  if (!rateCents || rateCents <= 0) {
    return rerender('Rate amount must be a positive number.');
  }

  try {
    const info = db
      .prepare(
        `INSERT INTO employees (company_id, employee_no, first_name, last_name, rate_type, rate_amount_cents)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(companyId, employee_no.trim(), first_name.trim(), last_name.trim(), rate_type, rateCents);
    const employeeId = info.lastInsertRowid;

    db.prepare(
      `INSERT INTO employee_deployments (employee_id, branch_id, client_id, effective_start, is_current)
       VALUES (?, ?, ?, date('now'), 1)`
    ).run(employeeId, branch.id, client ? client.id : null);

    logAction(
      user.id,
      'CREATE',
      'employee',
      employeeId,
      `Created employee ${first_name} ${last_name} (${employee_no})`
    );
    res.redirect(`/employees?company_id=${companyId}`);
  } catch (e) {
    rerender('Employee number must be unique within the company.');
  }
});

// ---- Employee detail: current deployment + transfer history ----
router.get('/:id', (req, res) => {
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) return res.status(404).render('error', { message: 'Employee not found.' });
  if (!assertCompanyScope(req, employee.company_id)) {
    return res.status(403).render('error', { message: 'You do not have access to this employee.' });
  }

  const deployments = db
    .prepare(
      `SELECT d.*, b.name AS branch_name, c.name AS client_name
       FROM employee_deployments d
       LEFT JOIN branches b ON b.id = d.branch_id
       LEFT JOIN clients c ON c.id = d.client_id
       WHERE d.employee_id = ?
       ORDER BY d.effective_start DESC, d.id DESC`
    )
    .all(employee.id);

  res.render('employees/view', { employee, deployments });
});

// ---- Transfer form ----
router.get('/:id/transfer', requireRole('SUPER_ADMIN', 'COMPANY_ADMIN'), (req, res) => {
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) return res.status(404).render('error', { message: 'Employee not found.' });
  if (!assertCompanyScope(req, employee.company_id)) {
    return res.status(403).render('error', { message: 'You do not have access to this employee.' });
  }
  const branches = db
    .prepare('SELECT * FROM branches WHERE company_id = ? ORDER BY name')
    .all(employee.company_id);
  const clients = db
    .prepare('SELECT * FROM clients WHERE company_id = ? ORDER BY name')
    .all(employee.company_id);
  const currentDeployment = db
    .prepare('SELECT * FROM employee_deployments WHERE employee_id = ? AND is_current = 1')
    .get(employee.id);

  res.render('employees/transfer', {
    employee,
    branches,
    clients,
    currentDeployment,
    error: null,
    values: {},
  });
});

// ---- Perform transfer: close old deployment, open a new one. Never overwrites history. ----
router.post('/:id/transfer', requireRole('SUPER_ADMIN', 'COMPANY_ADMIN'), (req, res) => {
  const user = req.session.user;
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) return res.status(404).render('error', { message: 'Employee not found.' });
  if (!assertCompanyScope(req, employee.company_id)) {
    return res.status(403).render('error', { message: 'You do not have access to this employee.' });
  }

  const { branch_id, client_id, effective_start } = req.body;
  const branch = branch_id
    ? db.prepare('SELECT * FROM branches WHERE id = ? AND company_id = ?').get(branch_id, employee.company_id)
    : null;
  const client = client_id
    ? db.prepare('SELECT * FROM clients WHERE id = ? AND company_id = ?').get(client_id, employee.company_id)
    : null;

  const rerender = (error) => {
    const branches = db
      .prepare('SELECT * FROM branches WHERE company_id = ? ORDER BY name')
      .all(employee.company_id);
    const clients = db
      .prepare('SELECT * FROM clients WHERE company_id = ? ORDER BY name')
      .all(employee.company_id);
    const currentDeployment = db
      .prepare('SELECT * FROM employee_deployments WHERE employee_id = ? AND is_current = 1')
      .get(employee.id);
    res.render('employees/transfer', {
      employee,
      branches,
      clients,
      currentDeployment,
      error,
      values: req.body,
    });
  };

  if (!branch || !effective_start) {
    return rerender('A valid branch and an effective date are required.');
  }

  const currentDeployment = db
    .prepare('SELECT * FROM employee_deployments WHERE employee_id = ? AND is_current = 1')
    .get(employee.id);
  if (currentDeployment && currentDeployment.effective_start > effective_start) {
    return rerender('Effective date cannot be earlier than the current assignment\'s start date.');
  }

  const transferTxn = db.transaction(() => {
    if (currentDeployment) {
      db.prepare(
        `UPDATE employee_deployments SET is_current = 0, effective_end = ? WHERE id = ?`
      ).run(effective_start, currentDeployment.id);
    }
    db.prepare(
      `INSERT INTO employee_deployments (employee_id, branch_id, client_id, effective_start, is_current)
       VALUES (?, ?, ?, ?, 1)`
    ).run(employee.id, branch.id, client ? client.id : null, effective_start);
  });
  transferTxn();

  logAction(
    user.id,
    'TRANSFER',
    'employee',
    employee.id,
    `Transferred to branch ${branch.name}${client ? ' / client ' + client.name : ''} effective ${effective_start}`
  );
  res.redirect(`/employees/${employee.id}`);
});

module.exports = router;
