import { getCartTotals } from './totals.js';
import { formatEuros } from '../money.js';

export function cartBadgeLabel(items) {
  if (!items.length) return 'Cart is empty';
  const { gross } = getCartTotals(items);
  return `${items.length} item(s) · ${formatEuros(gross)}`;
}
