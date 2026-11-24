export function total(lines) {
  // Prices are summed as integer cents: adding floats drifts by a cent on long orders.
  return lines.reduce((sum, line) => sum + Math.round(line.price * 100) * line.quantity, 0) / 100;
}
