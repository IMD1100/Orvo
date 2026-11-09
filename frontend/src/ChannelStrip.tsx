import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import { InputBase } from '@/components/base/input/input';
import { Slider } from '@/components/base/slider/slider';
import type { Channel, Track } from './protocol';
import './styles/mixer.css';

type Patch = (patch: Partial<Track>) => void | Promise<unknown>;
type Toggle = 'solo' | 'muted' | 'fxEnabled';
const METER_FLOOR = -48;
const meterLevel = (db: number) => Math.max(0, Math.min(1, db <= -18 ? (db - METER_FLOOR) / 30 * .5 : .5 + (db + 18) / 18 * .5));

function MeterLane({ db, clipHeld }: { db: number; clipHeld: boolean }) {
  const [heldPeak, setHeldPeak] = useState(db);
  const peak = useRef(db);
  const latest = useRef(db);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    latest.current = db;
    if (db >= peak.current) {
      peak.current = db;
      setHeldPeak(db);
      if (holdTimer.current) clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (peak.current > METER_FLOOR && !holdTimer.current) {
      holdTimer.current = setTimeout(() => {
        peak.current = latest.current;
        setHeldPeak(latest.current);
        holdTimer.current = null;
      }, 1200);
    }
  }, [db]);
  useEffect(() => () => { if (holdTimer.current) clearTimeout(holdTimer.current); }, []);


  const level = meterLevel(db);
  return <span className="mixer-meter" data-clip-held={clipHeld || db >= 0}>
    <i data-silent={level === 0} style={{ clipPath: `inset(${(1 - level) * 100}% 0 0)` }} />
    {heldPeak > METER_FLOOR && <span className="mixer-peak-hold" style={{ bottom: `calc(${meterLevel(heldPeak) * 100}% - 1px)` }} />}
  </span>;
}

function Meter({ levels = [-100, -100] }: { levels?: [number, number] }) {
  const peak = Math.max(...levels);
  const [held, setHeld] = useState<[boolean, boolean]>([false, false]);
  const leftClipped = levels[0] >= 0, rightClipped = levels[1] >= 0;
  useEffect(() => {
    if (leftClipped || rightClipped) {
      setHeld(previous => [previous[0] || leftClipped, previous[1] || rightClipped]);
      return;
    }
    const timer = setTimeout(() => setHeld([false, false]), 1200);
    return () => clearTimeout(timer);
  }, [leftClipped, rightClipped]);
  return <div className="mixer-meters" role="meter" aria-label="立体声电平" aria-valuemin={METER_FLOOR} aria-valuemax={0}
    aria-valuenow={Math.max(METER_FLOOR, Math.min(0, peak))} aria-valuetext={peak <= -100 ? '静音' : `${peak.toFixed(1)} dBFS`}>
    {levels.map((db, i) => <MeterLane key={i} db={db} clipHeld={held[i]} />)}
  </div>;
}

function Fader({ value, kind, disabled, vertical, levels, change }: {
  value: number; kind: 'gain' | 'pan'; disabled: boolean; vertical?: boolean;
  levels?: [number, number]; change: (value: number) => ReturnType<Patch>;
}) {
  const gain = kind === 'gain';
  const min = gain ? -60 : -100;
  const max = gain ? 12 : 100;
  const unit = gain ? 'dB' : '%';
  const label = gain ? '音量增益' : '声像 L/R';
  const [local, setLocal] = useState<{ value: number }>();
  const [typed, setTyped] = useState<string>();
  const [invalid, setInvalid] = useState(false);
  const [flash, setFlash] = useState(0);
  const pointer = useRef(false);
  const changed = useRef(false);
  const shown = local?.value ?? value;
  const round = (next: number) => Number(next.toFixed(gain ? 1 : 0));
  const snap = (next: number) => pointer.current && Math.abs(next) <= (gain ? 1 : 4) ? 0 : next;
  const sliderValue = gain ? (shown <= 0 ? (shown + 60) / 60 * 504 : 504 + shown / 12 * 216) : shown;
  const fromSlider = (next: number) => gain ? round(next <= 504 ? next / 504 * 60 - 60 : (next - 504) / 216 * 12) : next;

  const commit = (value: number) => {
    const pending = { value: round(value) };
    setLocal(pending);
    // Later gestures own the preview even if an earlier command is still queued.
    const settle = () => setLocal(current => current === pending ? undefined : current);
    void Promise.resolve(change(pending.value)).then(settle, settle);
  };

  const numeric = <div className="mixer-readout" data-invalid={invalid || undefined}>
    <InputBase size="small" type="text" inputMode="decimal" aria-label={`${label}，${unit}`} aria-invalid={invalid || undefined}
      className="mixer-number text-caption-1-semibold" fieldClassName="mixer-number-field" disabled={disabled}
      title={invalid ? `请输入 ${min} 到 ${max} 之间的数值` : `${label}（${unit}）`}
      value={typed ?? shown.toFixed(gain ? 1 : 0)}
      onFocus={event => event.currentTarget.select()}
      onChange={event => { setInvalid(false); setTyped(event.currentTarget.value); }}
      onBlur={event => {
        if (typed === undefined) return;
        const next = Number(event.currentTarget.value);
        const valid = typed.trim() !== '' && Number.isFinite(next) && next >= min && next <= max;
        setInvalid(!valid);
        setTyped(undefined);
        if (valid && round(next) !== shown) commit(next);
      }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === 'Escape') { setTyped(undefined); setInvalid(false); }
      }} />
    <span className="text-caption-1-regular" aria-hidden="true">{unit}</span>
  </div>;

  return <div className="mixer-fader" data-vertical={vertical || undefined}>
    <div className="mixer-rail" data-gain={gain || undefined}
      onPointerDownCapture={() => { pointer.current = true; }} onKeyDownCapture={() => { pointer.current = false; }}>
      <Slider aria-label={label} thumbLabel={`${label}，${shown.toFixed(gain ? 1 : 0)} ${unit}`} orientation={vertical ? 'vertical' : 'horizontal'}
        minValue={gain ? 0 : min} maxValue={gain ? 720 : max} step={1} value={sliderValue} isDisabled={disabled} showTooltip={false}
        onChange={next => {
          const preview = snap(fromSlider(next));
          if (gain && preview === max && shown !== max) setFlash(count => count + 1);
          changed.current = true;
          setInvalid(false);
          setLocal({ value: preview });
        }}
        onChangeEnd={next => {
          const finalValue = snap(fromSlider(next));
          pointer.current = false;
          if (!changed.current) return;
          changed.current = false;
          commit(finalValue);
        }} />
      <i className="mixer-zero" aria-hidden="true" />
      {flash > 0 && <i className="mixer-limit" key={flash} aria-hidden="true" />}
    </div>
    {vertical && <>
      <span className="mixer-scale text-caption-2-regular" aria-hidden="true"><span>+12</span><span>0</span><span>−60</span></span>
      <Meter levels={levels} />
    </>}
    {numeric}
  </div>;
}

export function ChannelStrip({ channel, track, levels, disabled, dirty, patch }: {
  channel: Channel; track?: Track; levels?: [number, number]; disabled: boolean; dirty?: boolean; patch: Patch;
}) {
  const [pending, setPending] = useState<Partial<Record<Toggle, { value: boolean }>>>({});
  const enabled = (key: Toggle) => pending[key]?.value ?? channel[key];
  const toggle = (key: Toggle) => {
    const next = { value: !enabled(key) };
    setPending(current => ({ ...current, [key]: next }));
    const settle = () => setPending(current => current[key] === next ? { ...current, [key]: undefined } : current);
    void Promise.resolve(patch({ [key]: next.value })).then(settle, settle);
  };
  const solo = enabled('solo');
  const muted = enabled('muted');
  const fxEnabled = enabled('fxEnabled');
  const fx = fxEnabled ? (channel.graph.chain.length ? 'on' : 'empty') : 'bypass';
  const fxLabel = { on: 'FX 已启用', empty: 'FX 无效果器', bypass: 'FX 已旁路' }[fx];
  const fxTitle = dirty ? `${fxLabel} · 有待应用修改` : fxLabel;
  return <div className="mixer-channel" data-master={!track || undefined}>
    <div className="mixer-buttons">
      <Button size="xs" variant={solo ? 'danger' : 'secondary'} disabled={disabled} data-state={solo ? 'solo' : undefined}
        aria-pressed={solo} aria-label={`${track?.label ?? 'Master'} 独听`} title="独听" onClick={() => toggle('solo')}>S</Button>
      <Button size="xs" variant={muted ? 'danger' : 'secondary'} disabled={disabled} data-state={muted ? 'muted' : undefined}
        aria-pressed={muted} aria-label="静音" title="静音" onClick={() => toggle('muted')}>M</Button>
      <Button size="xs" variant={fx === 'empty' ? 'secondary' : 'danger'} disabled={disabled} data-state={fx} data-dirty={dirty || undefined}
        aria-pressed={fxEnabled} aria-label={fxTitle} title={fxTitle} onClick={() => toggle('fxEnabled')}>FX</Button>
    </div>
    <Fader kind="gain" value={channel.gainDb} disabled={disabled} change={gainDb => patch({ gainDb })} />
    <Fader kind="pan" value={channel.pan * 100} disabled={disabled} change={percent => patch({ pan: percent / 100 })} />
    <Meter levels={levels} />
  </div>;
}
