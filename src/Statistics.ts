/** Scale before summing so a finite mean does not overflow with its inputs. */
export function average(values: readonly number[]): number {
  const scale = values.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
  if (scale === 0) return 0;
  return (values.reduce((sum, value) => sum + value / scale, 0) / values.length) * scale;
}

/** Center first to retain nearby values, then scale to avoid squared overflow or underflow. */
export function dispersion(
  values: readonly number[],
  sample: boolean,
  standardDeviation: boolean,
): number {
  const origin = values[0]!;
  let offsets = values.map((value) => value - origin);
  if (offsets.some((offset) => !Number.isFinite(offset))) offsets = [...values];
  const scale = offsets.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
  if (scale === 0) return 0;
  const normalized = offsets.map((value) => value / scale);
  const mean = normalized.reduce((sum, value) => sum + value, 0) / values.length;
  const squared =
    normalized.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - (sample ? 1 : 0));
  return standardDeviation ? Math.sqrt(squared) * scale : squared * scale * scale;
}
