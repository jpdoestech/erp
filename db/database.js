const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, 'erp.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Idempotent: safe to run on every boot (CREATE TABLE IF NOT EXISTS).
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Lightweight migrations for columns added after a database already existed.
// ALTER TABLE ... ADD COLUMN has no "IF NOT EXISTS" in SQLite, so guard with try/catch.
const migrations = [
  "ALTER TABLE payroll_entries ADD COLUMN premium_pay_cents INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE payroll_periods ADD COLUMN pay_frequency TEXT NOT NULL DEFAULT 'SEMI_MONTHLY'",
  "ALTER TABLE payroll_entries ADD COLUMN sss_employee_cents INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE payroll_entries ADD COLUMN sss_employer_cents INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE payroll_entries ADD COLUMN philhealth_employee_cents INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE payroll_entries ADD COLUMN philhealth_employer_cents INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE payroll_entries ADD COLUMN pagibig_employee_cents INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE payroll_entries ADD COLUMN pagibig_employer_cents INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE payroll_entries ADD COLUMN withholding_tax_cents INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE payroll_entries ADD COLUMN total_deductions_cents INTEGER NOT NULL DEFAULT 0",
];
for (const sql of migrations) {
  try {
    db.exec(sql);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}

// payroll_entry_lines originally had a CHECK constraint limiting pay_type to
// the first 5 codes. Day-type combination codes (e.g. OT_LEGAL_HOLIDAY_REST_DAY)
// added later would violate that CHECK on any database created before this
// change. SQLite can't ALTER a CHECK constraint away, so detect the old
// definition and rebuild the table (preserving all existing rows) instead.
const existingTable = db
  .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payroll_entry_lines'")
  .get();
if (existingTable && /CHECK\s*\(\s*pay_type/i.test(existingTable.sql)) {
  const rebuild = db.transaction(() => {
    db.exec('ALTER TABLE payroll_entry_lines RENAME TO payroll_entry_lines_old');
    db.exec(`
      CREATE TABLE payroll_entry_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payroll_entry_id INTEGER NOT NULL REFERENCES payroll_entries(id),
        pay_type TEXT NOT NULL,
        quantity REAL NOT NULL DEFAULT 0,
        amount_cents INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      INSERT INTO payroll_entry_lines (id, payroll_entry_id, pay_type, quantity, amount_cents, created_at)
      SELECT id, payroll_entry_id, pay_type, quantity, amount_cents, created_at FROM payroll_entry_lines_old
    `);
    db.exec('DROP TABLE payroll_entry_lines_old');
  });
  rebuild();
  console.log('Migrated payroll_entry_lines to drop the fixed pay_type CHECK constraint.');
}

module.exports = db;
