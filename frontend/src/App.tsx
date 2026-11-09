import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow, type DragDropEvent } from '@tauri-apps/api/window';
import { RiAddLine, RiSubtractLine, RiSquareLine, RiCheckboxMultipleBlankLine, RiFolderOpenLine, RiPauseFill, RiPlayFill, RiStopFill, RiLoopRightLine, RiArrowUpLine, RiSparklingLine, RiCloseLine, RiRefreshLine, RiLoader4Line, RiInformationLine, RiErrorWarningLine } from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';
import { Input } from '@/components/base/input/input';
import { Textarea } from '@/components/base/textarea/textarea';
import { LiquidToggle } from '@/components/bencho/LiquidToggle';
import '@/components/bencho/LiquidToggle.css';
import { Select, SelectItem } from '@/components/base/select/select';
import { Dropdown, DropdownTrigger, DropdownPopover, DropdownItem, DropdownDivider } from '@/components/base/dropdown/dropdown';
import { ContextMenu, ContextMenuItem, ContextMenuTrigger } from '@/components/base/context-menu/context-menu';
import { Watcher } from '@/components/bencho/Watcher';
import { RollingCounter } from '@/components/bencho/RollingCounter';
import '@/components/bencho/Watcher.css';
import '@/components/bencho/ToastStack.css';
import { ComposerLoader } from '@/components/application/composer-loader/composer-loader';
import { GraphEditor, arrangeGeneratedGraph, type GraphHistory, type NodeClipboard } from './GraphEditor';
import { ChannelStrip } from './ChannelStrip';
import { Waveform } from './Canvas';
import { INITIAL_TIMELINE, panTimeline, timelineScrollLimit, zoomTimeline } from './timeline';
import { Dialog, Modal, ModalOverlay } from 'react-aria-components';
import { ai, engine, native, clock, audioGraphKey, type AIRunResult, type Catalog, type Clip, type Device, type EngineState, type Graph, type LoopSelection, type Processing, type Project, type Settings, type Track } from './protocol';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const phases: Record<Processing['phase'], string> = { planning: '生成方案', rendering: '渲染', measuring: '测量', reviewing: '反馈修订', comparing: '比较', applying: '应用', complete: '完成', failed: '失败', cancelled: '已取消' };
const stopReasons: Record<string, string> = { disabled: '未启用修订', round_limit: '达到修订轮数', no_change: '无需继续修订', unchanged_parameters: '参数未变化', requires_replan: '需要更改效果器，已保留现有方案', technical_regression: '修订未通过技术检查，已保留上一结果', feedback_error: '修订未完成，已保留上一个可用结果', failed: '保留原 FX 图' };
type Notification = { id: number; text: string; error: boolean; time: string };

type GraphDraft = { graph: Graph; preview: boolean };
type TrackSnapshot = { kind: 'tracks'; tracks: Track[]; drafts: Record<string, GraphDraft>; selected: string };
type LayoutSnapshot = { kind: 'layout'; width: number; heights: Record<string, number> };
type TrackHistoryEntry = TrackSnapshot | LayoutSnapshot;
type ClipDrag = { from: string; clip: Clip; pointerX: number; pointerY: number; anchor: number; active: boolean; target?: string; start: number };
const NEW_TRACK = '@new-track';
function nearestClipStart(clips: Clip[], wanted: number, length: number): number {
  const ordered = [...clips].sort((a, b) => a.start - b.start);
  let lower = 0, best = 0, distance = Infinity;
  for (const clip of ordered) {
    const upper = clip.start - length;
    if (upper >= lower - .0001) {
      const candidate = Math.max(lower, Math.min(Math.max(lower, upper), wanted));
      if (Math.abs(candidate - wanted) < distance) { best = candidate; distance = Math.abs(candidate - wanted); }
    }
    lower = Math.max(lower, clip.start + clip.duration);
  }
  const candidate = Math.max(wanted, lower);
  return Math.min(86400000, Math.abs(candidate - wanted) < distance ? candidate : best);
}


function committedPositions(committed: Graph, draft: Graph): Graph['routing']['positions'] {
  const committedIds = new Set(['@input', '@output', ...committed.chain.map(node => node.id), ...committed.routing.mixers]);
  const draftIds = new Set(['@input', '@output', ...draft.chain.map(node => node.id), ...draft.routing.mixers]);
  const positions = { ...committed.routing.positions };
  for (const id of committedIds) {
    if (!draftIds.has(id)) continue;
    if (draft.routing.positions[id]) positions[id] = draft.routing.positions[id];
    else delete positions[id];
  }
  return positions;
}

function TransportTime({ state, showProgress, startPosition, active }: { state: EngineState | null; showProgress: boolean; startPosition: number; active: boolean }) {
  const display = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!state?.playing || !showProgress || !active) {
      if (display.current) display.current.textContent = clock(showProgress ? state?.position ?? 0 : startPosition);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const update = (now: number) => {
      if (display.current) display.current.textContent = clock(Math.min(state.duration, state.position + now - start));
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [state?.playing, state?.position, state?.duration, showProgress, startPosition, active]);
  return <time className="time-display text-headline-medium"><span ref={display}>{clock(showProgress ? state?.position ?? 0 : startPosition)}</span><span className="text-caption-1-regular"> / {clock(state?.duration ?? 0)}</span></time>;
}

export function App() {
  const [uiActive, setUiActive] = useState(() => !document.hidden && document.hasFocus());
  useEffect(() => {
    const update = () => setUiActive(!document.hidden && document.hasFocus());
    const blur = () => setUiActive(false);
    window.addEventListener('focus', update);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', update);
    return () => { window.removeEventListener('focus', update); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', update); };
  }, []);
  const [project, setProject] = useState<Project | null>(null);
  const [projectName, setProjectName] = useState('未命名');
  const current = useRef<Project | null>(null);
  const [state, setState] = useState<EngineState | null>(null);
  const playingNow = useRef(false);
  const playbackSource = useRef('master');
  const [startPosition, setStartPosition] = useState(0);
  const startAt = useRef(0);
  const acceptState = useCallback((value: EngineState) => {
    playingNow.current = value.playing;
    playbackSource.current = value.playbackSource ?? 'master';
    if (startAt.current > value.duration) {
      startAt.current = value.duration;
      setStartPosition(value.duration);
    }
    setState(value);
  }, []);
  const [showProgress, setShowProgress] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selected, setSelected] = useState('master');
  const [renamingTrack, setRenamingTrack] = useState<string | null>(null);
  const selectedId = useRef('master');
  const selectChannel = (id: string) => { selectedId.current = id; setSelected(id); };
  const [settings, setSettings] = useState<Settings | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [refreshingDevices, setRefreshingDevices] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('orvo-theme') !== 'light');
  const [maximized, setMaximized] = useState(false);
  const [panel, setPanel] = useState<'api-settings' | 'audio-settings' | 'effects' | 'analysis' | 'logs' | null>(null);
  const [panelOffset, setPanelOffset] = useState({ x: 0, y: 0 });
  const panelDrag = useRef<{ x: number; y: number; offsetX: number; offsetY: number; left: number; top: number; width: number; height: number } | null>(null);
  const [menu, setMenu] = useState<'file' | 'track' | 'view' | 'ai-tools' | 'settings' | 'notifications' | null>(null);
  const [instruction, setInstruction] = useState(''); const [analysis, setAnalysis] = useState('');
  const [previousInstruction, setPreviousInstruction] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [aiScope, setAiScope] = useState<'selected' | 'all'>('selected'); const [rounds, setRounds] = useState(1);
  const [availableEffects, setAvailableEffects] = useState<string[]>([]);
  const [aiRunning, setAiRunning] = useState(false); const [processing, setProcessing] = useState<Processing | null>(null);
  const [arrangingAI, setArrangingAI] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [clipRename, setClipRename] = useState<{ trackId: string; clipId: string; name: string } | null>(null);
  const [optimizing, setOptimizing] = useState(false);
  const optimizationCancelled = useRef(false);
  const [aiDetails, setAiDetails] = useState('');
  const [baseUrl, setBaseUrl] = useState(''); const [model, setModel] = useState(''); const [key, setKey] = useState(''); const [deviceId, setDeviceId] = useState('');
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [notifications, setNotifications] = useState<{ id: number; text: string; error: boolean; time: string }[]>([]);
  const [toastItems, setToastItems] = useState<Notification[]>([]);
  const [toastExpanded, setToastExpanded] = useState(false);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const notificationState = useRef({ error: '', notice: '', nextId: 0 });
  const [busy, setBusy] = useState(''); const [connected, setConnected] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, GraphDraft>>({});
  const draftById = useRef<Record<string, GraphDraft>>({});
  const auditioned = useRef<{ id: string; key: string } | null>(null);
  const previewPending = useRef(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [split, setSplit] = useState(49); const workspace = useRef<HTMLDivElement>(null);
  const [aiWidth, setAiWidth] = useState(320);
  const mainLayout = useRef<HTMLDivElement>(null);
  const aiSidebar = useRef<HTMLElement>(null);
  const splitGrab = useRef(0);
  const [trackHeights, setTrackHeights] = useState<Record<string, number>>({});
  const [showMaster, setShowMaster] = useState(true);
  const trackOrderDrag = useRef<{ id: string; pointer: number; startY: number; active: boolean; index: number } | null>(null);
  const [trackOrderMarker, setTrackOrderMarker] = useState<{ id: string; after: boolean } | null>(null);
  const trackGrab = useRef(0);
  const shortcutRegion = useRef<'graph' | 'tracks'>('graph');
  const trackClipboard = useRef<{ track: Track; draft?: GraphDraft } | null>(null);
  const trackHistory = useRef<{ past: TrackHistoryEntry[]; future: TrackHistoryEntry[] }>({ past: [], future: [] });
  const [trackWidth, setTrackWidth] = useState(() => window.innerWidth <= 800 ? 184 : 216);
  const widthGrab = useRef(0);
  const layout = useRef({ width: trackWidth, heights: trackHeights });
  const resizeHistory = useRef<LayoutSnapshot | null>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const horizontalGrab = useRef(0);
  const verticalGrab = useRef(0);
  const [verticalScroll, setVerticalScroll] = useState({ top: 0, height: 0, content: 0 });
  const [timeView, setTimeView] = useState(INITIAL_TIMELINE);
  const [loopPreview, setLoopPreview] = useState<LoopSelection | null>(null);
  const [loopUpdating, setLoopUpdating] = useState(false);
  const loopPending = useRef(false);
  const loopDrag = useRef<{ x: number; anchor: number; current: number; active: boolean } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null | undefined>();
  const [referenceDrop, setReferenceDrop] = useState(false);
  const clipDrag = useRef<ClipDrag | null>(null);
  const clipMoving = useRef(false);
  const [clipDragging, setClipDragging] = useState(false);
  const [clipPreview, setClipPreview] = useState<ClipDrag | null>(null);
  const [contextClip, setContextClip] = useState<string | null>(null);
  const [selectedClips, setSelectedClips] = useState<{ trackId: string; id: string }[]>([]);
  const queue = useRef<Promise<unknown>>(Promise.resolve()); const clipboard = useRef<NodeClipboard | null>(null);
  const graphHistory = useRef(new Map<string, GraphHistory>());
  const [graphEpoch, setGraphEpoch] = useState(0);
  const [saved, setSaved] = useState(false);
  const [closePrompt, setClosePrompt] = useState(false);
  const allowClose = useRef(false);
  const updateProject = useCallback((value: Project) => { current.current = value; setProject(value); setSaved(false); }, []);
  const perform = useCallback(async <T,>(label: string, action: () => Promise<T>, showBusy = true): Promise<T | undefined> => {
    const run = queue.current.then(async () => {
      if (showBusy) { setBusy(label); setError(''); setNotice(''); }
      try { return await action(); } catch (failure) { setError(message(failure)); return undefined; }
      finally { if (showBusy) setBusy(''); }
    }); queue.current = run; return run;
  }, []);
  const initialize = useCallback(async () => {
    await perform('连接音频引擎…', async () => {
      const value = await engine<Project>({ command: 'project' }); updateProject(value); setConnected(true);
      acceptState(await engine<EngineState>({ command: 'state' }));
    });
    void perform('读取效果器与设置…', async () => {
      const results = await Promise.allSettled([ai<Catalog>({ command: 'catalog' }), native<Settings>('get_settings')]);
      if (results[0].status === 'fulfilled') { const value = results[0].value; setCatalog(value); setAvailableEffects(Object.keys(value.catalog)); }
      if (results[1].status === 'fulfilled') { const value = results[1].value; setSettings(value); setBaseUrl(value.baseUrl); setModel(value.model); setDeviceId(value.deviceId); }
      const failed = results.filter(result => result.status === 'rejected'); if (failed.length) throw new Error(failed.map(result => result.status === 'rejected' ? message(result.reason) : '').join('；'));
    });
  }, [perform, updateProject, acceptState]);
  useEffect(() => { void initialize(); }, [initialize]);
  useLayoutEffect(() => {
    const container = mainLayout.current;
    if (!container) return;
    const observer = new ResizeObserver(() => setAiWidth(width => Math.max(0, Math.min(width, container.clientWidth - 6))));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const previous = notificationState.current;
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const added = [
      ...(error && error !== previous.error ? [{ id: previous.nextId++, text: error, error: true, time }] : []),
      ...(notice && notice !== previous.notice ? [{ id: previous.nextId++, text: notice, error: false, time }] : []),
    ];
    previous.error = error; previous.notice = notice;
    if (!added.length) return;
    setNotifications(current => [...added, ...current].slice(0, 100));
    setToastItems(current => [...added, ...current].slice(0, 3));
    if (menu !== 'notifications') setUnreadNotifications(count => Math.min(100, count + added.length));
  }, [error, notice]);
  useEffect(() => {
    if (!toastItems.length || toastExpanded) return;
    const timer = window.setTimeout(() => setToastItems([]), 7000);
    return () => window.clearTimeout(timer);
  }, [toastItems, toastExpanded]);
  useEffect(() => { if (!aiRunning && !optimizing) setConfirmCancel(false); }, [aiRunning, optimizing]);
  useEffect(() => { setPanelOffset({ x: 0, y: 0 }); }, [panel]);
  useEffect(() => {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    let active = true;
    let unlisten: (() => void) | undefined;
    const update = () => { void appWindow.isMaximized().then(value => { if (active) setMaximized(value); }); };
    update();
    void appWindow.onResized(update).then(remove => { if (active) unlisten = remove; else remove(); });
    return () => { active = false; unlisten?.(); };
  }, []);
  useLayoutEffect(() => { document.documentElement.classList.toggle('dark', theme); localStorage.setItem('orvo-theme', theme ? 'dark' : 'light'); }, [theme]);
  useEffect(() => {
    if (!connected) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await engine<EngineState>({ command: 'state' }); if (active) acceptState(value); }
      catch (failure) { if (active) { setError(`音频引擎连接中断：${message(failure)}`); setConnected(false); } return; }
      if (active) timer = setTimeout(poll, uiActive ? 100 : 1000);
    }; void poll(); return () => { active = false; clearTimeout(timer); };
  }, [connected, acceptState, uiActive]);
  useEffect(() => {
    if (!aiRunning) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await native<Processing>('get_processing');
        if (active) setProcessing(value);
        if (active && panel === 'logs') {
          const logs = await native<string[]>('get_logs');
          if (active) setAnalysis(logs.join('\n'));
        }
      }
      catch (failure) { if (active) setError(`读取 AI 进度失败：${message(failure)}`); }
      if (active) timer = setTimeout(poll, uiActive ? 300 : 1500);
    };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [aiRunning, panel, uiActive]);
  const selectedTrack = project?.tracks.find(track => track.id === selected);
  const materialTracks = project?.tracks.filter(track => track.source) ?? [];
  const hasMaterial = materialTracks.length > 0;
  const aiTargetCount = aiScope === 'all' ? materialTracks.length : Number(selected === 'master' ? hasMaterial : !!selectedTrack?.source);
  const channel = selected === 'master' ? project?.master : selectedTrack;
  const draft = drafts[selected];
  const graphDirty = !!(draft && channel && audioGraphKey(draft.graph) !== audioGraphKey(channel.graph));
  const rememberDraft = useCallback((id: string, next?: GraphDraft) => {
    const updated = { ...draftById.current };
    if (next) updated[id] = next; else delete updated[id];
    draftById.current = updated;
    setDrafts(updated);
  }, []);
  const trackSnapshot = (): TrackSnapshot => ({ kind: 'tracks', tracks: structuredClone(current.current?.tracks ?? []), drafts: structuredClone(draftById.current), selected: selectedId.current });
  const layoutSnapshot = (): LayoutSnapshot => ({ kind: 'layout', width: layout.current.width, heights: { ...layout.current.heights } });
  const recordTrackChange = (before: TrackHistoryEntry) => {
    trackHistory.current.past.push(before);
    if (trackHistory.current.past.length > 30) trackHistory.current.past.shift();
    trackHistory.current.future = [];
  };
  const onDraftChange = useCallback((graph: Graph, preview: boolean) => {
    const id = selected;
    const committed = id === 'master' ? current.current?.master.graph : current.current?.tracks.find(track => track.id === id)?.graph;
    rememberDraft(id, JSON.stringify(graph) === JSON.stringify(committed) ? undefined : { graph, preview });
    setSaved(false);
    if (!committed || JSON.stringify(committedPositions(committed, graph)) === JSON.stringify(committed.routing.positions)) return;
    void perform('保存节点布局…', async () => {
      const currentGraph = id === 'master' ? current.current?.master.graph : current.current?.tracks.find(track => track.id === id)?.graph;
      if (!currentGraph) return;
      const positions = committedPositions(currentGraph, graph);
      if (JSON.stringify(positions) === JSON.stringify(currentGraph.routing.positions)) return;
      const value = await engine<Project>({ command: 'set_graph_positions', id, positions });
      updateProject(value);
      const latest = draftById.current[id];
      const savedGraph = id === 'master' ? value.master.graph : value.tracks.find(track => track.id === id)?.graph;
      if (latest && JSON.stringify(latest.graph) === JSON.stringify(savedGraph)) rememberDraft(id);
    }, false);
  }, [selected, rememberDraft, perform, updateProject]);
  const flushPreview = useEffectEvent(async () => {
    if (!connected || aiRunning) return;
    const id = selectedId.current;
    const next = draftById.current[id];
    const committed = id === 'master' ? current.current?.master.graph : current.current?.tracks.find(track => track.id === id)?.graph;
    const key = next?.preview && committed ? audioGraphKey(next.graph) : null;
    const previewKey = key && committed && key !== audioGraphKey(committed) ? key : null;
    const prior = auditioned.current;
    if (prior && (prior.id !== id || !previewKey)) {
      await engine({ command: 'preview_graph', id: prior.id, graph: null });
      auditioned.current = null;
    }
    if (next && previewKey && auditioned.current?.key !== previewKey
      && selectedId.current === id && draftById.current[id] === next) {
      await engine({ command: 'preview_graph', id, graph: next.graph });
      auditioned.current = { id, key: previewKey };
    }
  });
  useEffect(() => {
    if (!connected || aiRunning || previewPending.current) return;
    previewPending.current = true;
    previewTimer.current = setTimeout(() => void perform('试听 FX…', async () => {
      previewPending.current = false;
      await flushPreview();
    }, false), 35);
  }, [selected, draft, channel?.graph, connected, aiRunning, perform]);
  useEffect(() => () => { clearTimeout(previewTimer.current); previewPending.current = false; }, []);
  const locked = !!busy || !connected;
  const effectOptions = Object.entries(catalog?.catalog ?? {});
  const progressText = aiRunning && processing?.active ? [
    `${Math.min(processing.completed + (processing.phase === 'complete' || processing.phase === 'failed' ? 0 : 1), processing.total)}/${processing.total}`,
    processing.label, phases[processing.phase], processing.round > 0 ? `${processing.round}/${processing.rounds} 轮` : '',
  ].filter(Boolean).join(' · ') : '';
  const setPlaybackStart = (position: number) => { startAt.current = position; setStartPosition(position); };
  const toggleTransport = useCallback((source: string) => {
    void perform('切换播放…', async () => {
      if (playingNow.current && playbackSource.current === source) {
        await engine({ command: 'pause' });
      } else {
        const loop = current.current?.loop;
        const position = loop?.enabled && (startAt.current < loop.start || startAt.current >= loop.end) ? loop.start : startAt.current;
        if (position !== startAt.current) { startAt.current = position; setStartPosition(position); }
        await engine({ command: 'play', position, ...(source === 'master' ? {} : { trackId: source }) });
        setShowProgress(true);
      }
      acceptState(await engine<EngineState>({ command: 'state' }));
    }, false);
  }, [perform, acceptState]);
  const togglePlayback = useCallback(() => toggleTransport('master'), [toggleTransport]);
  const stopTransport = (source: string) => void perform('停止…', async () => {
    if (playbackSource.current !== source) return;
    await engine({ command: 'stop' });
    setPlaybackStart(0);
    setShowProgress(false);
    setTimeView(view => view.start === 0 ? view : { ...view, start: 0 });
    acceptState(await engine<EngineState>({ command: 'state' }));
  }, false);
  const stopPlayback = () => stopTransport('master');
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, [contenteditable], [role="dialog"]') || document.querySelector('.utility-backdrop')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); return; }
      if (event.code !== 'Space' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (target instanceof HTMLElement && !target.matches('canvas[data-seekable]')
        && target.closest('[role="slider"], [role="listbox"], [role="combobox"], [role="menu"]')) return;
      event.preventDefault();
      if (!locked && hasMaterial) togglePlayback();
    };
    document.addEventListener('keydown', keydown); return () => document.removeEventListener('keydown', keydown);
  }, [locked, hasMaterial, togglePlayback]);
  useEffect(() => {
    const returnFocus = (event: PointerEvent) => {
      const target = event.target;
      if (event.button !== 0 || !(target instanceof Element)) return;
      const menuItem = target.closest('[role="menuitem"], [role="option"]');
      if (!menuItem && (!target.closest('.workbench')
        || target.closest('input:not([type="range"]), textarea, [contenteditable], [role="dialog"], [role="menu"], [role="listbox"], [role="combobox"]'))) return;
      const restore = () => {
        if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
        const active = document.activeElement;
        if (active instanceof Element && active.matches('input:not([type="range"]), textarea, [contenteditable]') && active !== target) return;
        document.querySelector<HTMLElement>(shortcutRegion.current === 'tracks' ? '.timeline-panel' : '.blueprint-canvas')?.focus({ preventScroll: true });
      };
      if (menuItem) window.setTimeout(restore, 200);
      else requestAnimationFrame(restore);
    };
    document.addEventListener('pointerup', returnFocus);
    return () => document.removeEventListener('pointerup', returnFocus);
  }, []);
  useEffect(() => {
    if (selected === 'master') return;
    timeline.current?.querySelector(`[data-track-id="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const playbackDuration = state?.duration ?? 0;
  const playhead = state?.position ?? 0;
  const contentDuration = Math.max(playbackDuration, ...project?.tracks.map(track => track.duration) ?? []);
  const scrollLimit = timelineScrollLimit(timeView.span, contentDuration);
  const thumbWidth = scrollLimit > 0 ? timeView.span / (timeView.span + scrollLimit) * 100 : 100;
  const thumbRatio = scrollLimit > 0 ? Math.max(0, Math.min(1, timeView.start / scrollLimit)) : 0;
  const updateVerticalScroll = useCallback(() => {
    const tracks = timeline.current;
    if (!tracks) return;
    const next = { top: tracks.scrollTop, height: tracks.clientHeight, content: tracks.scrollHeight };
    setVerticalScroll(previous => previous.top === next.top && previous.height === next.height && previous.content === next.content ? previous : next);
  }, []);
  useLayoutEffect(() => {
    const tracks = timeline.current;
    if (!tracks) return;
    const observer = new ResizeObserver(updateVerticalScroll);
    observer.observe(tracks);
    for (const child of tracks.children) observer.observe(child);
    updateVerticalScroll();
    return () => observer.disconnect();
  }, [project?.tracks.length, trackHeights, split, clipPreview?.target, updateVerticalScroll]);
  useLayoutEffect(() => {
    if (clipPreview?.target !== NEW_TRACK) return;
    const tracks = timeline.current;
    const preview = tracks?.querySelector<HTMLElement>('.track-bed-preview');
    if (!tracks || !preview) return;
    const overflow = preview.getBoundingClientRect().bottom - tracks.getBoundingClientRect().bottom;
    if (overflow > 0) tracks.scrollTop += overflow;
  }, [clipPreview?.target]);
  const verticalLimit = Math.max(0, verticalScroll.content - verticalScroll.height);
  const verticalThumb = verticalLimit ? Math.max(0, (verticalScroll.height - 29) / (verticalScroll.content - 29)) : 1;
  const moveVerticalScrollbar = (event: React.PointerEvent<HTMLDivElement>) => {
    const bar = event.currentTarget;
    const thumb = bar.firstElementChild as HTMLElement;
    const range = bar.clientHeight - thumb.offsetHeight;
    if (range > 0 && timeline.current) timeline.current.scrollTop = Math.max(0, Math.min(1, (event.clientY - bar.getBoundingClientRect().top - verticalGrab.current) / range)) * verticalLimit;
  };
  const moveTimelineScrollbar = (event: React.PointerEvent<HTMLDivElement>) => {
    const bar = event.currentTarget;
    const thumb = bar.firstElementChild as HTMLElement | null;
    if (!thumb) return;
    const range = bar.clientWidth - thumb.offsetWidth;
    if (range <= 0) return;
    const fraction = Math.max(0, Math.min(1, (event.clientX - bar.getBoundingClientRect().left - horizontalGrab.current) / range));
    setTimeView(view => panTimeline(view, fraction * timelineScrollLimit(view.span, contentDuration) - view.start, contentDuration));
  };
  const beginTimelineScrollbar = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !scrollLimit) return;
    const thumb = event.currentTarget.firstElementChild as HTMLElement | null;
    if (!thumb) return;
    horizontalGrab.current = event.target === thumb ? event.clientX - thumb.getBoundingClientRect().left : thumb.offsetWidth / 2;
    event.currentTarget.setPointerCapture(event.pointerId);
    moveTimelineScrollbar(event);
  };
  const onTimelineWheel = useEffectEvent((event: WheelEvent) => {
    const surface = event.target instanceof Element && event.target.closest('.ruler, .track-lane');
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const width = timeline.current?.querySelector('.ruler')?.getBoundingClientRect().width ?? 0;
      const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 240 : 1;
      if (width > 0) setTimeView(view => panTimeline(view, (event.deltaX || event.deltaY) * units / width * view.span, contentDuration));
      return;
    }
    if (!surface) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) return;
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 240 : 1;
    if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      const width = surface.getBoundingClientRect().width;
      if (width > 0) setTimeView(view => panTimeline(view, (event.deltaX || event.deltaY) * units / width * view.span, contentDuration));
    } else if (event.deltaY) {
      setTimeView(view => zoomTimeline(view,
        state?.playing ? playhead : startPosition, event.deltaY * units, contentDuration));
    }
  });
  useEffect(() => {
    const tracks = timeline.current!;
    const onWheel = (event: WheelEvent) => onTimelineWheel(event);
    tracks.addEventListener('wheel', onWheel, { passive: false });
    return () => tracks.removeEventListener('wheel', onWheel);
  }, []);
  useEffect(() => {
    if (!state?.playing) return;
    setTimeView(view => playhead >= view.start && playhead < view.start + view.span
      ? view : panTimeline(view, playhead - view.start - view.span * .1, playbackDuration));
  }, [state?.playing, playhead, playbackDuration]);
  const patchChannel = (id: string, patch: Partial<Track>) => perform('更新通道…', async () => {
    const before = id === 'master' ? null : trackSnapshot();
    const value = await engine<Project>(id === 'master' ? { command: 'set_master', ...patch } : { command: 'set_track', id, ...patch });
    if (before) recordTrackChange(before);
    updateProject(value);
    return true;
  }, false);
  const chooseChannel = (id: string) => {
    if (locked || id === selectedId.current) return;
    selectChannel(id);
    void perform('切换频谱…', () => engine({ command: 'set_spectrum', source: id }), false);
  };
  const finishRename = (track: Track, value: string) => {
    setRenamingTrack(null);
    const label = value.trim();
    if (label && label !== track.label) void patchChannel(track.id, { label });
  };
  const commitGraph = useCallback(async (id: string, graph: Graph) => {
    const value = await engine<Project>(id === 'master'
      ? { command: 'set_master', graph }
      : { command: 'set_track', id, graph });
    if (auditioned.current?.id === id) auditioned.current = null;
    if (JSON.stringify(draftById.current[id]?.graph) === JSON.stringify(graph)) rememberDraft(id);
    updateProject(value);
    return true;
  }, [rememberDraft, updateProject]);
  const applyGraph = useCallback((graph: Graph): Promise<boolean> =>
    perform('校验并应用 FX…', () => commitGraph(selected, graph), false).then(result => result === true), [perform, commitGraph, selected]);
  const addTrack = () => {
    setMenu(null);
    void perform('新建轨道…', async () => {
      const before = trackSnapshot();
      setError(''); setNotice('');
      const value = await engine<Project>({ command: 'add_track' });
      recordTrackChange(before);
      updateProject(value);
      const track = value.tracks.at(-1);
      if (track && selectedId.current === before.selected) { selectChannel(track.id); await engine({ command: 'set_spectrum', source: track.id }); }
    }, false);
  };
  const editTrack = (id: string, duplicate: boolean) => void perform(duplicate ? '复制轨道…' : '删除轨道…', async () => {
    const before = trackSnapshot();
    setError(''); setNotice('');
    const index = current.current?.tracks.findIndex(track => track.id === id) ?? -1;
    const value = await engine<Project>({ command: duplicate ? 'duplicate_track' : 'remove_track', id });
    recordTrackChange(before);
    updateProject(value);
    if (duplicate) {
      const created = value.tracks[index + 1];
      const draft = draftById.current[id];
      if (created && draft) rememberDraft(created.id, structuredClone(draft));
      if (created && selectedId.current === before.selected) { selectChannel(created.id); await engine({ command: 'set_spectrum', source: created.id }); }
    } else {
      if (auditioned.current?.id === id) auditioned.current = null;
      rememberDraft(id);
      if (selectedId.current === id) { selectChannel('master'); await engine({ command: 'set_spectrum', source: 'master' }); }
    }
    acceptState(await engine<EngineState>({ command: 'state' }));
  }, false);
  const beginTrackOrder = (event: React.PointerEvent<HTMLDivElement>, id: string) => {
    if (event.button !== 0 || locked || graphDirty) return;
    const target = event.target as Element;
    if (target.closest('input, textarea, .mixer-rail, .track-resize, .track-width-resize') || (target.closest('button') && !target.closest('.track-name'))) return;
    trackOrderDrag.current = { id, pointer: event.pointerId, startY: event.clientY, active: false, index: 0 };
  };
  const moveTrackOrder = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = trackOrderDrag.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!drag.active && Math.abs(event.clientY - drag.startY) < 5) return;
    if (!drag.active) { drag.active = true; event.currentTarget.setPointerCapture(event.pointerId); }
    const rows = [...(timeline.current?.querySelectorAll<HTMLElement>('.track-row[data-track-id]') ?? [])].filter(row => row.dataset.trackId !== drag.id);
    drag.index = rows.filter(row => event.clientY >= row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2).length;
    const marker = rows[drag.index] ?? rows.at(-1);
    setTrackOrderMarker(marker?.dataset.trackId ? { id: marker.dataset.trackId, after: drag.index === rows.length } : null);
  };
  const finishTrackOrder = (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    const drag = trackOrderDrag.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    trackOrderDrag.current = null; setTrackOrderMarker(null);
    if (!drag.active || cancelled) return;
    event.preventDefault(); event.stopPropagation();
    void perform('调整音轨顺序…', async () => {
      const before = trackSnapshot();
      const original = before.tracks.findIndex(track => track.id === drag.id);
      if (original < 0) return;
      const tracks = [...before.tracks]; const [moved] = tracks.splice(original, 1);
      tracks.splice(Math.min(drag.index, tracks.length), 0, moved);
      if (tracks.every((track, index) => track.id === before.tracks[index].id)) return;
      const value = await engine<Project>({ command: 'restore_tracks', tracks });
      recordTrackChange(before); updateProject(value);
    });
  };
  const clearTrackContent = (id: string) => void perform('清除音轨内容…', async () => {
    const before = trackSnapshot();
    if (!before.tracks.some(track => track.id === id && track.source)) return;
    const tracks = before.tracks.map(track => track.id === id ? { ...track, source: null, clips: [] } : track);
    const value = await engine<Project>({ command: 'restore_tracks', tracks });
    recordTrackChange(before);
    updateProject(value);
    acceptState(await engine<EngineState>({ command: 'state' }));
  });
  const removeClip = (trackId: string, clipId: string) => void perform('删除音频片段…', async () => {
    const before = trackSnapshot();
    const track = before.tracks.find(item => item.id === trackId);
    if (!track?.clips.some(clip => clip.id === clipId)) return;
    const clips = track.clips.filter(clip => clip.id !== clipId);
    const tracks = before.tracks.map(item => item.id === trackId ? { ...item, clips, source: clips[0]?.source ?? null } : item);
    const value = await engine<Project>({ command: 'restore_tracks', tracks });
    recordTrackChange(before); updateProject(value);
    acceptState(await engine<EngineState>({ command: 'state' }));
  });
  const renameClip = () => {
    if (!clipRename) return;
    if (!clipRename.name.trim()) { setClipRename(null); return; }
    const { trackId, clipId, name } = clipRename;
    setClipRename(null);
    void perform('重命名音频片段…', async () => {
      const before = trackSnapshot();
      const tracks = before.tracks.map(track => track.id !== trackId ? track : { ...track, clips: track.clips.map(clip => clip.id === clipId ? { ...clip, name: name.trim() } : clip) });
      const value = await engine<Project>({ command: 'restore_tracks', tracks });
      recordTrackChange(before); updateProject(value);
    });
  };
  const pasteTrack = () => void perform('粘贴音轨…', async () => {
    const copied = trackClipboard.current;
    if (!copied) return;
    const before = trackSnapshot();
    const ids = new Set(before.tracks.map(track => track.id));
    const value = await engine<Project>({ command: 'paste_track', track: copied.track, after: selectedId.current });
    recordTrackChange(before);
    const created = value.tracks.find(track => !ids.has(track.id));
    if (created && copied.draft) rememberDraft(created.id, structuredClone(copied.draft));
    updateProject(value);
    if (created) { selectChannel(created.id); await engine({ command: 'set_spectrum', source: created.id }); }
    acceptState(await engine<EngineState>({ command: 'state' }));
  });
  const restoreTrackHistory = (redo: boolean) => void perform(redo ? '重做音轨操作…' : '撤销音轨操作…', async () => {
    const history = trackHistory.current;
    const source = redo ? history.future : history.past;
    const destination = redo ? history.past : history.future;
    const previous = source.at(-1);
    if (!previous) return;
    if (previous.kind === 'layout') {
      const before = layoutSnapshot();
      source.pop(); destination.push(before);
      layout.current = { width: previous.width, heights: { ...previous.heights } };
      setTrackWidth(previous.width); setTrackHeights(layout.current.heights);
      return;
    }
    const before = trackSnapshot();
    const existing = new Map(before.tracks.map(track => [track.id, track]));
    const tracks = previous.tracks.map(track => ({ ...track, graph: existing.get(track.id)?.graph ?? track.graph }));
    const value = await engine<Project>({ command: 'restore_tracks', tracks });
    source.pop(); destination.push(before);
    const restoredDrafts = { ...previous.drafts, ...before.drafts };
    for (const id of Object.keys(restoredDrafts)) if (id !== 'master' && !value.tracks.some(track => track.id === id)) delete restoredDrafts[id];
    draftById.current = restoredDrafts; setDrafts(restoredDrafts);
    if (auditioned.current && !value.tracks.some(track => track.id === auditioned.current?.id) && auditioned.current.id !== 'master') auditioned.current = null;
    updateProject(value);
    const target = value.tracks.some(track => track.id === previous.selected) ? previous.selected : 'master';
    selectChannel(target);
    await engine({ command: 'set_spectrum', source: target });
    acceptState(await engine<EngineState>({ command: 'state' }));
  });
  const trackKeydown = useEffectEvent((event: KeyboardEvent) => {
    if (shortcutRegion.current !== 'tracks' || event.defaultPrevented || event.repeat || locked || panel) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, [contenteditable], [role="dialog"], [role="menu"], [role="listbox"], [role="combobox"]')) return;
    if (event.altKey) return;
    const key = event.key.toLowerCase();
    const modified = event.ctrlKey || event.metaKey;
    if (modified && !event.shiftKey && key === 'c') {
      const track = current.current?.tracks.find(item => item.id === selectedId.current);
      if (track) { trackClipboard.current = { track: structuredClone(track), draft: structuredClone(draftById.current[track.id]) }; event.preventDefault(); }
    } else if (modified && !event.shiftKey && key === 'v' && trackClipboard.current) {
      event.preventDefault(); pasteTrack();
    } else if (modified && (key === 'z' || key === 'y')) {
      event.preventDefault(); restoreTrackHistory(key === 'y' || event.shiftKey);
    } else if (!modified && !event.shiftKey && (key === 'delete' || key === 'backspace') && selectedId.current !== 'master') {
      event.preventDefault(); editTrack(selectedId.current, false);
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => trackKeydown(event);
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, []);
  const importPaths = async (paths: string[], trackId?: string, position?: number) => {
    if (!paths.length) return;
    const before = trackSnapshot();
    const result = await engine<Project>({ command: 'import', paths, trackId, position });
    recordTrackChange(before);
    updateProject(result);
    acceptState(await engine<EngineState>({ command: 'state' }));
  };
  const importAudio = (trackId?: string) => {
    setMenu(null);
    void perform('导入音频…', async () => {
      const paths = await native<string[]>('pick_audio');
      if (paths) await importPaths(paths, trackId);
    });
  };
  const onAudioDrop = useEffectEvent((event: DragDropEvent) => {
    if (event.type === 'leave' || locked || graphDirty || panel) { setDropTarget(undefined); setReferenceDrop(false); return; }
    const scale = window.devicePixelRatio || 1;
    const element = document.elementFromPoint(event.position.x / scale, event.position.y / scale);
    const overReference = !!element?.closest('.reference-picker');
    setReferenceDrop(overReference && event.type !== 'drop');
    if (overReference && event.type === 'drop') {
      setDropTarget(undefined);
      const path = event.paths[0];
      if (path && /\.(wav|wave|mp3|flac|ogg|oga|opus|aif|aiff|aifc|m4a|aac|wma|caf)$/i.test(path)) { setReference(path); setSaved(false); }
      else setError('请选择支持的音频文件');
      return;
    }
    if (element?.closest('.master-track')) { setDropTarget(undefined); return; }
    const inTimeline = element && timeline.current?.contains(element);
    const trackId = element?.closest<HTMLElement>('[data-track-id]')?.dataset.trackId;
    if (event.type === 'drop') {
      setDropTarget(undefined);
      if (inTimeline && event.paths.length) {
        const lane = element?.closest<HTMLElement>('.track-lane');
        const rect = lane?.getBoundingClientRect();
        const position = trackId && rect?.width ? Math.max(0, Math.min(86400000, timeView.start + (event.position.x / scale - rect.left) / rect.width * timeView.span)) : undefined;
        void perform('导入音频…', () => importPaths(event.paths, trackId, position));
      }
    } else {
      setDropTarget(inTimeline ? trackId ?? null : undefined);
    }
  });
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onDragDropEvent(({ payload }) => { if (!disposed) onAudioDrop(payload); }).then(remove => {
      if (disposed) remove();
      else unlisten = remove;
    }, failure => { if (!disposed) setError(`无法启用音频拖放：${message(failure)}`); });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const aiContext = { instruction, reference, rounds, availableEffects };
  const editInstruction = (text: string) => {
    setInstruction(text); setPreviousInstruction(null); setSaved(false);
  };
  const open = () => void perform('打开工程…', async () => {
    const value = await native<Project | null>('open_project');
    if (!value) return;
    updateProject(value);
    trackHistory.current = { past: [], future: [] };
    graphHistory.current.clear(); setGraphEpoch(epoch => epoch + 1);
    trackClipboard.current = null;
    selectChannel('master');
    setRenamingTrack(null);
    setTrackHeights({});
    draftById.current = {};
    setDrafts({});
    auditioned.current = null;
    setPlaybackStart(0);
    setShowProgress(false);
    setTimeView(INITIAL_TIMELINE);
    await engine({ command: 'set_spectrum', source: 'master' });
    acceptState(await engine<EngineState>({ command: 'state' }));
    setInstruction(value.ai?.instruction ?? '');
    setPreviousInstruction(null);
    setReference(value.ai?.reference ?? null);
    setRounds(value.ai?.rounds ?? 1);
    setAvailableEffects(value.ai?.availableEffects.filter(id => !!catalog?.catalog[id]) ?? Object.keys(catalog?.catalog ?? {}));
    setAiDetails('');
    setProjectName(value.name === 'Untitled' ? '未命名' : value.name);
    setSaved(true);
    setNotice('工程已打开');
  });
  const saveProject = async () => {
    if (!current.current) return false;
    const hasDraft = Object.entries(draftById.current).some(([id, entry]) => {
      const graph = id === 'master' ? current.current?.master.graph : current.current?.tracks.find(track => track.id === id)?.graph;
      return graph && audioGraphKey(entry.graph) !== audioGraphKey(graph);
    });
    if (hasDraft) { setNotice('请先应用或放弃 FX 修改，再保存工程'); return false; }
    const path = await native<string | null>('save_project', { project: current.current, aiContext });
    if (!path) return false;
    const file = path.split(/[\\/]/).pop() ?? '';
    setProjectName(file.replace(/\.orvo$/i, '') || '未命名');
    setSaved(true); setNotice(`已保存：${path}`); return true;
  };
  const save = () => void perform('保存工程…', saveProject);
  const handleCloseRequest = useEffectEvent((event: { preventDefault: () => void }) => {
    if (!allowClose.current && !saved && current.current) { event.preventDefault(); setClosePrompt(true); }
  });
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false; let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested(event => handleCloseRequest(event)).then(stop => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const closeWithoutSaving = () => { allowClose.current = true; setClosePrompt(false); void getCurrentWindow().close().catch(failure => { allowClose.current = false; setError(`关闭窗口失败：${message(failure)}`); }); };
  const saveAndClose = () => {
    if (busy) { setNotice('请等待当前操作结束后保存，或选择不保存'); return; }
    void perform('保存工程…', saveProject).then(success => { if (success) closeWithoutSaving(); });
  };
  const saveShortcut = useEffectEvent(() => {
    if (locked || !project) return;
    if (graphDirty) { setNotice('请先应用或放弃 FX 修改，再保存工程'); return; }
    save();
  });
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      if (event.repeat) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches('input, textarea, [contenteditable="true"]')) {
        active.blur();
        window.setTimeout(() => saveShortcut(), 0);
      } else saveShortcut();
    };
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  }, []);
  const importPlan = () => {
    setMenu(null);
    void perform('导入 FX 方案…', async () => {
      const graph = await native<Graph | null>('open_fx_plan');
      if (graph) { await commitGraph(selected, graph); setNotice('FX 方案已应用'); }
    });
  };
  const exportPlan = () => {
    setMenu(null);
    if (!channel) return;
    void perform('导出 FX 方案…', async () => {
      const path = await native<string | null>('save_fx_plan', { graph: channel.graph });
      if (path) setNotice(`方案已保存：${path}`);
    });
  };
  const saveTrackResult = () => {
    setMenu(null);
    if (!selectedTrack?.source) return;
    void perform('保存音轨结果…', async () => {
      const path = await native<string | null>('save_track_result', { trackId: selectedTrack.id, aiContext });
      if (path) setNotice(`结果已保存：${path}`);
    });
  };
  const exportAudio = (track?: Track) => { setMenu(null); void perform(track ? '导出所选音轨…' : '导出完整混音…', async () => {
    if (graphDirty) throw new Error('请先应用或放弃 FX 草稿');
    const path = await native<string | null>('pick_export'); if (path) { await engine(track ? { command: 'export_track', id: track.id, path } : { command: 'export', path }); setNotice(`${track ? track.label : '混音'}已导出：${path}`); }
  }); };
  const optimize = () => void perform('优化声音目标…', async () => {
    optimizationCancelled.current = false;
    setOptimizing(true);
    try {
      const value = await ai<{ instruction: string }>({
        command: 'optimize', instruction, availableEffects, referenceProvided: !!reference,
        batchFileCount: aiTargetCount,
      });
      if (optimizationCancelled.current) return;
      setPreviousInstruction(instruction);
      setInstruction(value.instruction);
      setSaved(false);
      setNotice('声音目标已优化，可继续编辑');
    } catch (failure) {
      if (!optimizationCancelled.current) throw failure;
    } finally {
      if (optimizationCancelled.current) setNotice('已取消优化，保留原文');
      setOptimizing(false);
      setCancelling(false);
    }
  });
  const cancel = async () => {
    setConfirmCancel(false);
    setCancelling(true);
    if (optimizing) {
      optimizationCancelled.current = true;
      return;
    }
    try {
      if (!await native<boolean>('cancel_ai')) setCancelling(false);
    } catch (failure) {
      setError(message(failure));
      setCancelling(false);
    }
  };
  const generate = () => void perform('AI 处理中…', async () => {
    if (graphDirty) throw new Error('请先应用或放弃 FX 草稿');
    const trackIds = aiScope === 'all' ? materialTracks.map(track => track.id) : selected === 'master' && hasMaterial ? ['master'] : selectedTrack?.source ? [selectedTrack.id] : [];
    if (!trackIds.length) throw new Error('请选择一条有音频素材的轨道');
    if (!availableEffects.length) throw new Error('请至少选择一种可用效果器');
    setAiDetails(''); setProcessing(null); setAiRunning(true);
    const started = performance.now();
    try {
      const result = await native<AIRunResult>('run_ai', { request: { trackIds, instruction, reference, rounds, availableEffects } });
      const completed = result.items.filter(item => item.status === 'complete').length;
      if (completed) {
        setArrangingAI(true);
        trackHistory.current = { past: [], future: [] };
        for (const item of result.items) if (item.status === 'complete') graphHistory.current.delete(item.trackId);
        updateProject(result.project);
        try {
          for (const item of result.items) {
            if (item.status !== 'complete') continue;
            const graph = item.trackId === 'master' ? current.current?.master.graph : current.current?.tracks.find(candidate => candidate.id === item.trackId)?.graph;
            if (!graph) continue;
            const value = await engine<Project>({ command: 'set_graph_positions', id: item.trackId, positions: arrangeGeneratedGraph(graph) });
            updateProject(value);
          }
        } finally { setGraphEpoch(epoch => epoch + 1); }
      }
      const warnings = result.items.filter(item => item.warning).length;
      const summary = `${result.cancelled ? '已取消 · ' : ''}完成 ${completed}/${trackIds.length} 条音轨${completed < result.items.length ? ` · 失败 ${result.items.length - completed}` : ''}${warnings ? ` · ${warnings} 条提示` : ''} · ${((performance.now() - started) / 1000).toFixed(1)} 秒`;
      setNotice(summary);
      setAiDetails(result.items.map(item => `${item.label} · ${item.status === 'complete' ? '完成' : '失败'} · ${item.rounds} 轮\n${[stopReasons[item.stopReason] ?? item.stopReason, item.warning, item.error].filter(Boolean).join('\n')}`).join('\n\n'));
    } finally { setAiRunning(false); setArrangingAI(false); setProcessing(null); setCancelling(false); }
  });
  const showLogs = async () => {
    try {
      const logs = await native<string[]>('get_logs');
      setAnalysis([aiDetails, logs.join('\n')].filter(Boolean).join('\n\n') || '暂无运行日志');
      setPanel('logs');
    } catch (failure) { setError(message(failure)); }
  };
  const analyze = () => { setMenu(null); void perform('分析整段音频…', async () => { if (!selectedTrack?.source) throw new Error('请选择一条有音频素材的轨道'); const value = await native<unknown>('analyze_track', { trackId: selectedTrack.id }); setAnalysis(JSON.stringify(value, null, 2)); setPanel('analysis'); }); };
  const openSettings = (kind: 'api-settings' | 'audio-settings') => {
    setMenu(null);
    if (kind === 'api-settings') { setBaseUrl(settings?.baseUrl ?? ''); setModel(settings?.model ?? ''); setKey(''); }
    else {
      const configured = settings?.deviceId ?? '';
      setDeviceId(configured);
      setRefreshingDevices(true);
      void engine<Device[]>({ command: 'devices' }).then(available => {
        setDevices(available);
      }).catch(failure => setError(`读取输出设备失败：${message(failure)}`))
        .finally(() => setRefreshingDevices(false));
    }
    setPanel(kind);
  };
  const saveSettings = (apiSettings: boolean) => void perform('保存设置…', async () => {
    if (!settings) throw new Error('设置还未加载');
    const value = await native<Settings>('save_settings', { settings: apiSettings
      ? { baseUrl, model, key, deviceId: settings.deviceId }
      : { baseUrl: settings.baseUrl, model: settings.model, deviceId } });
    setSettings(value); setKey(''); setDeviceId(value.deviceId); setNotice('设置已保存'); setPanel(null);
  });
  const onMenuChange = (name: NonNullable<typeof menu>) => (open: boolean) => setMenu(previous => open ? name : previous === name ? null : previous);
  const seek = locked || playbackDuration <= 0 ? undefined : (position: number) =>
    setPlaybackStart(Math.max(0, Math.min(position, playbackDuration)));
  const playFromRuler = seek && ((position: number) => {
    const target = Math.max(0, Math.min(position, playbackDuration));
    setPlaybackStart(target);
    if (!playingNow.current) { setShowProgress(false); return; }
    void perform('定位播放…', async () => {
      if (!playingNow.current) { setShowProgress(false); return; }
      const source = playbackSource.current;
      await engine({ command: 'play', position: target, ...(source === 'master' ? {} : { trackId: source }) });
      setShowProgress(true);
      acceptState(await engine<EngineState>({ command: 'state' }));
    }, false);
  });
  const loopSelection = loopPreview ?? project?.loop;
  const commitLoop = (loop: LoopSelection, positionAtStart = false) => {
    if (loopPending.current) return;
    loopPending.current = true;
    setLoopUpdating(true);
    setLoopPreview(loop);
    void perform('更新循环选区…', async () => {
      const value = await engine<Project>({ command: 'set_loop', ...loop });
      updateProject(value);
      if (positionAtStart && !playingNow.current) { setPlaybackStart(loop.start); setShowProgress(false); }
    }, false).finally(() => { loopPending.current = false; setLoopUpdating(false); setLoopPreview(null); });
  };
  const clearLoopShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || panel || menu) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, [contenteditable], [role="dialog"], [role="menu"], [role="listbox"], [role="combobox"]')) return;
    if (loopDrag.current) { loopDrag.current = null; setLoopPreview(null); }
    if (project?.loop && project.loop.end > project.loop.start) {
      event.preventDefault();
      commitLoop({ start: 0, end: 0, enabled: false });
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => clearLoopShortcut(event);
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, []);
  const rulerTime = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(playbackDuration, timeView.start + Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * timeView.span));
  };
  const beginLoopSelection = (event: React.PointerEvent<HTMLCanvasElement>, time: number) => {
    if (loopPending.current) return;
    loopDrag.current = { x: event.clientX, anchor: Math.max(0, Math.min(playbackDuration, time)), current: time, active: false };
  };
  const moveLoopSelection = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = loopDrag.current;
    if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if (!drag.active && Math.abs(event.clientX - drag.x) < 4) return;
    const current = rulerTime(event);
    loopDrag.current = { ...drag, current, active: true };
    setLoopPreview({ start: Math.min(drag.anchor, current), end: Math.max(drag.anchor, current), enabled: false });
  };
  const endLoopSelection = (event: React.PointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
    const drag = loopDrag.current;
    loopDrag.current = null;
    if (!drag || cancelled) { setLoopPreview(null); return; }
    if (!drag.active) { setLoopPreview(null); playFromRuler?.(rulerTime(event)); return; }
    const current = rulerTime(event);
    const loop = { start: Math.min(drag.anchor, current), end: Math.max(drag.anchor, current), enabled: false };
    if (loop.end - loop.start < 50) { setLoopPreview(null); setNotice('循环选区至少需要 0.05 秒'); return; }
    commitLoop(loop, true);
  };
  const timelineCanvas = { view: timeView, duration: playbackDuration, position: startPosition, progress: state?.playing ? playhead : undefined, theme };
  const resizeAiPanel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !mainLayout.current) return;
    const bounds = mainLayout.current.getBoundingClientRect();
    setAiWidth(Math.max(0, Math.min(bounds.width - 6, bounds.right - event.clientX - 3)));
  };
  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const handle = event.currentTarget.getBoundingClientRect();
    splitGrab.current = event.clientY - (handle.top + handle.height / 2);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const resizeSplit = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const box = workspace.current!.getBoundingClientRect();
    const handleHeight = event.currentTarget.getBoundingClientRect().height;
    setSplit(Math.min(100, Math.max(0, (event.clientY - box.top - splitGrab.current - handleHeight / 2) / (box.height - handleHeight) * 100)));
  };
  const beginTrackResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const handle = event.currentTarget;
    resizeHistory.current = layoutSnapshot();
    trackGrab.current = handle.closest('.track-row')!.getBoundingClientRect().bottom - event.clientY;
    handle.setPointerCapture(event.pointerId);
  };
  const resizeTrack = (id: string, event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const top = event.currentTarget.closest('.track-row')!.getBoundingClientRect().top;
    const height = Math.max(0, Math.round(event.clientY - top + trackGrab.current));
    if (layout.current.heights[id] !== height) {
      layout.current = { ...layout.current, heights: { ...layout.current.heights, [id]: height } };
      setTrackHeights(layout.current.heights);
    }
  };
  const clampTrackWidth = (value: number) => Math.max(160, Math.min(Math.max(160, (timeline.current?.clientWidth ?? window.innerWidth) - 120), value));
  const beginWidthResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    resizeHistory.current = layoutSnapshot();
    widthGrab.current = event.clientX - event.currentTarget.getBoundingClientRect().left - event.currentTarget.offsetWidth / 2;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const resizeWidth = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const width = clampTrackWidth(event.clientX - timeline.current!.getBoundingClientRect().left - widthGrab.current);
    layout.current = { ...layout.current, width };
    setTrackWidth(width);
  };
  const finishPanelResize = () => {
    const before = resizeHistory.current;
    resizeHistory.current = null;
    if (before && (before.width !== layout.current.width || JSON.stringify(before.heights) !== JSON.stringify(layout.current.heights))) recordTrackChange(before);
  };
  const beginClipDrag = (trackId: string, event: React.PointerEvent<HTMLCanvasElement>, clip: Clip, time: number) => {
    setSelectedClips(previous => {
      if (!event.ctrlKey && !event.metaKey) return [{ trackId, id: clip.id }];
      return previous.some(item => item.trackId === trackId && item.id === clip.id)
        ? previous.filter(item => item.trackId !== trackId || item.id !== clip.id)
        : [...previous, { trackId, id: clip.id }];
    });
    if (locked || graphDirty || clipMoving.current) return;
    clipDrag.current = { from: trackId, clip, pointerX: event.clientX, pointerY: event.clientY, anchor: time - clip.start, active: false, start: clip.start, target: trackId };
  };
  const moveClipDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = clipDrag.current;
    if (!drag) return;
    if (!drag.active && Math.hypot(event.clientX - drag.pointerX, event.clientY - drag.pointerY) < 4) return;
    if (!drag.active) setClipDragging(true);
    const lane = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.track-lane');
    const target = lane?.closest<HTMLElement>('[data-track-id]')?.dataset.trackId ?? (lane?.closest('.track-bed') ? NEW_TRACK : undefined);
    const track = current.current?.tracks.find(item => item.id === target);
    if (!lane || !target || (!track && target !== NEW_TRACK)) { clipDrag.current = { ...drag, active: true, target: undefined }; setClipPreview(null); return; }
    const rect = lane.getBoundingClientRect();
    const wanted = Math.max(0, Math.min(86400000, timeView.start + (event.clientX - rect.left) / rect.width * timeView.span - drag.anchor));
    const occupied = track?.clips.filter(clip => target !== drag.from || clip.id !== drag.clip.id) ?? [];
    const next = { ...drag, active: true, target, start: nearestClipStart(occupied, wanted, drag.clip.duration) };
    clipDrag.current = next; setClipPreview(next);
  };
  const endClipDrag = (event: React.PointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
    const drag = clipDrag.current;
    clipDrag.current = null;
    setClipDragging(false);
    if (!drag || cancelled) { setClipPreview(null); return; }
    if (!drag.active) {
      const box = event.currentTarget.getBoundingClientRect();
      if (box.width) seek?.(timeView.start + Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * timeView.span);
      setClipPreview(null); return;
    }
    if (!drag.target || (drag.target === drag.from && Math.abs(drag.start - drag.clip.start) < .001)) { setClipPreview(null); return; }
    const destination = drag.target;
    clipMoving.current = true;
    void perform('移动音频片段…', async () => {
      const before = trackSnapshot();
      const value = await engine<Project>({ command: 'move_clip', fromTrack: drag.from, ...(destination === NEW_TRACK ? {} : { toTrack: destination }), clipId: drag.clip.id, start: drag.start });
      const selectedDestination = destination === NEW_TRACK ? value.tracks[value.tracks.length - 1].id : destination;
      recordTrackChange(before); updateProject(value); setClipPreview(null); setSelectedClips(previous => previous.map(item => item.trackId === drag.from && item.id === drag.clip.id ? { trackId: selectedDestination, id: drag.clip.id } : item)); selectChannel(selectedDestination);
      await engine({ command: 'set_spectrum', source: selectedDestination });
      acceptState(await engine<EngineState>({ command: 'state' }));
    }, false).finally(() => { clipMoving.current = false; setClipPreview(null); });
  };
  const visibleClips = (track: Track) => {
    if (!clipPreview?.target) return track.clips;
    const clips = track.clips.filter(clip => track.id !== clipPreview.from || clip.id !== clipPreview.clip.id);
    return track.id === clipPreview.target ? [...clips, { ...clipPreview.clip, start: clipPreview.start }] : clips;
  };
  return <main className="workbench" data-background={!uiActive || undefined} style={{ '--track-header-width': `${trackWidth}px` } as React.CSSProperties}>
    {isTauri() && !maximized && (['North', 'South', 'East', 'West', 'NorthEast', 'NorthWest', 'SouthEast', 'SouthWest'] as const).map(direction => <div key={direction} className={`window-resize window-resize-${direction}`} aria-hidden="true" onMouseDown={event => { if (event.button === 0) void getCurrentWindow().startResizeDragging(direction); }} />)}
    <header className="app-header" onMouseDown={event => { if (isTauri() && event.button === 0 && event.target instanceof Element && event.currentTarget.contains(event.target) && !event.target.closest('button, .notification-anchor')) { if (event.detail === 2) void getCurrentWindow().toggleMaximize(); else void getCurrentWindow().startDragging(); } }}>
      <nav className="header-actions" aria-label="工作台菜单">
        <Dropdown isOpen={menu === 'file'} onOpenChange={onMenuChange('file')}><DropdownTrigger className="menu-trigger text-caption-1-semibold">文件</DropdownTrigger><DropdownPopover className="orvo-menu-popup orvo-header-menu" aria-label="文件操作">
          <DropdownItem disabled={locked || graphDirty} onSelect={() => { setMenu(null); open(); }}>打开工程…</DropdownItem>
          <DropdownItem disabled={locked || !project || graphDirty} onSelect={() => { setMenu(null); save(); }}>保存工程…</DropdownItem>
          <DropdownDivider />
          <DropdownItem disabled={locked || graphDirty || !hasMaterial} onSelect={() => exportAudio()}>导出完整混音…</DropdownItem>
          <DropdownItem disabled={locked || graphDirty || !selectedTrack?.source} onSelect={() => exportAudio(selectedTrack)}>导出所选音轨…</DropdownItem>
          <DropdownItem disabled={locked || graphDirty || !selectedTrack?.source} onSelect={saveTrackResult}>保存音轨结果包…</DropdownItem>
          <DropdownDivider />
          <DropdownItem disabled={!channel || graphDirty || locked} onSelect={importPlan}>导入 FX 方案…</DropdownItem>
          <DropdownItem disabled={!channel || graphDirty || locked} onSelect={exportPlan}>导出 FX 方案…</DropdownItem>
        </DropdownPopover></Dropdown>
        <Dropdown isOpen={menu === 'track'} onOpenChange={onMenuChange('track')}><DropdownTrigger className="menu-trigger text-caption-1-semibold" isDisabled={locked || graphDirty}>轨道</DropdownTrigger><DropdownPopover className="orvo-menu-popup orvo-header-menu" aria-label="轨道操作">
          <DropdownItem onSelect={addTrack}>新建空轨</DropdownItem>
          <DropdownItem onSelect={() => importAudio()}>导入音频为新轨…</DropdownItem>
          <DropdownItem disabled={!selectedTrack} onSelect={() => importAudio(selectedTrack?.id)}>{selectedTrack?.source ? '向所选轨道添加音频…' : '为所选空轨添加音频…'}</DropdownItem>
        </DropdownPopover></Dropdown>
        <Dropdown isOpen={menu === 'view'} onOpenChange={onMenuChange('view')}><DropdownTrigger className="menu-trigger text-caption-1-semibold">视图</DropdownTrigger><DropdownPopover className="orvo-menu-popup orvo-header-menu" aria-label="视图">
          <DropdownItem selected={showMaster} onSelect={() => { setShowMaster(previous => !previous); setMenu(null); }}>{showMaster ? '✓ ' : '　'}显示 Master 轨道</DropdownItem>
        </DropdownPopover></Dropdown>
        <Dropdown isOpen={menu === 'settings'} onOpenChange={onMenuChange('settings')}><DropdownTrigger className="menu-trigger text-caption-1-semibold">设置</DropdownTrigger><DropdownPopover className="orvo-menu-popup orvo-header-menu" aria-label="工作台设置">
          <DropdownItem disabled={!settings} onSelect={() => openSettings('audio-settings')}>输出设备…</DropdownItem>
          <DropdownItem onSelect={() => { setMenu(null); setTheme(previous => !previous); }}>{theme ? '切换浅色' : '切换深色'}</DropdownItem>
          <DropdownItem disabled={!connected} onSelect={() => { setMenu(null); void showLogs(); }}>运行日志</DropdownItem>
        </DropdownPopover></Dropdown>
        <div className="notification-anchor">
        <Dropdown isOpen={menu === 'notifications'} onOpenChange={open => { onMenuChange('notifications')(open); if (open) { setUnreadNotifications(0); setToastItems([]); setToastExpanded(false); } }}><DropdownTrigger className="menu-trigger text-caption-1-semibold" aria-label={unreadNotifications ? `通知，${unreadNotifications} 条未读` : '通知'}>通知{unreadNotifications > 0 && <span className="notification-dot" aria-hidden="true" />}</DropdownTrigger><DropdownPopover className="orvo-menu-popup orvo-header-menu notifications-popup" aria-label="通知">
          {notifications.length ? <div className="notification-list" role="list">{notifications.map(item => <div className="notification-item" role="listitem" key={item.id}>
            <div className="notification-meta text-caption-1-regular"><span className={item.error ? 'text-text-error-primary' : undefined}>{item.error ? '错误' : '提示'}</span><time>{item.time}</time><button type="button" className="notification-delete" aria-label="删除通知" onClick={() => { setNotifications(items => items.filter(entry => entry.id !== item.id)); setToastItems(items => items.filter(entry => entry.id !== item.id)); }}><RiCloseLine size={16} /></button></div>
            <div className="text-body-regular">{item.text}</div>
          </div>)}</div> : <div className="notification-empty text-body-regular">暂无通知</div>}
        </DropdownPopover></Dropdown>
        {toastItems.length > 0 && menu !== 'notifications' && <div className="tst toast-stack" role="region" aria-label="新通知" data-open={toastExpanded || undefined}
          onPointerEnter={() => setToastExpanded(true)} onPointerLeave={() => setToastExpanded(false)}
          onFocus={() => setToastExpanded(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setToastExpanded(false); }}>
          {toastItems.map((item, index) => <div key={item.id} className="tst-toast" data-front={index === 0 || undefined} data-kind={item.error ? 'error' : 'info'}
            style={{ '--toast-index': index, zIndex: 3 - index } as React.CSSProperties} aria-hidden={!toastExpanded && index > 0 || undefined}>
            <span className="tst-icon">{item.error ? <RiErrorWarningLine size={18} /> : <RiInformationLine size={18} />}</span>
            <span className="tst-text"><b>{item.error ? '错误' : '提示'}</b><span>{item.text}</span></span>
            <button type="button" className="tst-x" aria-label="关闭通知" tabIndex={toastExpanded || index === 0 ? 0 : -1} onClick={() => setToastItems(items => items.filter(toast => toast.id !== item.id))}><RiCloseLine size={16} /></button>
          </div>)}
        </div>}
        </div>
      </nav>
      <span className="project-name text-caption-1-regular" title={projectName}>{project ? projectName : '未连接工程'}{project && !saved ? ' · 未保存' : ''}</span>
      {isTauri() && <div className="window-actions">
        <Button size="small" variant="ghost" iconOnly leadingIcon={RiSubtractLine} aria-label="最小化" onClick={() => void getCurrentWindow().minimize()} />
        <Button size="small" variant="ghost" iconOnly leadingIcon={maximized ? RiCheckboxMultipleBlankLine : RiSquareLine} aria-label={maximized ? '还原窗口' : '最大化'} onClick={() => void getCurrentWindow().toggleMaximize()} />
        <Button size="small" variant="ghost" className="window-close" iconOnly leadingIcon={RiCloseLine} aria-label="关闭窗口" onClick={() => void getCurrentWindow().close()} />
      </div>}
    </header>
    <div className="main-layout" ref={mainLayout} style={{ '--ai-width': `${aiWidth}px` } as React.CSSProperties}>
    <div className="workspace" ref={workspace} style={{ gridTemplateRows: `minmax(0, ${split}fr) 8px minmax(0, ${100 - split}fr)` }}>
      <section className="fx-panel" aria-label="FX 路由" inert={split === 0} onPointerDownCapture={() => { shortcutRegion.current = 'graph'; }}>
        {channel ? <GraphEditor key={`${graphEpoch}:${selected}`} graph={channel.graph} draft={draft?.graph} history={graphHistory} historyKey={selected} onDraftChange={onDraftChange} spectrum={state?.spectrum} sampleRate={project?.sampleRate ?? 44100} catalog={catalog} locked={locked} channelName={selectedTrack?.label ?? 'Master'} transport={{ playing: !!state?.playing && (state.playbackSource ?? 'master') === selected, position: (state?.playbackSource ?? 'master') === selected && showProgress ? playhead : startPosition, duration: playbackDuration, disabled: locked || (selected === 'master' ? !hasMaterial : !selectedTrack?.source), toggle: () => toggleTransport(selected), stop: () => stopTransport(selected) }} apply={applyGraph} clipboard={clipboard} /> : <div className="empty-state text-body-regular">连接音频引擎后可编辑 FX 路由</div>}
      </section>
      <div className="splitter" role="separator" aria-label="调整 FX 与音轨区域比例" aria-orientation="horizontal" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(split)} tabIndex={0}
        onPointerDown={beginResize} onPointerMove={resizeSplit}
        onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setSplit(previous => Math.min(100, Math.max(0, previous + (event.key === 'ArrowDown' ? 2 : -2)))); } }}><i /></div>
      <section className="timeline-panel" aria-label="轨道时间线" tabIndex={-1} inert={split === 100} onPointerDownCapture={event => {
        shortcutRegion.current = 'tracks';
        const track = (event.target as Element).closest<HTMLElement>('[data-track-id]');
        if (track?.dataset.trackId) chooseChannel(track.dataset.trackId);
      }}>
        <div className="arrangement">
          <div className="timeline-tracks">
            <div className="timeline-playheads" aria-hidden="true">
              {startPosition >= timeView.start && startPosition <= timeView.start + timeView.span && <i className="timeline-playhead" data-at-start={startPosition === timeView.start || undefined} style={{ left: `${(startPosition - timeView.start) / timeView.span * 100}%` }} />}
              {state?.playing && playhead >= timeView.start && playhead <= timeView.start + timeView.span && <i className="timeline-playhead timeline-playhead-progress" data-at-start={playhead === timeView.start || undefined} style={{ left: `${(playhead - timeView.start) / timeView.span * 100}%` }} />}
            </div>
            {loopSelection && loopSelection.end > loopSelection.start && <div className="loop-selection" data-enabled={loopSelection.enabled} aria-hidden="true">
              <i style={{ left: `${(loopSelection.start - timeView.start) / timeView.span * 100}%`, width: `${(loopSelection.end - loopSelection.start) / timeView.span * 100}%` }} />
            </div>}
            {clipDragging && clipPreview?.target && <div className="clip-guides" aria-hidden="true">
              {[clipPreview.start, clipPreview.start + clipPreview.clip.duration].map((position, index) => <i key={index} style={{ left: `${(position - timeView.start) / timeView.span * 100}%` }} />)}
            </div>}
            <div className="track-scroll" ref={timeline} onScroll={updateVerticalScroll}>
              <div className="ruler-row"><div className="track-heading"><div className="track-width-resize" role="separator" aria-label="调整轨道控制面板宽度" aria-orientation="vertical" tabIndex={0}
                onPointerDown={beginWidthResize} onPointerMove={resizeWidth} onPointerUp={finishPanelResize} onPointerCancel={finishPanelResize} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const width = clampTrackWidth(layout.current.width + (event.key === 'ArrowRight' ? 8 : -8)); if (width !== layout.current.width) { recordTrackChange(layoutSnapshot()); layout.current = { ...layout.current, width }; setTrackWidth(width); } } }} /></div><Waveform {...timelineCanvas} ruler seek={playFromRuler} rulerDown={beginLoopSelection} rulerMove={moveLoopSelection} rulerUp={endLoopSelection} /></div>
              {project && [...(showMaster ? [null] : []), ...project.tracks].map((track, index) => !track ? <div className="track-row master-track" key="master" style={{ minHeight: trackHeights.master }} data-tone={index % 2} data-selected={selected === 'master'}>
                <div className="track-controls" onClick={() => chooseChannel('master')}>
                  <Button size="xs" variant="ghost" className="track-name master-name" aria-pressed={selected === 'master'} disabled={locked} onClick={() => chooseChannel('master')}>Master</Button>
                  <ChannelStrip channel={project.master} levels={state?.master} disabled={locked} dirty={!!drafts.master && audioGraphKey(drafts.master.graph) !== audioGraphKey(project.master.graph)} patch={patch => patchChannel('master', patch)} />
                  <div className="track-resize" role="separator" aria-orientation="horizontal" aria-label="调整 Master 的高度"
                    onPointerDown={beginTrackResize} onPointerMove={event => resizeTrack('master', event)} onPointerUp={finishPanelResize} onPointerCancel={finishPanelResize} />
                  <div className="track-width-resize" role="separator" aria-orientation="vertical" aria-label="调整轨道控制面板宽度"
                    onPointerDown={beginWidthResize} onPointerMove={resizeWidth} onPointerUp={finishPanelResize} onPointerCancel={finishPanelResize} />
                </div>
                <div className="track-lane" onClick={() => chooseChannel('master')}><Waveform {...timelineCanvas} seek={seek} /></div>
              </div> : <div className="track-row" key={track.id} style={{ minHeight: trackHeights[track.id] }} data-track-id={track.id} data-order-before={trackOrderMarker?.id === track.id && !trackOrderMarker.after || undefined} data-order-after={trackOrderMarker?.id === track.id && trackOrderMarker.after || undefined} data-tone={index % 2} data-selected={selected === track.id} data-empty={!track.source} data-drop-target={dropTarget === track.id}>
                <ContextMenuTrigger isDisabled={locked} onOpenChange={open => { if (open) chooseChannel(track.id); }}><div className="track-controls" onPointerDown={event => beginTrackOrder(event, track.id)} onPointerMove={moveTrackOrder} onPointerUp={event => finishTrackOrder(event)} onPointerCancel={event => finishTrackOrder(event, true)} onClick={event => {
                  if (event.target instanceof Element && !event.target.closest('button, input, .mixer-rail, .track-resize')) chooseChannel(track.id);
                }}>
                  {renamingTrack === track.id ? <div className="track-name track-name-editor">
                    <span className="track-index text-caption-1-regular">{String(index + (showMaster ? 0 : 1)).padStart(2, '0')}</span>
                    <input className="track-name-input text-caption-1-semibold" aria-label="轨道名称" defaultValue={track.label} autoFocus
                      onFocus={event => event.currentTarget.select()}
                      onBlur={event => finishRename(track, event.currentTarget.value)}
                      onKeyDown={event => {
                        if (event.nativeEvent.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return;
                        event.preventDefault();
                        if (event.key === 'Escape') event.currentTarget.value = track.label;
                        event.currentTarget.blur();
                      }} />
                  </div> : <Button size="xs" variant="ghost" className="track-name" title={track.label} aria-pressed={selected === track.id} disabled={locked}
                    onClick={() => chooseChannel(track.id)} onDoubleClick={() => setRenamingTrack(track.id)}>
                    <span className="track-index text-caption-1-regular">{String(index + (showMaster ? 0 : 1)).padStart(2, '0')}</span><span className="track-label">{track.label}</span>
                  </Button>}
                  <ChannelStrip channel={track} track={track} levels={state?.levels[track.id]} disabled={locked} dirty={!!drafts[track.id] && audioGraphKey(drafts[track.id].graph) !== audioGraphKey(track.graph)} patch={patch => patchChannel(track.id, patch)} />
                  <div className="track-resize" role="separator" aria-orientation="horizontal" aria-label={`调整 ${track.label} 的高度`}
                    onPointerDown={beginTrackResize} onPointerMove={event => resizeTrack(track.id, event)} onPointerUp={finishPanelResize} onPointerCancel={finishPanelResize} />
                  <div className="track-width-resize" role="separator" aria-orientation="vertical" aria-label="调整轨道控制面板宽度"
                    onPointerDown={beginWidthResize} onPointerMove={resizeWidth} onPointerUp={finishPanelResize} onPointerCancel={finishPanelResize} />
                </div><ContextMenu aria-label="音轨操作" className="orvo-menu-popup">
                  <ContextMenuItem id="copy-track" shortcut="Ctrl+C" onAction={() => { trackClipboard.current = { track: structuredClone(track), draft: structuredClone(draftById.current[track.id]) }; }}>复制</ContextMenuItem>
                  <ContextMenuItem id="paste-track" shortcut="Ctrl+V" onAction={pasteTrack}>粘贴</ContextMenuItem>
                  <ContextMenuItem id="undo-track" shortcut="Ctrl+Z" isDisabled={!trackHistory.current.past.length} onAction={() => restoreTrackHistory(false)}>撤销</ContextMenuItem>
                  <ContextMenuItem id="redo-track" shortcut="Ctrl+Shift+Z" isDisabled={!trackHistory.current.future.length} onAction={() => restoreTrackHistory(true)}>重做</ContextMenuItem>
                  <ContextMenuItem id="duplicate" onAction={() => editTrack(track.id, true)}>复制音轨</ContextMenuItem>
                  <ContextMenuItem id="clear" variant="danger" isDisabled={!track.source} onAction={() => clearTrackContent(track.id)}>清除音轨内容</ContextMenuItem>
                  <ContextMenuItem id="remove" variant="danger" onAction={() => editTrack(track.id, false)}>删除音轨</ContextMenuItem>
                </ContextMenu></ContextMenuTrigger>
                <ContextMenuTrigger isDisabled={locked} onOpenChange={open => { if (open) chooseChannel(track.id); }}><div className="track-lane" onPointerDown={() => { if (!track.source) setSelectedClips([]); }} onContextMenu={event => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  const time = timeView.start + (event.clientX - rect.left) / rect.width * timeView.span;
                  setContextClip(track.clips.find(clip => time >= clip.start && time < clip.start + clip.duration)?.id ?? null);
                }} onDoubleClick={() => { if (!track.source && !locked && !graphDirty) importAudio(track.id); }}>
                  <Waveform {...timelineCanvas} track={track} clips={visibleClips(track)} selected={selected === track.id} selectedClips={selectedClips} previewClipId={clipPreview?.target === track.id ? clipPreview.clip.id : undefined} clearClip={() => setSelectedClips([])} seek={track.source ? seek : undefined}
                    clipDown={(event, clip, time) => beginClipDrag(track.id, event, clip, time)} clipMove={moveClipDrag} clipUp={endClipDrag} />
                  {clipRename?.trackId === track.id && (() => {
                    const clip = track.clips.find(item => item.id === clipRename.clipId);
                    if (!clip) return null;
                    const left = Math.max(0, (clip.start - timeView.start) / timeView.span * 100);
                    const right = Math.min(100, (clip.start + clip.duration - timeView.start) / timeView.span * 100);
                    if (right <= left) return null;
                    return <input className="clip-name-editor" aria-label="片段名称" autoFocus value={clipRename.name} style={{ left: `${left}%`, width: `${right - left}%` }} onFocus={event => event.currentTarget.select()} onPointerDown={event => event.stopPropagation()} onChange={event => setClipRename(previous => previous ? { ...previous, name: event.target.value } : null)} onBlur={renameClip} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } else if (event.key === 'Escape') { event.preventDefault(); setClipRename(null); } }} />;
                  })()}
                </div><ContextMenu aria-label="音轨内容操作" className="orvo-menu-popup">
                  <ContextMenuItem id="copy-track-content" shortcut="Ctrl+C" onAction={() => { trackClipboard.current = { track: structuredClone(track), draft: structuredClone(draftById.current[track.id]) }; }}>复制音轨</ContextMenuItem>
                  <ContextMenuItem id="paste-track-content" shortcut="Ctrl+V" onAction={pasteTrack}>粘贴音轨</ContextMenuItem>
                  <ContextMenuItem id="undo-content" shortcut="Ctrl+Z" isDisabled={!trackHistory.current.past.length} onAction={() => restoreTrackHistory(false)}>撤销</ContextMenuItem>
                  <ContextMenuItem id="redo-content" shortcut="Ctrl+Shift+Z" isDisabled={!trackHistory.current.future.length} onAction={() => restoreTrackHistory(true)}>重做</ContextMenuItem>
                  <ContextMenuItem id="rename-clip" isDisabled={!contextClip} onAction={() => { const clip = track.clips.find(item => item.id === contextClip); if (clip) setClipRename({ trackId: track.id, clipId: clip.id, name: clip.name ?? clip.source.split(/[\\/]/).pop() ?? '' }); }}>重命名音频片段</ContextMenuItem>
                  <ContextMenuItem id="remove-clip" variant="danger" isDisabled={!contextClip} onAction={() => { if (contextClip) removeClip(track.id, contextClip); }}>删除音频片段</ContextMenuItem>
                </ContextMenu></ContextMenuTrigger>
              </div>)}
              <div className="track-bed" onPointerDown={() => setSelectedClips([])} data-clip-preview={clipPreview?.target === NEW_TRACK} data-drop-target={dropTarget === null || clipPreview?.target === NEW_TRACK}>
                <div className="track-bed-gutter"><Button size="xs" variant="secondary" className="rounded-full" iconOnly leadingIcon={RiAddLine} aria-label="新建轨道" disabled={locked || graphDirty} onClick={addTrack} /></div>
                <div className="track-lane">
                  <Waveform {...timelineCanvas} />
                  {clipPreview?.target === NEW_TRACK && <div className="track-bed-preview"><Waveform {...timelineCanvas} clips={[{ ...clipPreview.clip, start: clipPreview.start }]} /></div>}
                </div>
              </div>
            </div>
            <div className="vertical-scrollbar" role="scrollbar" aria-label="纵向滚动音轨" aria-orientation="vertical" aria-valuemin={0} aria-valuemax={verticalLimit} aria-valuenow={Math.round(verticalScroll.top)} aria-disabled={verticalLimit === 0} tabIndex={0}
              onPointerDown={event => { if (event.button !== 0 || !verticalLimit) return; const thumb = event.currentTarget.firstElementChild as HTMLElement; verticalGrab.current = event.target === thumb ? event.clientY - thumb.getBoundingClientRect().top : thumb.offsetHeight / 2; event.currentTarget.setPointerCapture(event.pointerId); moveVerticalScrollbar(event); }}
              onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) moveVerticalScrollbar(event); }}
              onKeyDown={event => { if (!timeline.current) return; const next = event.key === 'ArrowUp' ? verticalScroll.top - 40 : event.key === 'ArrowDown' ? verticalScroll.top + 40 : event.key === 'Home' ? 0 : event.key === 'End' ? verticalLimit : null; if (next !== null) { event.preventDefault(); timeline.current.scrollTop = next; } }}>
              <div className="vertical-scrollbar-thumb" style={{ height: `min(100%, max(16px, ${verticalThumb * 100}%))`, top: `calc((100% - min(100%, max(16px, ${verticalThumb * 100}%))) * ${verticalLimit ? verticalScroll.top / verticalLimit : 0})` }} />
            </div>
            <div className="timeline-scrollbar-row"><span className="timeline-track-count">音轨数 {project?.tracks.length ?? 0}</span><div className="timeline-scrollbar" role="scrollbar" aria-label="横向滚动时间线" aria-orientation="horizontal"
              aria-valuemin={0} aria-valuemax={Math.round(scrollLimit)} aria-valuenow={Math.round(timeView.start)} aria-disabled={scrollLimit === 0} tabIndex={0}
              onPointerDown={beginTimelineScrollbar} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) moveTimelineScrollbar(event); }}
              onKeyDown={event => {
                const offset = event.key === 'ArrowLeft' ? -timeView.span * .05 : event.key === 'ArrowRight' ? timeView.span * .05 : event.key === 'Home' ? -timeView.start : event.key === 'End' ? scrollLimit - timeView.start : null;
                if (offset !== null) { event.preventDefault(); setTimeView(view => panTimeline(view, offset, contentDuration)); }
              }}>
              <div className="timeline-scrollbar-thumb" aria-hidden="true" style={{ width: `min(100%, max(16px, ${thumbWidth}%))`, left: `calc((100% - min(100%, max(16px, ${thumbWidth}%))) * ${thumbRatio})` }} />
            </div></div>
          </div>
        </div>
      </section>
    </div>
    <div className="ai-splitter" role="separator" aria-label="调整 AI 面板宽度" aria-orientation="vertical" aria-valuemin={0} aria-valuemax={Math.max(0, (mainLayout.current?.clientWidth ?? 760) - 6)} aria-valuenow={aiWidth} tabIndex={0}
      onPointerDown={event => { if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={resizeAiPanel}
      onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setAiWidth(value => Math.max(0, Math.min((mainLayout.current?.clientWidth ?? 760) - 6, value + (event.key === 'ArrowLeft' ? 16 : -16)))); } }}><i /></div>
    <aside className="ai-dock" ref={aiSidebar} aria-label="AI 混音" inert={aiWidth === 0}><div className="ai-dock-content">
      <div className="ai-header"><div className="ai-heading"><Watcher size={48} shape="Pill" follow={35} bounce={15} within=".workbench" /><h2 className="text-headline-medium">AI 混音</h2></div><div className="ai-header-actions">
        <Dropdown isOpen={menu === 'ai-tools'} onOpenChange={onMenuChange('ai-tools')}><DropdownTrigger className="ai-tools-trigger text-caption-1-semibold" isDisabled={locked}>设置</DropdownTrigger><DropdownPopover className="orvo-menu-popup orvo-header-menu" aria-label="AI 功能">
          <DropdownItem disabled={!catalog} onSelect={() => { setMenu(null); setPanel('effects'); }}>效果器</DropdownItem>
          <DropdownItem disabled={!selectedTrack?.source} onSelect={analyze}>分析整段音频</DropdownItem>
          <DropdownDivider />
          <DropdownItem disabled={!settings} onSelect={() => openSettings('api-settings')}>API 配置…</DropdownItem>
        </DropdownPopover></Dropdown><Button size="small" variant="ghost" onClick={showLogs}>运行日志</Button></div></div>
        <div className="ai-settings"><div className="ai-field"><span className="text-caption-1-semibold text-text-secondary">处理范围</span>
          <div className="ai-scope" role="group" aria-label="处理范围">
            <Button variant="secondary" aria-pressed={aiScope === 'selected'} disabled={!!busy || (selected === 'master' ? !hasMaterial : !selectedTrack?.source)} onClick={() => setAiScope('selected')}>所选音轨{selected === 'master' ? ' · Master' : ''}</Button>
            <Button variant="secondary" aria-pressed={aiScope === 'all'} disabled={!!busy || !hasMaterial} onClick={() => setAiScope('all')}>全部音轨 · {materialTracks.length}</Button>
          </div></div>
        <div className="round-control"><span className="text-caption-1-semibold text-text-secondary">反馈轮数</span><RollingCounter value={rounds} onChange={setRounds} disabled={!!busy} /></div></div>
        <div className="ai-request"><div className="ai-field"><span className="text-caption-1-semibold text-text-secondary">声音目标预设</span><Select aria-label="声音目标预设" popoverClassName="orvo-menu-popup orvo-header-menu" placeholder="声音目标预设" selectedKey={catalog?.presets.find(preset => preset.instruction === instruction)?.label ?? null} onSelectionChange={value => { const preset = catalog?.presets.find(item => item.label === value); if (preset) editInstruction(preset.instruction); }} isDisabled={!!busy || !catalog}>
          {(catalog?.presets ?? []).map(preset => <SelectItem key={preset.label} id={preset.label}>{preset.label}</SelectItem>)}
        </Select></div>
        <ComposerLoader className="ai-composer-loader" active={aiRunning || optimizing} surface={false} radius={16}><div className="ai-composer">
          <Textarea className="ai-prompt" fieldClassName="ai-prompt-field" aria-label="描述想要的混音效果" placeholder="描述想要的混音效果" rows={5} resize="none" value={instruction} onChange={editInstruction} isDisabled={!!busy} />
          <div className="ai-composer-tools">
            <div className="reference-picker" data-drop-target={referenceDrop}>
              <Button size="small" variant="ghost" leadingIcon={RiFolderOpenLine} disabled={!!busy} onClick={() => void perform('选择参考音频…', async () => { const path = await native<string | null>('pick_reference'); if (path) setReference(path); })}>参考音频</Button>
              {reference && <><span className="text-caption-1-regular text-text-secondary" title={reference}>{reference.split(/[\\/]/).pop()}</span><Button size="xs" variant="ghost" iconOnly leadingIcon={RiCloseLine} aria-label="移除参考音频" disabled={!!busy} onClick={() => setReference(null)} /></>}
            </div>
            <div className="ai-composer-actions"><Button size="small" variant="ghost" className={optimizing ? 'ai-action-busy' : undefined} leadingIcon={optimizing ? RiLoader4Line : RiSparklingLine} aria-busy={optimizing} disabled={!!busy || !aiTargetCount || !instruction.trim() || !availableEffects.length} onClick={optimize}>{optimizing ? '优化中…' : '优化'}</Button>{previousInstruction !== null && <Button size="small" variant="ghost" disabled={!!busy} onClick={() => editInstruction(previousInstruction)}>撤销</Button>}
              <Button size="small" variant="secondary" className={aiRunning || optimizing ? 'ai-send ai-cancel' : 'ai-send'} iconOnly leadingIcon={aiRunning || optimizing ? RiStopFill : RiArrowUpLine} aria-label={cancelling ? '正在取消' : aiRunning || optimizing ? confirmCancel ? '再次点击确认取消' : '取消处理' : '运行'} aria-pressed={confirmCancel} aria-busy={aiRunning || optimizing} disabled={aiRunning || optimizing ? cancelling : locked || !aiTargetCount || !instruction.trim() || !availableEffects.length || graphDirty} onClick={() => { if (aiRunning || optimizing) { if (confirmCancel) void cancel(); else setConfirmCancel(true); } else generate(); }} />
            </div>
          </div>
        </div></ComposerLoader></div>
    </div></aside>
    </div>
    <footer className="transport" aria-label="播放控制">
      <Button size="small" variant={state?.playing && (state.playbackSource ?? 'master') === 'master' ? "danger" : "secondary"} className="transport-play rounded-full" iconOnly leadingIcon={state?.playing && (state.playbackSource ?? 'master') === 'master' ? RiPauseFill : RiPlayFill} aria-label={state?.playing && (state.playbackSource ?? 'master') === 'master' ? '暂停' : '播放'} aria-pressed={!!state?.playing && (state.playbackSource ?? 'master') === 'master'} disabled={locked || !hasMaterial} onClick={togglePlayback} />
      <Button size="small" variant="secondary" className="rounded-full" iconOnly leadingIcon={RiStopFill} aria-label="停止并回到起点" disabled={locked || !hasMaterial} onClick={stopPlayback} />
      <Button size="small" variant={loopSelection?.enabled ? 'danger' : 'secondary'} className="transport-loop rounded-full" iconOnly leadingIcon={RiLoopRightLine} aria-label={loopSelection?.enabled ? '关闭循环' : '开启循环'} aria-pressed={!!loopSelection?.enabled} disabled={locked || loopUpdating || !loopSelection || loopSelection.end - loopSelection.start < 50} onClick={() => { if (loopSelection) commitLoop({ ...loopSelection, enabled: !loopSelection.enabled }); }} />
      <TransportTime state={state} showProgress={showProgress} startPosition={startPosition} active={uiActive} />
      <div className="transport-status text-caption-1-regular"><span role="status" className={error ? 'text-text-error-primary' : undefined}>{error || progressText || busy || notice || (connected ? '' : '音频引擎未连接')}</span>{!connected && error && <Button size="xs" variant="secondary" leadingIcon={RiRefreshLine} disabled={!!busy} onClick={() => void initialize()}>重新连接</Button>}<span>{project ? `${project.sampleRate.toLocaleString()} Hz` : '无活动工程'}</span></div>
    </footer>
    <ModalOverlay className="utility-backdrop" isOpen={!!panel} isDismissable={!busy || panel === 'logs'} isKeyboardDismissDisabled={!!busy && panel !== 'logs'} onOpenChange={open => { if (!open) setPanel(null); }}><Modal className="utility-panel" style={{ transform: `translate(${panelOffset.x}px, ${panelOffset.y}px)` }}><Dialog className="utility-dialog" aria-labelledby="utility-title">
      <header onPointerDown={event => {
        if (event.button !== 0 || (event.target as Element).closest('button')) return;
        const box = event.currentTarget.closest('.utility-panel')!.getBoundingClientRect();
        panelDrag.current = { x: event.clientX, y: event.clientY, offsetX: panelOffset.x, offsetY: panelOffset.y, left: box.left, top: box.top, width: box.width, height: box.height };
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={event => {
        const drag = panelDrag.current;
        if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const dx = Math.max(-drag.left, Math.min(window.innerWidth - drag.left - drag.width, event.clientX - drag.x));
        const dy = Math.max(-drag.top, Math.min(window.innerHeight - drag.top - drag.height, event.clientY - drag.y));
        setPanelOffset({ x: drag.offsetX + dx, y: drag.offsetY + dy });
      }} onPointerUp={() => { panelDrag.current = null; }} onPointerCancel={() => { panelDrag.current = null; }}><h2 className="text-title-3-semibold" id="utility-title">{panel === 'api-settings' ? 'API 配置' : panel === 'audio-settings' ? '输出设备' : panel === 'effects' ? '效果器' : panel === 'logs' ? '运行日志' : '音频分析'}</h2><Button size="small" variant="ghost" iconOnly leadingIcon={RiCloseLine} aria-label="关闭面板" disabled={!!busy && panel !== 'logs'} onClick={() => setPanel(null)} /></header>
      {error && <p className="text-body-regular text-text-error-primary" role="alert">{error}</p>}
      {busy && !(aiRunning || optimizing) && <p className="text-body-regular text-text-secondary" role="status">{progressText || busy}</p>}
      {panel === 'api-settings' ? <>
        <Input label="API 地址" placeholder="https://api.example.com/v1" value={baseUrl} onChange={setBaseUrl} isDisabled={!!busy} />
        <Input label="模型" value={model} onChange={setModel} isDisabled={!!busy} />
        <Input label="API Key" type="password" value={key} onChange={setKey} placeholder={settings?.hasKey ? '已保存密钥；留空保留' : '输入 API Key'} isDisabled={!!busy} />
        <Button disabled={!!busy || !baseUrl.trim() || !model.trim()} onClick={() => saveSettings(true)}>保存 API 配置</Button>
      </> : panel === 'audio-settings' ? <>
        <Select aria-label="音频输出设备" popoverClassName="orvo-menu-popup orvo-header-menu" selectedKey={deviceId} onSelectionChange={value => setDeviceId(String(value))} isDisabled={!!busy || (refreshingDevices && !devices.length)}>
          <SelectItem id="">系统默认输出</SelectItem>{devices.filter(device => device.id).map(device => <SelectItem key={device.id} id={device.id}>{device.label}{device.isDefault ? '（默认）' : ''}</SelectItem>)}
        </Select>
        <Button disabled={!!busy || (refreshingDevices && !devices.length)} onClick={() => saveSettings(false)}>保存输出设备</Button>
      </> : panel === 'effects' ? <>
        <div className="effect-toggle"><span className="text-body-medium">全选</span><LiquidToggle label="全选" on={!!effectOptions.length && availableEffects.length === effectOptions.length} disabled={!!busy} onChange={checked => setAvailableEffects(checked ? effectOptions.map(([id]) => id) : [])} /></div>
        <div className="effect-options">{effectOptions.map(([id, definition]) => <div key={id} className="effect-toggle"><span className="text-body-medium">{catalog?.labels[id] ?? definition.name}</span><LiquidToggle label={catalog?.labels[id] ?? definition.name} on={availableEffects.includes(id)} disabled={!!busy} onChange={checked => setAvailableEffects(previous => checked ? [...previous, id] : previous.filter(effect => effect !== id))} /></div>)}</div>
      </> : <pre className="analysis-output text-caption-1-regular">{analysis}</pre>}
    </Dialog></Modal></ModalOverlay>
    <ModalOverlay className="utility-backdrop" isOpen={closePrompt} isDismissable onOpenChange={open => setClosePrompt(open)}><Modal className="utility-panel close-confirm"><Dialog className="utility-dialog" aria-label="关闭工程"><h2 className="text-body-medium">工程尚未保存</h2><div className="flex items-center gap-2"><Button size="small" variant="secondary" onClick={saveAndClose}>保存</Button><Button size="small" variant="secondary" onClick={closeWithoutSaving}>不保存</Button><Button size="small" variant="secondary" onClick={() => setClosePrompt(false)}>取消</Button></div></Dialog></Modal></ModalOverlay>
  </main>;
}
