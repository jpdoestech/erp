const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireLogin, requireRole, getScopedCompanyId } = require('../middleware/auth');
const { logAction } = require('../db/audit');

router.use(requireLogin);

router.get('/', (req, res) => {
  const companyId = getScopedCompanyId(req);
  const companies =
    req.session.user.role === 'SUPER_ADMIN'
      ? db.prepare('SELECT * FROM companies ORDER BY name').all()
      : null;

  if (!companyId) {
    return res.render('clients/list', { clients: [], companies, selectedCompanyId: null });
  }
  const clients = db
    .prepare(
      `SELECT clients.*, branches.name AS branch_name
       FROM clients JOIN branches ON branches.id = clients.branch_id
       WHERE clients.company_id = ? ORDER BY clients.name`
    )
    .all(companyId);
  res.render('clients/list', { clients, companies, selectedCompanyId: companyId });
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
  res.render('clients/new', { error: null, companies, branches, selectedCompanyId: companyId, values: {} });
});

router.post('/', requireRole('SUPER_ADMIN', 'COMPANY_ADMIN'), (req, res) => {
  const user = req.session.user;
  const companyId = user.role === 'SUPER_ADMIN' ? Number(req.body.company_id) : user.company_id;
  const { code, name, branch_id } = req.body;

  // Defense in depth: confirm the chosen branch actually belongs to the scoped company.
  const branch = branch_id
    ? db.prepare('SELECT * FROM branches WHERE id = ? AND company_id = ?').get(branch_id, companyId)
    : null;

  if (!companyId || !code || !name || !branch || !code.trim() || !name.trim()) {
    const branches = companyId
      ? db.prepare('SELECT * FROM branches WHERE company_id = ? ORDER BY name').all(companyId)
      : [];
    return res.render('clients/new', {
      error: 'Company, a valid branch, code, and name are required.',
      companies: user.role === 'SUPER_ADMIN' ? db.prepare('SELECT * FROM companies ORDER BY name').all() : null,
      branches,
      selectedCompanyId: companyId,
      values: req.body,
    });
  }

  try {
    const info = db
      .prepare('INSERT INTO clients (company_id, branch_id, code, name) VALUES (?, ?, ?, ?)')
      .run(companyId, branch.id, code.trim(), name.trim());
    logAction(user.id, 'CREATE', 'client', info.lastInsertRowid, `Created client ${name}`);
    res.redirect(`/clients?company_id=${companyId}`);
  } catch (e) {
    const branches = db.prepare('SELECT * FROM branches WHERE company_id = ? ORDER BY name').all(companyId);
    res.render('clients/new', {
      error: 'Client code must be unique within the company.',
      companies: user.role === 'SUPER_ADMIN' ? db.prepare('SELECT * FROM companies ORDER BY name').all() : null,
      branches,
      selectedCompanyId: companyId,
      values: req.body,
    });
  }
});

module.exports = router;
