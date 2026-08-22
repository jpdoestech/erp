const bcrypt = require('bcryptjs');
const db = require('./database');

function upsertUser(username, password, full_name, role, company_id, branch_id) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return existing.id;
  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare(
      `INSERT INTO users (username, password_hash, full_name, role, company_id, branch_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(username, hash, full_name, role, company_id || null, branch_id || null);
  return info.lastInsertRowid;
}

// 1. Super admin (always seeded)
upsertUser('admin', 'admin123', 'System Administrator', 'SUPER_ADMIN', null, null);
console.log('SUPER_ADMIN  -> username: admin       / password: admin123');

// 2. One demo company with a branch, client, company admin, and a couple of employees
let company = db.prepare('SELECT id FROM companies WHERE code = ?').get('DEMO');
let companyId;
if (!company) {
  const info = db
    .prepare('INSERT INTO companies (code, name) VALUES (?, ?)')
    .run('DEMO', 'Demo Manpower Services Inc.');
  companyId = info.lastInsertRowid;
} else {
  companyId = company.id;
}

let branch = db.prepare('SELECT id FROM branches WHERE company_id = ? AND code = ?').get(companyId, 'HO-MNL');
let branchId;
if (!branch) {
  const info = db
    .prepare('INSERT INTO branches (company_id, code, name, head_office) VALUES (?, ?, ?, ?)')
    .run(companyId, 'HO-MNL', 'Manila Head Office', 'Manila Head Office');
  branchId = info.lastInsertRowid;
} else {
  branchId = branch.id;
}

let client = db.prepare('SELECT id FROM clients WHERE company_id = ? AND code = ?').get(companyId, 'ACME');
let clientId;
if (!client) {
  const info = db
    .prepare('INSERT INTO clients (company_id, branch_id, code, name) VALUES (?, ?, ?, ?)')
    .run(companyId, branchId, 'ACME', 'ACME Retail Corp.');
  clientId = info.lastInsertRowid;
} else {
  clientId = client.id;
}

upsertUser('companyadmin', 'admin123', 'Dela Cruz, Juan (Company Admin)', 'COMPANY_ADMIN', companyId, null);
console.log('COMPANY_ADMIN-> username: companyadmin / password: admin123 (Demo Manpower Services Inc.)');

upsertUser('branchuser', 'admin123', 'Santos, Maria (Branch User)', 'BRANCH_USER', companyId, branchId);
console.log('BRANCH_USER  -> username: branchuser  / password: admin123 (Manila Head Office, view-only)');

upsertUser('payrollapprover', 'admin123', 'Bautista, Jose (Payroll Approver)', 'PAYROLL_APPROVER', companyId, null);
console.log('APPROVER     -> username: payrollapprover / password: admin123 (approves payroll for Demo Manpower Services Inc.)');

const demoEmployees = [
  { no: 'EMP-0001', first: 'Pedro', last: 'Reyes', rateType: 'DAILY', rateCents: 65000, hireDate: '2023-03-15', department: 'Field Operations', position: 'Janitorial Staff' }, // PHP 650.00/day
  { no: 'EMP-0002', first: 'Ana', last: 'Garcia', rateType: 'MONTHLY', rateCents: 1800000, hireDate: '2021-06-01', department: 'Client Services', position: 'Account Coordinator' }, // PHP 18,000.00/month
];

for (const e of demoEmployees) {
  let emp = db
    .prepare('SELECT id FROM employees WHERE company_id = ? AND employee_no = ?')
    .get(companyId, e.no);
  let empId;
  if (!emp) {
    const info = db
      .prepare(
        `INSERT INTO employees
           (company_id, employee_no, first_name, last_name, hire_date, department, position, rate_type, rate_amount_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(companyId, e.no, e.first, e.last, e.hireDate, e.department, e.position, e.rateType, e.rateCents);
    empId = info.lastInsertRowid;
  } else {
    empId = emp.id;
  }
  const deployment = db
    .prepare('SELECT id FROM employee_deployments WHERE employee_id = ? AND is_current = 1')
    .get(empId);
  if (!deployment) {
    db.prepare(
      `INSERT INTO employee_deployments (employee_id, branch_id, client_id, effective_start, is_current)
       VALUES (?, ?, ?, date('now'), 1)`
    ).run(empId, branchId, clientId);
  }
}

console.log('Seed complete: 1 company, 1 branch, 1 client, 2 employees.');
