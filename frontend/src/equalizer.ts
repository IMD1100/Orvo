type Coefficients = [number, number, number, number, number, number];

// Same low-shelf / peak / high-shelf equations as JUCE ArrayCoefficients.
// The engine clamps cutoff to [1, sampleRate * .49]; JUCE then floors it at 2 Hz.
export function eqCoefficients(kind: 'low' | 'mid' | 'high', frequency: number, q: number, db: number, rate: number): Coefficients {
  const a = Math.sqrt(10 ** (db / 20));
  const omega = 2 * Math.PI * Math.max(2, Math.max(1, Math.min(rate * .49, frequency))) / rate;
  const cosine = Math.cos(omega);
  if (kind === 'mid') {
    const alpha = Math.sin(omega) / (q * 2);
    return [1 + alpha * a, -2 * cosine, 1 - alpha * a, 1 + alpha / a, -2 * cosine, 1 - alpha / a];
  }
  const minus = a - 1, plus = a + 1, beta = Math.sin(omega) * Math.sqrt(a) / q;
  return kind === 'low'
    ? [a * (plus - minus * cosine + beta), a * 2 * (minus - plus * cosine), a * (plus - minus * cosine - beta), plus + minus * cosine + beta, -2 * (minus + plus * cosine), plus + minus * cosine - beta]
    : [a * (plus + minus * cosine + beta), a * -2 * (minus + plus * cosine), a * (plus + minus * cosine - beta), plus - minus * cosine + beta, 2 * (minus - plus * cosine), plus - minus * cosine - beta];
}

export function magnitudeDb(coefficients: Coefficients, frequency: number, rate: number): number {
  const omega = 2 * Math.PI * frequency / rate;
  const [b0, b1, b2, a0, a1, a2] = coefficients;
  const numerator = (b0 + b1 * Math.cos(omega) + b2 * Math.cos(2 * omega)) ** 2 + (b1 * Math.sin(omega) + b2 * Math.sin(2 * omega)) ** 2;
  const denominator = (a0 + a1 * Math.cos(omega) + a2 * Math.cos(2 * omega)) ** 2 + (a1 * Math.sin(omega) + a2 * Math.sin(2 * omega)) ** 2;
  return 10 * Math.log10(Math.max(Number.MIN_VALUE, numerator / denominator));
}

export function eqResponse(parameters: Record<string, number>, rate: number, frequency: number): number {
  return (['low', 'mid', 'high'] as const).reduce((sum, band) => sum + magnitudeDb(eqCoefficients(band, parameters[`${band}_cutoff_freq`], parameters[`${band}_q_factor`], parameters[`${band}_gain_db`], rate), frequency, rate), 0);
}
