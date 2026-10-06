// Shipping rate by cart total (EUR).
export function shippingRate(total) {
  if (total > 100) return 0;
  if (total > 50) return 5;
  return 10;
}
