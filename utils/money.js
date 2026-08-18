// All money is stored/computed as INTEGER cents/centavos. Never use floats for money math.

function pesosToCents(pesosStr) {
  const n = Number(pesosStr);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function centsToDisplay(cents) {
  const n = Number(cents) || 0;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const pesos = Math.floor(abs / 100);
  const centavos = String(abs % 100).padStart(2, '0');
  return `${sign}₱${pesos.toLocaleString('en-PH')}.${centavos}`;
}

module.exports = { pesosToCents, centsToDisplay };
