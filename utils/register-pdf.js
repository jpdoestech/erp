// Payroll Register PDF: one landscape table listing every employee in a
// period with the full breakdown. Pure pdfkit (no native binary), same
// "PHP 1,234.56" money convention as payslip-pdf.js (pdfkit's built-in
// fonts have no peso-sign glyph).

const PdfDocument = require('pdfkit');

function money(cents) {
  return (Number(cents || 0) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 });
}

const COLUMNS = [
  { key: 'employee_no', label: 'Emp. No.', width: 42, align: 'left' },
  { key: 'name', label: 'Name', width: 88, align: 'left' },
  { key: 'regular', label: 'Regular', width: 52, align: 'right', money: true },
  { key: 'premium', label: 'Premium', width: 52, align: 'right', money: true },
  { key: 'additions', label: 'Additions', width: 52, align: 'right', money: true },
  { key: 'gross', label: 'Gross', width: 56, align: 'right', money: true },
  { key: 'sss', label: 'SSS', width: 46, align: 'right', money: true },
  { key: 'philhealth', label: 'PhilHealth', width: 52, align: 'right', money: true },
  { key: 'pagibig', label: 'Pag-IBIG', width: 46, align: 'right', money: true },
  { key: 'wtax', label: 'W/Tax', width: 46, align: 'right', money: true },
  { key: 'loan', label: 'Loan', width: 46, align: 'right', money: true },
  { key: 'deductions', label: 'Total Ded.', width: 56, align: 'right', money: true },
  { key: 'net', label: 'Net Pay', width: 60, align: 'right', money: true },
];

function drawHeaderRow(doc, x, y) {
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#374151');
  let cx = x;
  COLUMNS.forEach((col) => {
    doc.text(col.label, cx, y, { width: col.width, align: col.align });
    cx += col.width;
  });
  doc.fillColor('#212933');
}

function drawDataRow(doc, x, y, rowData, bold) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.5);
  let cx = x;
  COLUMNS.forEach((col) => {
    const raw = rowData[col.key];
    const text = col.money ? money(raw) : String(raw);
    doc.text(text, cx, y, { width: col.width, align: col.align });
    cx += col.width;
  });
}

function generateRegisterPdf({ company, period, rows, totals }) {
  return new Promise((resolve, reject) => {
    const doc = new PdfDocument({ size: 'A4', layout: 'landscape', margin: 30 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const x = doc.page.margins.left;
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.font('Helvetica-Bold').fontSize(13).text(company.name, x, doc.y, { width: pageWidth });
    doc.font('Helvetica').fontSize(9).fillColor('#667080');
    doc.text(`Payroll Register — ${period.name} (${period.period_start} to ${period.period_end})`, x, doc.y, { width: pageWidth });
    doc.text(`Status: ${period.status.replace('_', ' ')} · Frequency: ${period.pay_frequency.replace('_', ' ')}`, x, doc.y, { width: pageWidth });
    doc.fillColor('#212933');
    doc.moveDown(0.6);

    let y = doc.y;
    doc.rect(x, y, pageWidth, 14).fill('#eef1f4');
    drawHeaderRow(doc, x + 2, y + 4);
    y += 16;
    doc.moveTo(x, y).lineTo(x + pageWidth, y).strokeColor('#d9dee3').stroke();
    y += 3;

    const rowHeight = 12;
    const bottomLimit = doc.page.height - doc.page.margins.bottom - 20;

    rows.forEach((r, i) => {
      if (y + rowHeight > bottomLimit) {
        doc.addPage();
        y = doc.page.margins.top;
        doc.rect(x, y, pageWidth, 14).fill('#eef1f4');
        drawHeaderRow(doc, x + 2, y + 4);
        y += 16;
        doc.moveTo(x, y).lineTo(x + pageWidth, y).strokeColor('#d9dee3').stroke();
        y += 3;
      }
      if (i % 2 === 1) {
        doc.rect(x, y - 1, pageWidth, rowHeight).fill('#f9fafb');
        doc.fillColor('#212933');
      }
      drawDataRow(doc, x + 2, y, r, false);
      y += rowHeight;
    });

    y += 3;
    doc.moveTo(x, y).lineTo(x + pageWidth, y).strokeColor('#212933').stroke();
    y += 3;
    drawDataRow(doc, x + 2, y, { ...totals, employee_no: '', name: 'TOTAL' }, true);
    y += rowHeight + 10;

    doc.font('Helvetica').fontSize(7).fillColor('#667080');
    doc.text(
      `Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')}. Statutory deduction rates and premium pay multipliers are standard 2025-2026 defaults -- not a certified compliance document.`,
      x,
      y,
      { width: pageWidth }
    );

    doc.end();
  });
}

module.exports = { generateRegisterPdf, COLUMNS };
