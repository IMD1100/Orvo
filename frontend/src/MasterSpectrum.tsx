import type { SpectrumData } from './protocol';
import './styles/mixer.css';

const frequencies = [20, 200, 2000, 20000];
const decibels = [0, -50, -100];
const x = (hz: number) => 25 + Math.log10(hz / 20) * 30;
const y = (db: number) => 18 - Math.max(-100, Math.min(0, db)) * .46;

export function MasterSpectrum({ spectrum }: { spectrum?: SpectrumData; theme: boolean }) {
  const points = spectrum?.frequencies.flatMap((hz, index) => {
    const db = spectrum.db[index];
    return hz >= 20 && hz <= 20000 && Number.isFinite(db) ? [`${x(hz).toFixed(1)},${y(db).toFixed(1)}`] : [];
  }).join(' ');

  return <svg className="master-spectrum" viewBox="0 0 120 92" role="img" aria-label="Master 实时频谱，横轴 Hz，纵轴 dBFS">
    <text x="2" y="10">dBFS</text>
    {decibels.map(db => <g key={db}>
      <line x1={25} x2={115} y1={y(db)} y2={y(db)} />
      <text x={21} y={y(db)} dy=".32em" textAnchor="end">{db}</text>
    </g>)}
    {frequencies.map((hz, index) => <g key={hz}>
      <line x1={x(hz)} x2={x(hz)} y1={18} y2={68} />
      <text x={x(hz)} y={78} textAnchor={index === frequencies.length - 1 ? 'end' : 'middle'}>{hz >= 1000 ? `${hz / 1000}k` : hz}</text>
    </g>)}
    <text x={115} y={89} textAnchor="end">Hz</text>
    <polyline points={points} />
  </svg>;
}
