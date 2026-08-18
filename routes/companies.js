const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireLogin, requireRole } = require('../middleware/auth');
const { logAction } = require('../db/audit');

router.use(requireLogin);

// Only SUPER_ADMIN manages the list of companies — that's the top of the hierarchy.
router.get('/', requireRole('SUPER_ADMIN'), (req, res) => {
  const companies = db.prepare('SELECT * FROM companies ORDER BY name').all();
  res.render('companies/list', { companies });
});

router.get('/new', requireRole('SUPER_ADMIN'), (req, res) => {
  res.render('companies/new', { error: null, values: {} });
});

router.post('/', requireRole('SUPER_ADMIN'), (req, res) => {
  const { code, name } = req.body;
  if (!code || !name || !code.trim() || !name.trim()) {
    return res.render('companies/new', {
      error: 'Company code and name are required.',
      values: req.body,
    });
  }
  try {
    const info = db
      .prepare('INSERT INTO companies (code, name) VALUES (?, ?)')
      .run(code.trim(), name.trim());
    logAction(req.session.user.id, 'CREATE', 'company', info.lastInsertRowid, `Created company ${name}`);
    res.redirect('/companies');
  } catch (e) {
    res.render('companies/new', { error: 'Company code must be unique.', values: req.body });
  }
});

module.exports = router;
