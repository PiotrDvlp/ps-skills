import { needsCreditCheck } from './limits.js';

export async function placeOrder(items, api) {
  if (!items.length) throw new Error('empty cart');
  if (needsCreditCheck(items)) {
    return api.requestCreditCheck(items);
  }
  return api.submitOrder(items);
}
