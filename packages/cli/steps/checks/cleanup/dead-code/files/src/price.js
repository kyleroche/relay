const TAX_RATE = 0.2;

function legacyRound(amount) {
  return Math.floor(amount * 100 + 0.5) / 100;
}

function round(amount) {
  return Math.round(amount * 100) / 100;
}

export function withTax(net) {
  return round(net * (1 + TAX_RATE));
}

export function total(lines) {
  return round(lines.reduce((sum, line) => sum + withTax(line.net) * line.quantity, 0));
}
