const VAT_RATE = 0.19;

function lineCents(item) {
  return item.unitPriceCents * item.quantity;
}

/** Cart totals in integer cents. */
export function getCartTotals(items) {
  const net = items.reduce((sum, item) => sum + lineCents(item), 0);
  const vat = Math.round(net * VAT_RATE);
  return { net, vat, gross: net + vat };
}
