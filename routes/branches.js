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
    return res.render('branches/list', { branches: [], companies, selectedCompanyId: null });
  }
  const branches = db
    .prepare('SELECT * FROM branches WHERE company_id = ? ORDER BY name')
    .all(companyId);
  res.render('branches/list', { branches, companies, selectedCompanyId: companyId });
});

router.get('/new', requireRole('SUPER_ADMIN', 'COMPANY_ADMIN'), (req, res) => {
  const companyId = getScopedCompanyId(req);
  const companies =
    req.session.user.role === 'SUPER_ADMIN'
      ? db.prepare('SELECT * FROM companies ORDER BY name').all()
      : null;
  res.render('branches/new', { error: null, companies, selectedCompanyId: companyId, values: {} });
});

router.post('/', requireRole('SUPER_ADMIN', 'COMPANY_ADMIN'), (req, res) => {
  const user = req.session.user;
  const companyId = user.role === 'SUPER_ADMIN' ? Number(req.body.company_id) : user.company_id;
  const { code, name, head_office } = req.body;

  if (!companyId || !code || !name || !code.trim() || !name.trim()) {
    return res.render('branches/new', {
      error: 'Company, code, and name are required.',
      companies: user.role === 'SUPER_ADMIN' ? db.prepare('SELECT * FROM companies ORDER BY name').all() : null,
      selectedCompanyId: companyId,
      values: req.body,
    });
  }
  try {
    const info = db
      .prepare('INSERT INTO branches (company_id, code, name, head_office) VALUES (?, ?, ?, ?)')
      .run(companyId, code.trim(), name.trim(), (head_office || '').trim());
    logAction(user.id, 'CREATE', 'branch', info.lastInsertRowid, `Created branch ${name}`);
    res.redirect(`/branches?company_id=${companyId}`);
  } catch (e) {
    res.render('branches/new', {
      error: 'Branch code must be unique within the company.',
      companies: user.role === 'SUPER_ADMIN' ? db.prepare('SELECT * FROM companies ORDER BY name').all() : null,
      selectedCompanyId: companyId,
      values: req.body,
    });
  }
});

module.exports = router;
