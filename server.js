require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./db/database');
const { requireLogin } = require('./middleware/auth');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'change-this-secret-before-production',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8-hour session
  })
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.currentPath = req.path;
  next();
});

app.use('/', require('./routes/auth'));
app.use('/companies', require('./routes/companies'));
app.use('/branches', require('./routes/branches'));
app.use('/clients', require('./routes/clients'));
app.use('/employees', require('./routes/employees'));
app.use('/loans', require('./routes/loans'));
app.use('/payroll', require('./routes/payroll'));
app.use('/reports', require('./routes/reports'));
app.use('/studio', require('./routes/studio'));

app.get('/', requireLogin, (req, res) => {
  const user = req.session.user;
  const companyFilter = user.role === 'SUPER_ADMIN' ? null : user.company_id;

  const count = (sql, ...params) => db.prepare(sql).get(...params).c;

  const stats = {
    companies: count('SELECT COUNT(*) c FROM companies'),
    branches: companyFilter
      ? count('SELECT COUNT(*) c FROM branches WHERE company_id = ?', companyFilter)
      : count('SELECT COUNT(*) c FROM branches'),
    clients: companyFilter
      ? count('SELECT COUNT(*) c FROM clients WHERE company_id = ?', companyFilter)
      : count('SELECT COUNT(*) c FROM clients'),
    employees: companyFilter
      ? count("SELECT COUNT(*) c FROM employees WHERE company_id = ? AND status='ACTIVE'", companyFilter)
      : count("SELECT COUNT(*) c FROM employees WHERE status='ACTIVE'"),
    openPayrolls: companyFilter
      ? count("SELECT COUNT(*) c FROM payroll_periods WHERE company_id = ? AND status != 'POSTED'", companyFilter)
      : count("SELECT COUNT(*) c FROM payroll_periods WHERE status != 'POSTED'"),
  };

  res.render('dashboard', { stats });
});

app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));

// Central error handler: never leak stack traces / SQL / internals to the client.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: 'Something went wrong. Please try again.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ERP Payroll (Phase 1) running at http://localhost:${PORT}`);
});
