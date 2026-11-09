import { getCartTotals } from '../cart/totals.js';

export const MAX_ORDER_EUROS = 5000;

/** Orders above the limit need a manual credit check before they can be placed. */
export function needsCreditCheck(items) {
  return getCartTotals(items).gross > MAX_ORDER_EUROS;
}
