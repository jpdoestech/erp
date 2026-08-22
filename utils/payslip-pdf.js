// Renders payslips with pdfkit (pure JS, no native binary -- installs
// cleanly everywhere, unlike a headless-browser-based PDF approach).
//
// pdfkit's built-in standard fonts (Helvetica etc.) use WinAnsiEncoding,
// which does NOT include the Philippine peso sign (₱, U+20B1). Rendering
// it with a standard font produces a blank/missing glyph. Rather than
// bundle a licensed TTF just for one symbol, money is written as
// "PHP 1,234.56" in PDF output specifically -- the on-screen HTML pages
// still show ₱ normally, since browsers render UTF-8 natively.

const PdfDocument = require('pdfkit');
const { PAY_TYPES } = require('./payroll-calc');

function money(cents) {
  return 'PHP ' + (Number(cents || 0) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 });
}

function dayRowLabel(key) {
  return key === 'REGULAR' ? 'Regular' : PAY_TYPES[key] ? PAY_TYPES[key].label.replace(/ \(OT\)| \(ND\)/, '') : key;
}

// Draws a labeled two-column row (label left, value right-aligned) at the
// document's current cursor position, then advances the cursor.
function row(doc, x, width, label, value, opts = {}) {
  const y = doc.y;
  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 9);
  doc.text(label, x, y, { width: width * 0.6 });
  doc.text(value, x + width * 0.6, y, { width: width * 0.4, align: 'right' });
  doc.moveDown(0.3);
}

function sectionHeader(doc, x, width, title) {
  doc.moveDown(0.2);
  const y = doc.y;
  doc.rect(x, y, width, 16).fill('#eef1f4');
  doc.fillColor('#212933').font('Helvetica-Bold').fontSize(8.5);
  doc.text(title.toUpperCase(), x + 6, y + 4, { width: width - 12 });
  doc.moveDown(0.9);
  doc.fillColor('#212933');
}

// Draws one full payslip onto `doc` starting at the current cursor
// position. Caller is responsible for adding a page before calling this
// for a second employee (see generatePeriodPayslipsPdf below).
function drawPayslip(doc, { company, period, entry, lines, adjustments, loanDeductions }) {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const x = doc.page.margins.left;
  const colGap = 20;
  const colWidth = (pageWidth - colGap) / 2;

  doc.fillColor('#212933');

  // ---- Letterhead ----
  doc.font('Helvetica-Bold').fontSize(14).text(company.name, x, doc.y, { width: pageWidth });
  doc.font('Helvetica').fontSize(9).fillColor('#667080').text('Payslip', x, doc.y, { width: pageWidth });
  doc.fillColor('#212933');
  doc.moveDown(0.6);
  doc.moveTo(x, doc.y).lineTo(x + pageWidth, doc.y).strokeColor('#d9dee3').stroke();
  doc.moveDown(0.6);

  // ---- Employee + period info (two columns) ----
  const infoTop = doc.y;
  doc.font('Helvetica-Bold').fontSize(11).text(`${entry.last_name}, ${entry.first_name}`, x, infoTop, { width: colWidth });
  doc.font('Helvetica').fontSize(9).fillColor('#667080');
  doc.text(`Employee No: ${entry.employee_no}`, x, doc.y, { width: colWidth });
  if (entry.position) doc.text(`Position: ${entry.position}`, x, doc.y, { width: colWidth });
  if (entry.department) doc.text(`Department: ${entry.department}`, x, doc.y, { width: colWidth });
  doc.text(`Branch: ${entry.branch_name || '—'}`, x, doc.y, { width: colWidth });
  doc.text(`Client: ${entry.client_name || '—'}`, x, doc.y, { width: colWidth });
  if (entry.hire_date) doc.text(`Hire Date: ${entry.hire_date}`, x, doc.y, { width: colWidth });
  doc.text(`Rate: ${entry.rate_type} — ${money(entry.rate_amount_cents)}${entry.rate_type === 'DAILY' ? '/day' : '/month'}`, x, doc.y, {
    width: colWidth,
  });
  doc.fillColor('#212933');

  const rightColX = x + colWidth + colGap;
  doc.font('Helvetica-Bold').fontSize(9).text('Pay Period', rightColX, infoTop, { width: colWidth, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#667080');
  doc.text(period.name, rightColX, doc.y, { width: colWidth, align: 'right' });
  doc.text(`${period.period_start} to ${period.period_end}`, rightColX, doc.y, { width: colWidth, align: 'right' });
  if (period.pay_date) doc.text(`Pay date: ${period.pay_date}`, rightColX, doc.y, { width: colWidth, align: 'right' });
  doc.text(`Frequency: ${period.pay_frequency.replace('_', ' ')}`, rightColX, doc.y, { width: colWidth, align: 'right' });
  doc.text(`Status: ${period.status.replace('_', ' ')}`, rightColX, doc.y, { width: colWidth, align: 'right' });
  doc.fillColor('#212933');

  doc.y = Math.max(doc.y, infoTop + 130);
  doc.moveDown(0.4);

  // ---- Earnings (left) / Deductions (right), two columns ----
  const twoColTop = doc.y;

  // Earnings column
  doc.y = twoColTop;
  sectionHeader(doc, x, colWidth, 'Earnings');
  row(doc, x, colWidth, 'Regular', money(entry.basic_pay_cents));
  lines
    .filter((l) => l.amount_cents > 0)
    .forEach((l) => {
      const def = PAY_TYPES[l.pay_type];
      row(doc, x, colWidth, def ? def.label : l.pay_type, money(l.amount_cents));
    });
  adjustments.forEach((a) => row(doc, x, colWidth, a.description, money(a.amount_cents)));
  doc.moveDown(0.2);
  doc.moveTo(x, doc.y).lineTo(x + colWidth, doc.y).strokeColor('#d9dee3').stroke();
  doc.moveDown(0.2);
  row(doc, x, colWidth, 'Gross Pay', money(entry.gross_pay_cents), { bold: true });
  const earningsBottom = doc.y;

  // Deductions column
  doc.y = twoColTop;
  sectionHeader(doc, rightColX, colWidth, 'Deductions');
  row(doc, rightColX, colWidth, 'SSS', money(entry.sss_employee_cents));
  row(doc, rightColX, colWidth, 'PhilHealth', money(entry.philhealth_employee_cents));
  row(doc, rightColX, colWidth, 'Pag-IBIG', money(entry.pagibig_employee_cents));
  row(doc, rightColX, colWidth, 'Withholding Tax', money(entry.withholding_tax_cents));
  loanDeductions.forEach((d) => {
    const label = d.loan_description ? `Loan — ${d.loan_description}` : 'Loan / Cash Advance';
    row(doc, rightColX, colWidth, label, money(d.amount_cents));
  });
  doc.moveDown(0.2);
  doc.moveTo(rightColX, doc.y).lineTo(rightColX + colWidth, doc.y).strokeColor('#d9dee3').stroke();
  doc.moveDown(0.2);
  row(doc, rightColX, colWidth, 'Total Deductions', money(entry.total_deductions_cents), { bold: true });
  const deductionsBottom = doc.y;

  doc.y = Math.max(earningsBottom, deductionsBottom) + 10;

  // ---- Net pay banner ----
  const bannerY = doc.y;
  doc.rect(x, bannerY, pageWidth, 30).fill('#eaf2fa');
  doc.fillColor('#184c81').font('Helvetica-Bold').fontSize(12);
  doc.text('NET PAY', x + 12, bannerY + 9);
  doc.text(money(entry.net_pay_cents), x, bannerY + 9, { width: pageWidth - 12, align: 'right' });
  doc.fillColor('#212933');
  doc.y = bannerY + 44;

  // ---- Footer ----
  doc.font('Helvetica').fontSize(7).fillColor('#667080');
  doc.text(
    'Statutory deduction rates are standard 2025-2026 defaults (SSS/PhilHealth/Pag-IBIG/BIR) and premium pay multipliers are standard DOLE defaults -- verify against official tables before relying on this for filings. Not a certified compliance document.',
    x,
    doc.y,
    { width: pageWidth }
  );
  doc.text(`Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`, x, doc.y, { width: pageWidth });
  doc.fillColor('#212933');
}

function generateSinglePayslipPdf({ company, period, entry, lines, adjustments, loanDeductions }) {
  return new Promise((resolve, reject) => {
    const doc = new PdfDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    drawPayslip(doc, { company, period, entry, lines, adjustments, loanDeductions });
    doc.end();
  });
}

// entries: array of { entry, lines, adjustments, loanDeductions } -- one per employee.
function generatePeriodPayslipsPdf({ company, period, entries }) {
  return new Promise((resolve, reject) => {
    const doc = new PdfDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    entries.forEach((e, i) => {
      if (i > 0) doc.addPage();
      drawPayslip(doc, { company, period, entry: e.entry, lines: e.lines, adjustments: e.adjustments, loanDeductions: e.loanDeductions });
    });
    doc.end();
  });
}

module.exports = { generateSinglePayslipPdf, generatePeriodPayslipsPdf, money };
