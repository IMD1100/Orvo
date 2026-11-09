import { useState } from "react";
import { Slider } from "@/components/base/slider/slider";

export type Bounds = { min: number; max: number; unit: string };
const labels: Record<string, string> = {
  gain_db: '增益', pan: '声像', width: '立体声宽度', drive_db: '驱动增益',
  delay_seconds: '延迟时间', feedback: '反馈', mix_ratio: '混合比例', mix: '混合比例',
  room_size: '空间大小', damping: '阻尼', threshold_db: '阈值', ratio: '比率',
  attack_ms: '起音时间', release_ms: '释放时间', cutoff_frequency_hz: '截止频率',
  rate_hz: '速率', depth: '深度', centre_delay_ms: '中心延迟', centre_frequency_hz: '中心频率', semitones: '移调',
  low_gain_db: '低频增益', low_cutoff_freq: '低频截止', low_q_factor: '低频 Q 值',
  mid_gain_db: '中频增益', mid_cutoff_freq: '中频中心', mid_q_factor: '中频 Q 值',
  high_gain_db: '高频增益', high_cutoff_freq: '高频截止', high_q_factor: '高频 Q 值',
};

export const parameterLabel = (name: string, index: number) => labels[name] ?? `参数 ${index + 1}`;

export function Parameter({ name, label, bounds, value, disabled, change, onSlideEnd }: {
  name: string; label: string; bounds?: Bounds; value: number; disabled: boolean;
  change: (value: number, fromSlider?: boolean) => void; onSlideEnd: () => void;
}) {
  const [typed, setTyped] = useState<string>();
  const [invalid, setInvalid] = useState(false);
  const { min, max, unit } = bounds ?? { min: -Infinity, max: Infinity, unit: '' };
  const logarithmic = unit === "Hz" && min > 0 && max / min >= 10;
  const fraction = logarithmic ? Math.log(value / min) / Math.log(max / min) : (value - min) / (max - min);
  const fromSlider = (position: number) => {
    if (position === 0) return min;
    if (position === 1000) return max;
    const raw = logarithmic ? min * (max / min) ** (position / 1000) : min + (max - min) * position / 1000;
    return Number(raw.toPrecision(12));
  };
  const commit = () => {
    if (typed === undefined) return;
    const next = Number(typed);
    const valid = typed.trim() !== "" && Number.isFinite(next) && next >= min && next <= max;
    setInvalid(!valid);
    if (valid && next !== value) change(next);
    setTyped(undefined);
  };
  const suffix = unit === 'semitones' ? '半音' : ['ratio', 'linear', 'normalized'].includes(unit) ? '' : unit;
  return <div className="parameter" onKeyUp={onSlideEnd} onPointerCancel={onSlideEnd}>
    <div className="parameter-line">
      <label className="text-body-medium" htmlFor={"param-" + name} title={label}>{label}</label>
      <div className="numeric">
        <input className="text-body-medium" id={"param-" + name} aria-invalid={invalid || undefined} disabled={disabled}
          inputMode="decimal" value={typed ?? String(Number(value.toPrecision(5)))}
          onFocus={() => setTyped(String(value))}
          onChange={event => { setInvalid(false); setTyped(event.currentTarget.value); }}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
        <span className="parameter-unit">{suffix}</span>
      </div>
    </div>
    {bounds && <div className="parameter-rail">
      <Slider className="slim-slider" aria-label={label} thumbLabel={label} minValue={0} maxValue={1000}
        showTooltip={false} isDisabled={disabled} value={Math.min(1000, Math.max(0, Math.round(fraction * 1000)))}
        onChange={position => { setInvalid(false); change(fromSlider(position), true); }} onChangeEnd={onSlideEnd} />
      {min < 0 && max > 0 && <i className="mixer-zero" aria-hidden="true" style={{ left: `${-min / (max - min) * 100}%` }} />}
    </div>}
    {invalid && <small className="param-error" role="alert">{bounds ? `请输入 ${min} 到 ${max} 之间的数值` : '请输入有效数值'}</small>}
  </div>;
}

