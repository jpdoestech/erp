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
  pay_frequency TEXT NOT NULL DEFAULT 'SEMI_MONTHLY'
    CHECK(pay_frequency IN ('MONTHLY','SEMI_MONTHLY','BIWEEKLY','WEEKLY')),
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
  premium_pay_cents INTEGER NOT NULL DEFAULT 0,
  adjustments_cents INTEGER NOT NULL DEFAULT 0,
  gross_pay_cents INTEGER NOT NULL DEFAULT 0,
  sss_employee_cents INTEGER NOT NULL DEFAULT 0,
  sss_employer_cents INTEGER NOT NULL DEFAULT 0,
  philhealth_employee_cents INTEGER NOT NULL DEFAULT 0,
  philhealth_employer_cents INTEGER NOT NULL DEFAULT 0,
  pagibig_employee_cents INTEGER NOT NULL DEFAULT 0,
  pagibig_employer_cents INTEGER NOT NULL DEFAULT 0,
  withholding_tax_cents INTEGER NOT NULL DEFAULT 0,
  loan_deduction_cents INTEGER NOT NULL DEFAULT 0,
  total_deductions_cents INTEGER NOT NULL DEFAULT 0,
  net_pay_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(payroll_period_id, employee_id)
);

-- One row per premium-pay component (any pay-type code from utils/payroll-calc.js:
-- OT, ND, Rest Day, Holiday, and their day-type combinations) applied to a payroll
-- entry. Regular pay itself stays on the parent payroll_entries row (days_paid /
-- basic_pay_cents) rather than as a line here. pay_type is validated in
-- application code (against PAY_TYPES), not via a DB CHECK constraint, so new
-- pay types can be added without a schema migration.
CREATE TABLE IF NOT EXISTS payroll_entry_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payroll_entry_id INTEGER NOT NULL REFERENCES payroll_entries(id),
  pay_type TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Employee loans and cash advances. balance_cents decreases as deductions are
-- applied to payroll entries (symmetric add/remove while a period is DRAFT,
-- same pattern as payroll_entry_lines above).
CREATE TABLE IF NOT EXISTS employee_loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  loan_type TEXT NOT NULL CHECK(loan_type IN ('SSS_LOAN','PAGIBIG_LOAN','COMPANY_LOAN','CASH_ADVANCE','OTHER')),
  description TEXT,
  principal_cents INTEGER NOT NULL,
  balance_cents INTEGER NOT NULL,
  installment_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','COMPLETED','CANCELLED')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- One row per period a loan was deducted in. Deleting a row (only while the
-- period is DRAFT) restores the amount to the loan's balance.
CREATE TABLE IF NOT EXISTS payroll_loan_deductions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payroll_entry_id INTEGER NOT NULL REFERENCES payroll_entries(id),
  loan_id INTEGER NOT NULL REFERENCES employee_loans(id),
  amount_cents INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Free-form additions ("Other Income / Adjustments") on a payroll entry --
-- e.g. allowances, reimbursements, one-off bonuses. Added to gross pay.
CREATE TABLE IF NOT EXISTS payroll_entry_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payroll_entry_id INTEGER NOT NULL REFERENCES payroll_entries(id),
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Payroll Studio: per-company overrides of the standard pay computation
-- basis and premium-pay multipliers. Absence of a row (or a NULL column)
-- means "use the standard default" -- see utils/payroll-calc.js. Changing
-- these never retroactively changes already-computed entries: amounts are
-- computed and stored at save time, not recalculated live from current
-- settings, so past payroll periods stay exactly as they were run.
CREATE TABLE IF NOT EXISTS company_pay_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id),
  monthly_divisor REAL NOT NULL DEFAULT 26,
  hours_per_day REAL NOT NULL DEFAULT 8,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS company_pay_type_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  pay_type TEXT NOT NULL,
  multiplier REAL NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, pay_type)
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
