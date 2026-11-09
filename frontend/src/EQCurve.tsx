import { createContext, useContext, useMemo } from 'react';
import { eqResponse } from './equalizer';

export type Spectrum = { frequencies: number[]; db: number[] };
export const SpectrumContext = createContext<Spectrum | undefined>(undefined);

const left = 34, right = 332, top = 22, bottom = 146;
const x = (hz: number, end: number) => left + Math.log(hz / 20) / Math.log(end / 20) * (right - left);
const spectrumY = (db: number) => top + Math.min(100, Math.max(0, -db)) / 100 * (bottom - top);

function SpectrumTrace({ end }: { end: number }) {
  const spectrum = useContext(SpectrumContext);
  if (!spectrum) return null;
  const points = new Map<number, number>();
  for (let i = 0; i < spectrum.frequencies.length; i++) {
    const hz = spectrum.frequencies[i], db = spectrum.db[i];
    if (hz < 20 || hz > end || !Number.isFinite(hz) || !Number.isFinite(db)) continue;
    const pixel = Math.round(x(hz, end));
    points.set(pixel, Math.max(db, points.get(pixel) ?? -100));
  }
  if (!points.size) return null;
  const samples = [...points].sort(([a], [b]) => a - b);
  if (samples[0][0] > left) samples.unshift([left, samples[0][1]]);
  const smooth = samples.map(([pixel, db], i) => {
    const previous = samples[Math.max(0, i - 1)][1], next = samples[Math.min(samples.length - 1, i + 1)][1];
    return [pixel, spectrumY((previous + 2 * db + next) / 4)] as const;
  });
  let line = `M${smooth[0][0]},${smooth[0][1].toFixed(1)}`;
  for (let i = 1; i < smooth.length; i++) {
    const [x0, y0] = smooth[i - 1], [x1, y1] = smooth[i];
    line += ` Q${x0},${y0.toFixed(1)} ${(x0 + x1) / 2},${((y0 + y1) / 2).toFixed(1)}`;
  }
  const last = smooth[smooth.length - 1]; line += ` L${last[0]},${last[1].toFixed(1)}`;
  return <path className="eq-spectrum" d={line} />;
}

export function EQCurve({ parameters, sampleRate, enabled }: { parameters: Record<string, number>; sampleRate: number; enabled: boolean }) {
  const rate = sampleRate || 44100;
  const end = Math.min(20000, rate * .49);
  const { range, curve } = useMemo(() => {
    const response = Array.from({ length: 220 }, (_, i) => {
      const hz = 20 * (end / 20) ** (i / 219);
      return enabled ? eqResponse(parameters, rate, hz) : 0;
    });
    const range = Math.max(12, Math.ceil(Math.max(...response.map(Math.abs)) / 6) * 6);
    const curve = response.map((db, i) => `${i ? 'L' : 'M'}${(left + i / 219 * (right - left)).toFixed(2)},${(top + (range - db) / (2 * range) * (bottom - top)).toFixed(2)}`).join(' ');
    return { range, curve };
  }, [enabled, end, parameters, rate]);
  return <figure className="eq-response">
    <svg viewBox="0 0 370 182" role="img" aria-label={`均衡器响应和实时音轨频谱，${enabled ? '三段串联' : '已旁路'}，左轴为响应增益，右轴为频谱电平`}>
      <text x="4" y="11">增益 (dB)</text><text x="366" y="11" textAnchor="end">频谱 (dB)</text>
      {[range, 0, -range].map((db, i) => {
        const y = top + i * (bottom - top) / 2;
        return <g key={db}>
          <line x1={left} x2={right} y1={y} y2={y} className="eq-grid" />
          <text x={left - 6} y={y + 3} textAnchor="end">{db > 0 ? '+' : ''}{db}</text>
          <text x={right + 6} y={y + 3}>{i * -50}</text>
        </g>;
      })}
      {[20, 100, 1000, 10000, 20000].filter(hz => hz <= end).map(hz => <g key={hz}>
        <line x1={x(hz, end)} x2={x(hz, end)} y1={top} y2={bottom} className="eq-grid" />
        <text x={x(hz, end)} y={bottom + 14} textAnchor="middle">{hz >= 1000 ? `${hz / 1000}k` : hz}</text>
      </g>)}
      <text x={(left + right) / 2} y="177" textAnchor="middle">频率 (Hz)</text>
      <SpectrumTrace end={end} />
      <path d={curve} className="eq-curve" />
    </svg>
  </figure>;
}
