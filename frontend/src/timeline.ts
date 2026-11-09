export type TimelineView = { start: number; span: number };

export const INITIAL_TIMELINE: TimelineView = { start: 0, span: 20_000 };

export const timelineScrollLimit = (span: number, duration: number) => Math.max(0, duration - span * .9);

export function panTimeline(view: TimelineView, offset: number, duration: number): TimelineView {
  const lastStart = timelineScrollLimit(view.span, duration);
  const start = Math.max(0, Math.min(lastStart, view.start + offset));
  return start === view.start ? view : { ...view, start };
}

export function zoomTimeline(view: TimelineView, playhead: number, delta: number, duration: number): TimelineView {
  const factor = Math.exp(Math.max(-32, Math.min(32, delta * .0018)));
  const span = Math.max(50, Math.min(Math.max(3_600_000, duration), view.span * factor));
  if (span === view.span) return view;
  const position = (playhead - view.start) / view.span;
  const anchor = span > view.span && position >= 0 && position <= 1 ? position : .5;
  return panTimeline({ start: playhead - anchor * span, span }, 0, duration);
}

export function timelineTicks(span: number, width: number, labelSpacing: number) {
  const minimum = Math.max(10, labelSpacing * span / Math.max(1, width));
  const decade = 10 ** Math.floor(Math.log10(minimum));
  const major = [1, 2, 5, 10].map(step => step * decade).find(step => step >= minimum)!;
  return { major, minor: major / 5 };
}

export const timelineLabel = (milliseconds: number) => (milliseconds / 1000).toFixed(2);
