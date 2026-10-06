export function netPrice(gross, vat) {
  return gross - gross * vat;
}
