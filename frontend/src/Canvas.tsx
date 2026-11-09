import { useEffect, useRef } from 'react';
import type { Clip, Track } from './protocol';
import { timelineLabel, timelineTicks, type TimelineView } from './timeline';

export function Waveform({ track, clips, selected = false, selectedClips, previewClipId, clearClip, ruler = false, view: { start, span }, position, duration, seek, theme, clipDown, clipMove, clipUp, rulerDown, rulerMove, rulerUp }: {
  track?: Track; clips?: Clip[]; selected?: boolean; selectedClips?: { trackId: string; id: string }[]; previewClipId?: string; clearClip?: () => void; ruler?: boolean; view: TimelineView; position: number; progress?: number; duration: number; seek?: (ms: number) => void; theme: boolean;
  clipDown?: (event: React.PointerEvent<HTMLCanvasElement>, clip: Clip, time: number) => void;
  clipMove?: (event: React.PointerEvent<HTMLCanvasElement>) => void; clipUp?: (event: React.PointerEvent<HTMLCanvasElement>, cancelled: boolean) => void;
  rulerDown?: (event: React.PointerEvent<HTMLCanvasElement>, time: number) => void;
  rulerMove?: (event: React.PointerEvent<HTMLCanvasElement>) => void; rulerUp?: (event: React.PointerEvent<HTMLCanvasElement>, cancelled: boolean) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const background = useRef<{ canvas: HTMLCanvasElement; track: Track | undefined; clips: Clip[] | undefined; selected: boolean; selectedClips: { trackId: string; id: string }[] | undefined; previewClipId: string | undefined; ruler: boolean; start: number; span: number; width: number; height: number; ratio: number; theme: boolean } | null>(null);
  useEffect(() => () => {
    if (background.current) { background.current.canvas.width = 0; background.current.canvas.height = 0; background.current = null; }
  }, []);
  useEffect(() => {
    const canvas = ref.current!;
    const draw = () => {
      if (document.hidden || !document.hasFocus()) return;
      const { width, height } = canvas.getBoundingClientRect();
      if (!width || !height || canvas.getBoundingClientRect().bottom < 0 || canvas.getBoundingClientRect().top > window.innerHeight) return;
      const deviceRatio = window.devicePixelRatio || 1;
      const ratio = Math.min(deviceRatio, Math.sqrt(2_000_000 / Math.max(1, width * height)));
      const pixelWidth = Math.max(1, Math.round(width * ratio)), pixelHeight = Math.max(1, Math.round(height * ratio));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
      const ctx = canvas.getContext('2d')!; ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const tokens = getComputedStyle(canvas);
      const token = (name: string) => tokens.getPropertyValue(`--color-${name}`).trim();
      ctx.clearRect(0, 0, width, height);
      const toX = (ms: number) => (ms - start) / span * width;
      const cached = background.current;
      const reusable = cached && cached.track === track && cached.clips === clips && cached.selected === selected && cached.selectedClips === selectedClips && cached.previewClipId === previewClipId && cached.ruler === ruler && cached.start === start && cached.span === span && cached.width === width && cached.height === height && cached.ratio === ratio && cached.theme === theme;
      if (reusable) ctx.drawImage(cached.canvas, 0, 0, width, height);
      else {
      for (const clip of clips ?? track?.clips ?? []) {
        const clipStart = clip.start, clipEnd = clip.start + clip.duration;
        if (clipEnd <= start || clipStart >= start + span || width <= 0) continue;
        const left = Math.max(0, toX(clipStart));
        const right = Math.min(width, toX(clipEnd));
        const clipSelected = clip.id === previewClipId || !!selectedClips?.some(item => item.trackId === track?.id && item.id === clip.id);
        ctx.fillStyle = token(clipSelected ? 'track-clip-focus' : selected ? 'track-clip-selected' : 'track-clip');
        ctx.fillRect(left, 0, right - left, height);
        ctx.fillStyle = token('track-clip-edge');
        ctx.fillRect(left, 0, right - left, 2);
        if (left > 0) ctx.fillRect(left, 0, 1, height);
        if (right < width) ctx.fillRect(right - 1, 0, 1, height);
        const peaks = clip.waveform.peaks;
        ctx.save(); ctx.beginPath(); ctx.rect(left, 0, right - left, height); ctx.clip();
        if (peaks.length) {
          const interval = clip.duration / peaks.length;
          const first = Math.max(0, Math.floor((start - clipStart) / interval - .5));
          const last = Math.min(peaks.length - 1, Math.ceil((start + span - clipStart) / interval - .5));
          const peakTime = (index: number) => clipStart + (index + .5) * interval;
          const titleHeight = Math.min(18, height * .3);
          const waveHeight = height - titleHeight;
          const toY = (amplitude: number) => titleHeight + waveHeight * (0.5 - amplitude * .42);
          ctx.beginPath();
          ctx.moveTo(toX(first === 0 ? clipStart : peakTime(first)), toY(peaks[first][1]));
          for (let i = first; i <= last; i++) ctx.lineTo(toX(peakTime(i)), toY(peaks[i][1]));
          if (last === peaks.length - 1) { ctx.lineTo(toX(clipEnd), toY(peaks[last][1])); ctx.lineTo(toX(clipEnd), toY(peaks[last][0])); }
          for (let i = last; i >= first; i--) ctx.lineTo(toX(peakTime(i)), toY(peaks[i][0]));
          if (first === 0) ctx.lineTo(toX(clipStart), toY(peaks[first][0]));
          ctx.closePath(); ctx.fillStyle = token('track-waveform'); ctx.fill(); ctx.strokeStyle = ctx.fillStyle; ctx.stroke();
        }
        const titleHeight = Math.min(18, height * .3);
        ctx.fillStyle = token(clipSelected ? 'track-clip-title-focus' : 'track-clip-title');
        ctx.fillRect(left, 0, right - left, titleHeight);
        if (right - left > 20) {
          ctx.font = '11px Microsoft YaHei UI, Inter, system-ui, sans-serif'; ctx.fillStyle = token('text-primary');
          ctx.textBaseline = 'middle';
          ctx.fillText(clip.name ?? clip.source.split(/[\\/]/).pop() ?? '', left + 8, titleHeight / 2, Math.max(0, right - left - 16));
          ctx.textBaseline = 'alphabetic';
        }
        ctx.restore();
      }
      ctx.font = '11px Microsoft YaHei UI, Inter, system-ui, sans-serif';
      const labelWidth = ctx.measureText(timelineLabel(start + span)).width;
      const { minor } = timelineTicks(span, width, Math.max(60, labelWidth + 12));
      ctx.fillStyle = token('text-secondary');
      ctx.strokeStyle = token('text-primary');
      for (let tick = Math.max(0, Math.ceil(start / minor)); tick * minor <= start + span; tick++) {
        const x = Math.floor(toX(tick * minor)) + .5;
        const major = tick % 5 === 0;
        ctx.globalAlpha = ruler ? (major ? .48 : .28) : (major ? .19 : .10);
        ctx.beginPath();
        ctx.moveTo(x, ruler ? height - (major ? 12 : 7) : Math.min(18, height * .3));
        ctx.lineTo(x, height);
        ctx.stroke();
        ctx.globalAlpha = 1;
        if (ruler && major && x + 5 + labelWidth <= width) ctx.fillText(timelineLabel(tick * minor), x + 5, 12);
      }
      const cachedCanvas = cached?.canvas ?? document.createElement('canvas');
      if (cachedCanvas.width !== canvas.width || cachedCanvas.height !== canvas.height) { cachedCanvas.width = canvas.width; cachedCanvas.height = canvas.height; }
      const cacheContext = cachedCanvas.getContext('2d')!;
      cacheContext.clearRect(0, 0, cachedCanvas.width, cachedCanvas.height);
      cacheContext.drawImage(canvas, 0, 0);
      background.current = { canvas: cachedCanvas, track, clips, selected, selectedClips, previewClipId, ruler, start, span, width, height, ratio, theme };
      }

    };
    const observer = new ResizeObserver(draw); observer.observe(canvas);
    const visible = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) draw(); }); visible.observe(canvas);
    window.addEventListener('focus', draw); document.addEventListener('visibilitychange', draw); draw();
    return () => { observer.disconnect(); visible.disconnect(); window.removeEventListener('focus', draw); document.removeEventListener('visibilitychange', draw); };
  }, [track, clips, selected, selectedClips, previewClipId, ruler, start, span, theme]);
  const className = ruler ? 'ruler' : 'waveform';
  if (!seek) return <canvas ref={ref} className={className} aria-hidden="true" />;
  return <canvas ref={ref} className={className} data-seekable aria-label={track ? `${track.label} 波形，点击定位` : '时间标尺，点击定位'} role="slider" tabIndex={0}
    aria-valuemin={0} aria-valuemax={duration} aria-valuenow={Math.round(position)}
    onPointerDown={event => {
      if (event.button !== 0) return;
      const box = event.currentTarget.getBoundingClientRect(); if (box.width <= 0) return;
      const time = start + Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * span;
      if (ruler && rulerDown) { event.currentTarget.setPointerCapture(event.pointerId); rulerDown(event, time); return; }
      const clip = (clips ?? track?.clips ?? []).find(item => time >= item.start && time < item.start + item.duration);
      if (clip && clipDown) { event.currentTarget.setPointerCapture(event.pointerId); clipDown(event, clip, time); }
      else { clearClip?.(); seek(time); }
    }}
    onPointerMove={ruler ? rulerMove : clipMove} onPointerUp={event => ruler ? rulerUp?.(event, false) : clipUp?.(event, false)} onPointerCancel={event => ruler ? rulerUp?.(event, true) : clipUp?.(event, true)}
    onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const step = Math.min(1000, span / 20); seek(Math.max(0, Math.min(duration, position + (event.key === 'ArrowRight' ? step : -step)))); } }} />;
}
