const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireLogin, requireRole, getScopedCompanyId } = require('../middleware/auth');
const { logAction } = require('../db/audit');
const { PAY_TYPES, DAY_ROW_ORDER, STANDARD_MONTHLY_DIVISOR, STANDARD_HOURS_PER_DAY } = require('../utils/payroll-calc');

router.use(requireLogin);
// Payroll Studio changes company-wide pay policy -- maker/admin territory,
// not something a viewer or approver should be able to touch.
router.use(requireRole('SUPER_ADMIN', 'COMPANY_ADMIN'));

// Grouped the same way the "Add a pay type" dropdown groups them, so the
// settings page reads the same way the data-entry page does.
const PAY_TYPE_GROUPS = ['Full-day pay (Rest Day / Holiday)', 'Overtime', 'Night Differential'];

function loadStudioData(companyId) {
  const settings = db.prepare('SELECT * FROM company_pay_settings WHERE company_id = ?').get(companyId);
  const overrideRows = db
    .prepare('SELECT pay_type, multiplier FROM company_pay_type_rates WHERE company_id = ?')
    .all(companyId);
  const overrides = {};
  overrideRows.forEach((o) => (overrides[o.pay_type] = o.multiplier));

  const groups = PAY_TYPE_GROUPS.map((groupName) => ({
    name: groupName,
    rows: Object.keys(PAY_TYPES)
      .filter((key) => PAY_TYPES[key].group === groupName)
      .map((key) => ({
        key,
        label: PAY_TYPES[key].label,
        basis: PAY_TYPES[key].basis,
        defaultMultiplier: PAY_TYPES[key].multiplier,
        currentMultiplier: overrides[key] !== undefined ? overrides[key] : PAY_TYPES[key].multiplier,
        isOverridden: overrides[key] !== undefined,
      })),
  }));

  return {
    monthlyDivisor: settings ? settings.monthly_divisor : STANDARD_MONTHLY_DIVISOR,
    hoursPerDay: settings ? settings.hours_per_day : STANDARD_HOURS_PER_DAY,
    monthlyDivisorOverridden: !!settings,
    groups,
  };
}

router.get('/', (req, res) => {
  const companyId = getScopedCompanyId(req);
  const companies =
    req.session.user.role === 'SUPER_ADMIN'
      ? db.prepare('SELECT * FROM companies ORDER BY name').all()
      : null;

  if (!companyId) {
    return res.render('studio/index', { companies, selectedCompanyId: null, studio: null, error: null, saved: false });
  }
  const studio = loadStudioData(companyId);
  res.render('studio/index', { companies, selectedCompanyId: companyId, studio, error: null, saved: req.query.saved === '1' });
});

router.post('/', (req, res) => {
  const user = req.session.user;
  const companyId = user.role === 'SUPER_ADMIN' ? Number(req.body.company_id) : user.company_id;
  if (!companyId) return res.status(400).render('error', { message: 'Select a company first.' });

  const monthlyDivisor = Number(req.body.monthly_divisor);
  const hoursPerDay = Number(req.body.hours_per_day);

  const renderError = (error) => {
    const companies =
      user.role === 'SUPER_ADMIN' ? db.prepare('SELECT * FROM companies ORDER BY name').all() : null;
    return res.status(400).render('studio/index', {
      companies,
      selectedCompanyId: companyId,
      studio: loadStudioData(companyId),
      error,
      saved: false,
    });
  };

  if (!monthlyDivisor || monthlyDivisor <= 0) {
    return renderError('Monthly divisor must be a positive number.');
  }
  if (!hoursPerDay || hoursPerDay <= 0) {
    return renderError('Hours per day must be a positive number.');
  }

  const saveTxn = db.transaction(() => {
    db.prepare(
      `INSERT INTO company_pay_settings (company_id, monthly_divisor, hours_per_day, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(company_id) DO UPDATE SET monthly_divisor = excluded.monthly_divisor, hours_per_day = excluded.hours_per_day, updated_at = excluded.updated_at`
    ).run(companyId, monthlyDivisor, hoursPerDay);

    for (const key of Object.keys(PAY_TYPES)) {
      const raw = req.body[`multiplier_${key}`];
      if (raw === undefined || raw === '') continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) continue;

      if (Math.abs(value - PAY_TYPES[key].multiplier) < 1e-9) {
        // Matches the default exactly -- no need to store an override row.
        db.prepare('DELETE FROM company_pay_type_rates WHERE company_id = ? AND pay_type = ?').run(companyId, key);
      } else {
        db.prepare(
          `INSERT INTO company_pay_type_rates (company_id, pay_type, multiplier, updated_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(company_id, pay_type) DO UPDATE SET multiplier = excluded.multiplier, updated_at = excluded.updated_at`
        ).run(companyId, key, value);
      }
    }
  });
  saveTxn();

  logAction(user.id, 'UPDATE', 'company_pay_settings', companyId, 'Updated Payroll Studio settings');
  res.redirect(`/studio?company_id=${companyId}&saved=1`);
});

// Reset one pay type's multiplier back to the standard default.
router.post('/reset/:payType', (req, res) => {
  const user = req.session.user;
  const companyId = user.role === 'SUPER_ADMIN' ? Number(req.body.company_id) : user.company_id;
  if (!companyId) return res.status(400).render('error', { message: 'Select a company first.' });
  if (!PAY_TYPES[req.params.payType]) {
    return res.status(404).render('error', { message: 'Unknown pay type.' });
  }
  db.prepare('DELETE FROM company_pay_type_rates WHERE company_id = ? AND pay_type = ?').run(companyId, req.params.payType);
  logAction(user.id, 'UPDATE', 'company_pay_type_rates', companyId, `Reset ${req.params.payType} to default`);
  res.redirect(`/studio?company_id=${companyId}&saved=1`);
});

// Reset the Regular-pay basis (monthly divisor / hours per day) back to standard defaults.
router.post('/reset-basis', (req, res) => {
  const user = req.session.user;
  const companyId = user.role === 'SUPER_ADMIN' ? Number(req.body.company_id) : user.company_id;
  if (!companyId) return res.status(400).render('error', { message: 'Select a company first.' });
  db.prepare('DELETE FROM company_pay_settings WHERE company_id = ?').run(companyId);
  logAction(user.id, 'UPDATE', 'company_pay_settings', companyId, 'Reset monthly divisor / hours per day to defaults');
  res.redirect(`/studio?company_id=${companyId}&saved=1`);
});

module.exports = router;
