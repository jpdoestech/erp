-- ERP Payroll Phase 1 schema
-- Money is always stored as INTEGER cents/centavos (decimal-safe, no floats).

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  head_office TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, code)
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, code)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('SUPER_ADMIN','COMPANY_ADMIN','PAYROLL_APPROVER','BRANCH_USER')),
  company_id INTEGER REFERENCES companies(id),
  branch_id INTEGER REFERENCES branches(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  employee_no TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  rate_type TEXT NOT NULL CHECK(rate_type IN ('DAILY','MONTHLY')),
  rate_amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, employee_no)
);

-- Effective-dated deployment: a new transfer closes the old row (effective_end + is_current=0)
-- and opens a new one, rather than overwriting history.
CREATE TABLE IF NOT EXISTS employee_deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  client_id INTEGER REFERENCES clients(id),
  effective_start TEXT NOT NULL,
  effective_end TEXT,
  is_current INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payroll_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  pay_date TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK(status IN ('DRAFT','FOR_REVIEW','APPROVED','FINALIZED','POSTED')),
  created_by INTEGER REFERENCES users(id),
  submitted_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  finalized_at TEXT,
  posted_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payroll_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payroll_period_id INTEGER NOT NULL REFERENCES payroll_periods(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  days_paid REAL NOT NULL DEFAULT 0,
  rate_type TEXT NOT NULL,
  rate_amount_cents INTEGER NOT NULL,
  basic_pay_cents INTEGER NOT NULL DEFAULT 0,
  gross_pay_cents INTEGER NOT NULL DEFAULT 0,
  net_pay_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(payroll_period_id, employee_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
