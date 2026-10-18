export function calculatePoints(
  quantity: number,
  multiplier = 10
) {
  return Math.max(
    10,
    quantity * multiplier
  );
}
