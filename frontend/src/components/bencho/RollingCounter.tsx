import { useRef } from 'react';
import { RiAddLine, RiSubtractLine } from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';

// Adapted from Bencho Rolling Counter, MIT, Lorenzo Cabra.
export function RollingCounter({ value, onChange, disabled }: { value: number; onChange: (value: number) => void; disabled: boolean }) {
  const drag = useRef<{ y: number; value: number } | null>(null);
  const set = (next: number) => onChange(Math.max(0, Math.min(3, next)));
  return <div className="ai-counter">
    <Button size="small" variant="secondary" iconOnly leadingIcon={RiSubtractLine} aria-label="减少反馈轮数" disabled={disabled || value === 0} onClick={() => set(value - 1)} />
    <div className="ai-counter-number" role="spinbutton" aria-label="反馈轮数" aria-valuenow={value} aria-valuemin={0} aria-valuemax={3} aria-disabled={disabled} tabIndex={disabled ? -1 : 0}
      onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); set(value + (event.key === 'ArrowUp' ? 1 : -1)); } }}
      onPointerDown={event => { if (disabled || event.button !== 0) return; drag.current = { y: event.clientY, value }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (drag.current && event.currentTarget.hasPointerCapture(event.pointerId)) set(drag.current.value + Math.round((drag.current.y - event.clientY) / 16)); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <span className="ai-counter-digits" style={{ transform: `translateY(-${value * 25}%)` }} aria-hidden="true">{[0,1,2,3].map(n => <span key={n}>{n}</span>)}</span>
    </div>
    <Button size="small" variant="secondary" iconOnly leadingIcon={RiAddLine} aria-label="增加反馈轮数" disabled={disabled || value === 3} onClick={() => set(value + 1)} />
  </div>;
}
