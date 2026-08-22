// Minimal CSV writer -- no external dependency. Handles quoting per RFC 4180
// (quote a field if it contains a comma, quote, or newline; double up quotes).
function csvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function toCsv(rows) {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

// Cents -> plain decimal string (no currency symbol), spreadsheet-friendly.
function centsToDecimal(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

module.exports = { toCsv, centsToDecimal };
