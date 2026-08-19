# ERP Payroll — Phase 1 (+ segregation of duties, employee transfers)

Scope for this phase, per the phased build plan: **login → Company → Branch →
Client → Employee masterlist → Payroll creation and posting**, kept
intentionally simple. This is the foundation the later phases (Payroll
Studio/formula engine, loans, government tables, full reporting) will build
on top of — not the finished ERP.

## Run it on Windows (no command line needed)

1. Unzip this folder anywhere.
2. Double-click **`setup.bat`** once — it installs dependencies and seeds demo
   data. (Requires Node.js LTS — the script will tell you if it's missing,
   with a link to install it.)
3. Double-click **`run.bat`** any time after that to start the app — it opens
   `http://localhost:3000` in your browser automatically. Close the console
   window (or Ctrl+C) to stop the server.

## Run it from a terminal (Mac/Linux/Windows)

```bash
npm install
npm run seed     # creates demo users, one company, branch, client, 2 employees
npm start         # http://localhost:3000
```

Demo accounts (from `npm run seed` / `setup.bat`):

| Username         | Password  | Role             | Scope                          |
|------------------|-----------|------------------|---------------------------------|
| `admin`          | admin123  | SUPER_ADMIN      | all companies                  |
| `companyadmin`   | admin123  | COMPANY_ADMIN    | Demo Manpower Services Inc. — maker: creates/edits/submits payroll, manages structure & employees |
| `payrollapprover`| admin123  | PAYROLL_APPROVER | Demo Manpower Services Inc. — approver only: cannot create/edit, cannot approve their own submissions |
| `branchuser`     | admin123  | BRANCH_USER      | Manila Head Office — view-only |

## What's implemented

- **UI**: restyled to match the `jpdoestech/accounting-system` reference —
  same design tokens (flat/dense manager.io-style, muted blue accent, thin
  borders instead of shadows), same sidebar-shell layout, same Bootstrap 5 +
  Bootstrap Icons via CDN, same table/badge/button/form conventions
  (`page-header` + `eyebrow`, `card` + `table-hover`, `row-action-link`,
  `badge-pill--*`). No build step needed — plain CDN links, no Vue/Vite.
- **Auth**: session-based login, bcrypt password hashing, 8-hour session.
- **Hierarchy**: Company → Branch → Client, each scoped and created under
  the level above it.
- **Employee masterlist**: employee record (rate type/amount) plus an
  effective-dated `employee_deployments` row (branch + client).
- **Employee transfers**: `/employees/:id/transfer` closes the current
  deployment (sets `effective_end` / `is_current = 0`) and opens a new one
  as of a chosen effective date — history is never overwritten, and the
  effective date can't be earlier than the current assignment's start.
  Full assignment history is visible on the employee's detail page.
- **Payroll**:
  - Create a period → all active employees of the company are auto-loaded
    as draft entries (0 days paid).
  - Enter `days_paid` per employee while the period is `DRAFT`.
  - Basic pay is computed as `days_paid × daily_rate` (daily employees) or
    `days_paid × (monthly_rate / 26)` (monthly employees). The 26-day
    divisor is a placeholder default, not a hard-coded rule — it's meant to
    become a configurable Payroll Studio input.
  - **Premium pay types**, added per employee on top of Regular pay, using
    standard DOLE default multipliers (isolated in
    `utils/payroll-calc.js`, not hard-coded elsewhere). Each day type has
    its own combined rate — a Special Holiday that also falls on the
    employee's Rest Day uses the actual 150% DOLE combo rate as one line,
    not two stacked 130% lines (which would overstate pay at 260%):

    | Day type | Full-day rate | + Overtime (per OT hr) | + Night Diff. (per hr) |
    |---|---|---|---|
    | Ordinary day | *(Regular pay field)* | 125% | +10% |
    | Rest Day | 130% | 169% | +13% |
    | Special (Non-Regular) Holiday | 130% | 169% | +13% |
    | Special Holiday on a Rest Day | 150% | 195% | +15% |
    | Regular Holiday | 200% | 260% | +20% |
    | Regular Holiday on a Rest Day | 260% | 338% | +26% |

    (Percentages are of the daily rate for full-day pay, or the hourly rate
    for OT/ND.) These are standard private-sector defaults, **not a
    certified DOLE compliance engine** — a CBA or company policy may
    legally use different rates. Open an employee's entry (via "Manage" on
    the period page) to add or remove pay-type lines, grouped by category
    in the dropdown; each entry shows Regular + Premium + Gross + Net.
  - **Government contributions & withholding tax**, auto-computed on every
    entry from its own gross pay (`utils/gov-deductions.js`):

    | Deduction | Employee | Employer | Basis |
    |---|---|---|---|
    | SSS | 5% | 10% + EC (₱10/₱30) | Monthly Salary Credit, ₱5,000–₱35,000 |
    | PhilHealth | 2.5% | 2.5% | Monthly salary, floor ₱10,000, ceiling ₱100,000 |
    | Pag-IBIG | 1–2% | 2% | Monthly salary, capped at a ₱10,000 base |
    | Withholding Tax | graduated 0–35% | — | BIR monthly bracket table (TRAIN law, 2023 onward) |

    Rates verified current for 2025–2026 as of this writing (SSS Circular
    2024-006; PhilHealth 5% confirmed unchanged for 2026 per a PIA
    advisory; Pag-IBIG HDMF Circular 460; BIR Annex "E"). **These change by
    law/circular — verify against SSS/PhilHealth/Pag-IBIG/BIR before relying
    on this for actual remittances.** Every payroll period has a **Pay
    Frequency** (Semi-Monthly by default, or Monthly/Bi-Weekly/Weekly) —
    each entry's own gross pay is scaled to a monthly-equivalent to look up
    the statutory tables, then scaled back down to that period's share, so
    semi-monthly/weekly cutoffs aren't over- or under-deducted relative to a
    full month. Net pay = Gross − (SSS + PhilHealth + Pag-IBIG + withholding
    tax) employee shares; employer shares are shown for reference only and
    don't affect the employee's net pay.
  - Workflow: `DRAFT → FOR_REVIEW → APPROVED → FINALIZED → POSTED`, with a
    `return-to-draft` step. Every transition is enforced server-side by
    current status, not just hidden/shown in the UI.
  - Once a period leaves `DRAFT`, entry edits are rejected (HTTP 409) at
    the route level, not just hidden in the UI.
  - **Segregation of duties**: the user who submitted a period
    (`submitted_by`) cannot also approve it — enforced server-side with a
    403, not just a hidden button. `SUPER_ADMIN` is the only role allowed
    to override this (useful for a small demo/testing setup — flag this to
    reconsider before real production use with more than one admin).
    A dedicated `PAYROLL_APPROVER` role exists that can view and
    approve/return periods but cannot create, edit, or manage structure.
- **Tenant isolation**: every non-super-admin request is scoped to the
  user's own `company_id` server-side (`getScopedCompanyId` /
  `assertCompanyScope` in `middleware/auth.js`), regardless of what a
  client sends in the URL or form body. Verified: tampering with
  `?company_id=` as a non-super-admin has no effect.
- **Money**: all amounts stored/computed as integer centavos, never floats.
- **Audit trail**: logins/logouts and every create/update/transfer/workflow
  transition are written to `audit_log`.
- **Error handling**: a generic error page — no stack traces, SQL, or
  internals are ever sent to the browser.

## Deliberately deferred to later phases (per the build spec's own plan)

- Loans/cash advances, leave (SL/VL), 13th month pay, de minimis benefits,
  and year-end tax annualization — Regular pay, the day-type-aware premium
  pay types, and the core statutory deductions above are now covered.
- **Payroll Studio** / configurable formula engine — Phase 1 uses one fixed
  (but isolated, in `utils/payroll-calc.js`) basic-pay formula so the rest
  of the pipeline (period lifecycle, locking, audit, segregation of duties)
  could be proven first.
- Reports/exports, pagination on large lists, and automated test suite.
- Reusing the reference repo's actual UI components — this phase matches
  the reference's design system (colors, typography, layout, component
  conventions) using plain server-rendered EJS + Bootstrap 5 rather than
  porting Vue components, since our stack is Express/EJS, not Vue/Vite.
  Visually consistent; not the same component code.

## Project layout

```
setup.bat    Windows: install dependencies + seed demo data (run once)
run.bat      Windows: start the server and open it in your browser
db/          schema.sql, sqlite connection, seed script, audit helper
middleware/  auth.js — login guard, role guard, tenant-scope enforcement
routes/      auth, companies, branches, clients, employees, payroll
utils/       money.js (cents-safe formatting), payroll-calc.js (basic pay)
views/       EJS templates, one folder per resource
public/css/  single stylesheet
```

