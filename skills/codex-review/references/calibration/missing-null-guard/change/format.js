export function formatPrice(price) {
  return `$${price.toFixed(2)}`;
}

export function renderCart(items) {
  return items.map((i) => formatPrice(i.discountPrice)).join(', ');
}
