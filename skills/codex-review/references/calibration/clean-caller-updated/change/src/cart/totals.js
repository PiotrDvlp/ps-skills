const VAT_RATE = 0.19;

const toEuros = (cents) => Math.round(cents) / 100;

function lineCents(item) {
  return item.unitPriceCents * item.quantity;
}

/** Cart totals in euros (two decimals), ready for display. */
export function getCartTotals(items) {
  const netCents = items.reduce((sum, item) => sum + lineCents(item), 0);
  const vatCents = Math.round(netCents * VAT_RATE);
  return { net: toEuros(netCents), vat: toEuros(vatCents), gross: toEuros(netCents + vatCents) };
}
