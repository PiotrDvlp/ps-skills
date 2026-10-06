function taxAmount(gross, vat) {
  return gross * vat;
}

export function netPrice(gross, vat) {
  return gross - taxAmount(gross, vat);
}
