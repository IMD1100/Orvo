import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Handle, Position, SelectionMode, useReactFlow, useViewport, type Node, type NodeProps, type NodeChange, type Edge, type HandleType, type OnConnectEnd } from '@xyflow/react';
import { RiAddLine, RiArrowGoBackLine, RiArrowGoForwardLine, RiClipboardLine, RiCloseLine, RiDeleteBinLine, RiEqualizerLine, RiFileCopyLine, RiFocus3Line, RiLayoutColumnLine, RiMusic2Line, RiNodeTree, RiVolumeUpLine, RiPlayFill, RiPauseFill, RiStopFill } from '@remixicon/react';
import { Dialog, Modal, ModalOverlay } from 'react-aria-components';
import { Button } from '@/components/base/buttons/button';
import { Checkbox } from '@/components/base/checkbox/checkbox';
import { ContextMenu, ContextMenuItem, ContextMenuSeparator, ContextMenuSubmenu, ContextMenuTrigger } from '@/components/base/context-menu/context-menu';
import { Input } from '@/components/base/input/input';
import { cx } from '@/utils/cx';
import { Parameter, parameterLabel } from './Parameter';
import { EQCurve, SpectrumContext, type Spectrum } from './EQCurve';
import { audioGraphKey, copy, type Catalog, type Effect, type Graph, type Link } from './protocol';
import './styles/blueprint.css';

const INPUT = '@input', OUTPUT = '@output';
const GAIN = { min: -60, max: 12, unit: 'dB' };
const FIT = { padding: .16, maxZoom: 1 };
const keyPrefix = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+';
type Point = [number, number];
type Positions = Graph['routing']['positions'];
type Kind = 'input' | 'effect' | 'mixer' | 'output';
type Placement = { point: Point; insert?: Link; from?: { id: string; type: HandleType } };
export type NodeClipboard = { effects: Effect[]; mixers: string[]; links: Link[]; positions: Positions; sizes: Positions };
type GraphClipboard = { current: NodeClipboard | null };
export type GraphHistory = { past: Graph[]; future: Graph[] };
type GraphHistoryStore = { current: Map<string, GraphHistory> };
type Transport = { playing: boolean; position: number; duration: number; disabled: boolean; toggle: () => void; stop: () => void };
type FXNode = Node<{ label: string; kind: Kind; count: number; enabled: boolean; channelName?: string; toggle?: (enabled: boolean) => void; body?: ReactNode; eq?: ReactNode; issue: boolean }>;
type GraphEditorProps = {
  graph: Graph; draft?: Graph; spectrum?: Spectrum; sampleRate: number; catalog: Catalog | null; locked: boolean; channelName: string; transport: Transport;
  apply: (graph: Graph) => Promise<boolean>; clipboard: GraphClipboard; history: GraphHistoryStore; historyKey: string; onDraftChange: (draft: Graph, valid: boolean) => void;
};

const wireId = ({ source, target }: Link) => source + '→' + target;
const coordinate = (value: number) => Math.max(-1_000_000, Math.min(1_000_000, Math.round(value)));

function nodeIds(graph: Graph) {
  return [INPUT, ...graph.chain.map(item => item.id), ...graph.routing.mixers, OUTPUT];
}

function canConnect(graph: Graph, { source, target }: Pick<Link, 'source' | 'target'>) {
  const ids = nodeIds(graph);
  const { links, mixers } = graph.routing;
  if (links.length >= 96 || source === target || source === OUTPUT || target === INPUT ||
      !ids.includes(source) || !ids.includes(target) ||
      links.some(link => link.target === target && (link.source === source || !mixers.includes(target)))) return false;
  const pending = [target];
  const visited = new Set<string>();
  for (const id of pending) {
    if (id === source) return false;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const link of links) if (link.source === id) pending.push(link.target);
  }
  return true;
}

function nodeSize(count: number, kind: Kind, hasEq = false): Point {
  if (kind === 'input') return [136, 68];
  if (kind === 'output') return [136, 124];
  const columns = count > 4 ? 2 : 1;
  return [hasEq ? 900 : columns === 2 ? 400 : 256, hasEq ? 535 + Math.ceil(count / 3) * 62 : 52 + Math.ceil(count / columns) * 62];
}

function overlaps([x, y]: Point, [width, height]: Point, [left, top]: Point, [otherWidth, otherHeight]: Point, gap = 12) {
  return x < left + otherWidth + gap && x + width + gap > left && y < top + otherHeight + gap && y + height + gap > top;
}

function topology(graph: Graph, ids: string[]) {
  const incoming = new Map(ids.map(id => [id, 0]));
  const outgoing = new Map(ids.map(id => [id, [] as string[]]));
  for (const { source, target } of graph.routing.links) {
    if (!outgoing.has(source) || !incoming.has(target)) continue;
    outgoing.get(source)!.push(target);
    incoming.set(target, incoming.get(target)! + 1);
  }
  const remaining = new Map(incoming);
  const depth = new Map(ids.map(id => [id, id === INPUT ? 0 : 1]));
  const order = ids.filter(id => remaining.get(id) === 0);
  for (const id of order) {
    for (const target of outgoing.get(id)!) {
      depth.set(target, Math.max(depth.get(target)!, depth.get(id)! + 1));
      remaining.set(target, remaining.get(target)! - 1);
      if (remaining.get(target) === 0) order.push(target);
    }
  }
  depth.set(OUTPUT, 1 + Math.max(...ids.filter(id => id !== OUTPUT).map(id => depth.get(id)!)));
  const cycle = order.length !== ids.length;
  const issueId = ids.find(id => id !== INPUT && !incoming.get(id))
    ?? ids.find(id => id !== OUTPUT && !outgoing.get(id)!.length)
    ?? ids.find(id => graph.routing.mixers.includes(id) ? incoming.get(id)! < 2 : incoming.get(id)! > 1);
  const issue = cycle ? '路由存在循环，请检查连线。' : !issueId ? '' :
    issueId !== INPUT && !incoming.get(issueId) ? '需要连接输入。' :
    issueId !== OUTPUT && !outgoing.get(issueId)!.length ? '需要连接输出。' :
    graph.routing.mixers.includes(issueId) ? '汇合节点至少需要两路输入。' : '多路输入需要先通过汇合节点。';
  return { depth, issueId: cycle ? undefined : issueId, issue };
}

function arrangeNodes(ids: string[], sizes: Positions, depth: Map<string, number>, links: Link[]): Positions {
  const columns = new Map<number, string[]>();
  for (const id of ids) {
    const rank = depth.get(id)!;
    const column = columns.get(rank);
    if (column) column.push(id);
    else columns.set(rank, [id]);
  }
  const ranks = [...columns.keys()].sort((a, b) => a - b);
  for (let pass = 0; pass < 4; pass++) {
    const forward = pass % 2 === 0;
    for (const rank of forward ? ranks : [...ranks].reverse()) {
      const column = columns.get(rank)!;
      const neighbors = (id: string) => links.flatMap(link => {
        const other = forward && link.target === id ? link.source : !forward && link.source === id ? link.target : undefined;
        if (!other) return [];
        const otherColumn = columns.get(depth.get(other)!);
        return otherColumn ? [otherColumn.indexOf(other)] : [];
      });
      const score = (id: string) => { const values = neighbors(id); return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : column.indexOf(id); };
      const ordered = column.map((id, index) => ({ id, index, score: score(id) }));
      ordered.sort((a, b) => a.score - b.score || a.index - b.index);
      columns.set(rank, ordered.map(item => item.id));
    }
  }
  const entries: [string, Point][] = [];
  let x = 0;
  for (const [, column] of [...columns].sort(([a], [b]) => a - b)) {
    const totalHeight = column.reduce((height, id) => height + sizes[id][1] + 64, -64);
    let y = Math.round(-totalHeight / 2);
    for (const id of column) {
      entries.push([id, [x, y]]);
      y += sizes[id][1] + 64;
    }
    x += Math.max(...column.map(id => sizes[id][0])) + 72;
  }
  const positions = Object.fromEntries(entries) as Positions;
  // Move obstructing nodes down while keeping the original curves independent.
  for (let pass = 0; pass < 3; pass++) {
    for (const rank of ranks) {
      const column = columns.get(rank)!;
      for (let index = 0; index < column.length; index++) {
        const id = column[index];
        let [nx, ny] = positions[id];
        const [width, height] = sizes[id];
        for (const link of links) {
          if (link.source === id || link.target === id || !positions[link.source] || !positions[link.target]) continue;
          const [sx, sy] = positions[link.source], [tx, ty] = positions[link.target];
          const x0 = sx + sizes[link.source][0], x1 = tx;
          if (x1 <= x0 || nx + width <= x0 || nx >= x1) continue;
          const y0 = sy + sizes[link.source][1] / 2, y1 = ty + sizes[link.target][1] / 2;
          for (let sample = 0; sample <= 12; sample++) {
            const t = sample / 12, x = x0 + (x1 - x0) * t;
            const y = y0 + (y1 - y0) * (3 * t * t - 2 * t * t * t);
            if (x >= nx - 8 && x <= nx + width + 8 && y >= ny - 12 && y <= ny + height + 12) ny = Math.ceil(y + 24);
          }
        }
        if (index > 0) { const previous = column[index - 1]; ny = Math.max(ny, positions[previous][1] + sizes[previous][1] + 64); }
        positions[id] = [nx, ny];
      }
    }
  }
  return positions;
}

export function arrangeGeneratedGraph(graph: Graph): Positions {
  const ids = nodeIds(graph);
  const effects = new Map(graph.chain.map(effect => [effect.id, effect]));
  const sizes: Positions = Object.fromEntries(ids.map(id => {
    const effect = effects.get(id);
    const kind: Kind = id === INPUT ? 'input' : id === OUTPUT ? 'output' : effect ? 'effect' : 'mixer';
    const count = effect ? Object.keys(effect.parameters).length : kind === 'mixer' ? graph.routing.links.filter(link => link.target === id).length : 0;
    const [width, height] = nodeSize(count, kind, effect?.effect === 'equalizer');
    return [id, [width, height + 32 + Math.ceil(count / (count > 4 ? 2 : 1)) * 18]];
  }));
  return arrangeNodes(ids, sizes, topology(graph, ids).depth, graph.routing.links);
}

function NodeTransport({ playing, position, duration, disabled, toggle, stop }: Transport) {
  const ring = useRef<SVGCircleElement>(null);
  useEffect(() => {
    const started = performance.now();
    let frame = 0;
    const update = (now: number) => {
      frame = 0;
      const progress = duration > 0 ? Math.max(0, Math.min(1, (position + (playing ? now - started : 0)) / duration)) : 0;
      if (ring.current) ring.current.style.strokeDashoffset = String(100 - progress * 100);
      if (playing && !document.hidden && document.hasFocus()) frame = requestAnimationFrame(update);
    };
    const resume = () => { if (playing && !frame && !document.hidden && document.hasFocus()) frame = requestAnimationFrame(update); };
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    update(started);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume); };
  }, [playing, position, duration]);
  return <div className="blueprint-transport">
    <div className="blueprint-play-ring">
      <svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="19" pathLength="100" className="blueprint-progress-track" /><circle ref={ring} cx="20" cy="20" r="19" pathLength="100" className="blueprint-progress-value" /></svg>
      <Button size="small" variant={playing ? 'danger' : 'secondary'} className="transport-play rounded-full" iconOnly leadingIcon={playing ? RiPauseFill : RiPlayFill} aria-label={playing ? '暂停' : '播放'} aria-pressed={playing} disabled={disabled} onClick={toggle} />
    </div>
    <Button size="small" variant="secondary" className="rounded-full" iconOnly leadingIcon={RiStopFill} aria-label="停止并回到起点" disabled={disabled} onClick={stop} />
  </div>;
}

function EffectNode({ data, selected, isConnectable }: NodeProps<FXNode>) {
  const { label, kind, count, enabled, channelName, toggle, eq, body, issue } = data;
  const Icon = kind === 'input' ? RiMusic2Line : kind === 'output' ? RiVolumeUpLine : kind === 'mixer' ? RiNodeTree : RiEqualizerLine;
  return <div className="blueprint-node" data-eq={!!eq || undefined} data-kind={kind} data-selected={selected} data-bypassed={!enabled} data-issue={issue} style={{ width: nodeSize(count, kind, !!eq)[0] }}>
    <div className="blueprint-node-head">
      <Icon size={18} aria-hidden="true" />
      <strong className="text-body-semibold">{label}</strong>
      {kind === 'effect' && <Checkbox className="nodrag nopan blueprint-enable" size="sm" aria-label={label + '启用'} isSelected={enabled} isDisabled={!toggle} onChange={toggle} />}
    </div>
    {channelName && <div className="blueprint-node-channel text-caption-1-regular">{channelName}</div>}
    {(body || eq) && <div className="blueprint-node-body nodrag nopan">
      {eq}
      {body && <div className={cx('blueprint-node-fields', count > 4 && 'blueprint-node-columns')}>{body}</div>}
    </div>}
    {kind !== 'input' && <Handle type="target" position={Position.Left} isConnectable={isConnectable} aria-label={label + '输入'} />}
    {kind !== 'output' && <Handle type="source" position={Position.Right} isConnectable={isConnectable} aria-label={label + '输出'} />}
  </div>;
}
const nodeTypes = { fx: EffectNode };

function ZoomIndicator({ fit }: { fit: () => void }) {
  const { zoom } = useViewport();
  return <Button className="blueprint-zoom" size="small" variant="secondary"
    aria-label={'适应画布，当前缩放 ' + Math.round(zoom * 100) + '%'} onClick={fit}>{Math.round(zoom * 100)}%</Button>;
}

export function GraphEditor({ spectrum, ...props }: GraphEditorProps) {
  return <SpectrumContext.Provider value={spectrum}>
    <ReactFlowProvider><GraphCanvas {...props} /></ReactFlowProvider>
  </SpectrumContext.Provider>;
}

const GraphCanvas = memo(function GraphCanvas({ graph, draft = graph, sampleRate, catalog, locked, channelName, transport, apply, clipboard, history, historyKey, onDraftChange }: Omit<GraphEditorProps, 'spectrum'>) {
  const [past, setPast] = useState<Graph[]>(() => history.current.get(historyKey)?.past ?? []);
  const [future, setFuture] = useState<Graph[]>(() => history.current.get(historyKey)?.future ?? []);
  useLayoutEffect(() => { history.current.set(historyKey, { past, future }); }, [history, historyKey, past, future]);
  const [selected, setSelected] = useState('');
  const [selectedNodes, setSelectedNodes] = useState<string[]>([]);
  const select = (id: string) => { setSelected(id); setSelectedNodes(id && !id.includes('→') ? [id] : []); };
  const [movement, setMovement] = useState<Positions>({});
  const [pluginPlacement, setPluginPlacement] = useState<Placement>();
  const [drop, setDrop] = useState<Placement>();
  const [pluginPath, setPluginPath] = useState('');
  const [copiedNodes, setCopiedNodes] = useState<NodeClipboard | null>(clipboard.current);
  const sliding = useRef(false);
  const canvas = useRef<HTMLDivElement>(null);
  const menuPoint = useRef<Point>(undefined);
  const { fitView, screenToFlowPosition, zoomIn, zoomOut, getInternalNode } = useReactFlow<FXNode>();
  const dirty = graph !== draft && audioGraphKey(graph) !== audioGraphKey(draft);
  const emit = (next: Graph) => onDraftChange(next, !topology(next, nodeIds(next)).issue);
  const update = (next: Graph, fromSlider = false) => {
    if (!fromSlider || !sliding.current) {
      setPast(previous => [...previous.slice(-49), draft]);
      setFuture([]);
    }
    sliding.current = fromSlider;
    emit(next);
  };
  const endSlide = () => { sliding.current = false; };
  const undo = () => {
    if (locked || !past.length) return;
    setFuture([...future, draft]);
    emit(past[past.length - 1]);
    setPast(past.slice(0, -1));
  };
  const redo = () => {
    if (locked || !future.length) return;
    setPast([...past, draft]);
    emit(future[future.length - 1]);
    setFuture(future.slice(0, -1));
  };
  const discard = () => { emit(graph); setPast([]); setFuture([]); select(''); };

  const ids = nodeIds(draft);
  const items = new Map(draft.chain.map(item => [item.id, item]));
  const kindOf = (id: string): Kind => id === INPUT ? 'input' : id === OUTPUT ? 'output' : items.has(id) ? 'effect' : 'mixer';
  const labelOf = (id: string) => {
    const item = items.get(id);
    return item?.pluginPath?.split(/[\\/]/).pop() ?? (item
      ? catalog?.catalog[item.effect]?.name ?? item.effect
      : id === INPUT ? '输入' : id === OUTPUT ? '输出' : '汇合');
  };
  const links = draft.routing.links;
  const { depth, issueId, issue } = topology(draft, ids);
  const counts = Object.fromEntries(ids.map(id => [id, items.has(id)
    ? Object.keys(items.get(id)!.parameters).length
    : links.filter(link => link.target === id && kindOf(id) === 'mixer').length]));
  const sizes: Positions = Object.fromEntries(ids.map(id => [id, nodeSize(counts[id], kindOf(id), items.get(id)?.effect === 'equalizer')]));
  const automatic = arrangeNodes(ids, sizes, depth, links);
  const saved = draft.routing.positions;
  const positions = { ...automatic, ...saved };

  const editEffect = (id: string, edit: (item: Effect) => void, fromSlider = false) => {
    const next = copy(draft);
    edit(next.chain.find(item => item.id === id)!);
    update(next, fromSlider);
  };
  const nodes = ids.map((id): FXNode => {
    const item = items.get(id);
    const kind = kindOf(id);
    const label = labelOf(id);
    const [x, y] = movement[id] ?? positions[id];
    const body = item ? <>
      {Object.entries(item.parameters).map(([name, value], i) =>
        <Parameter key={name} name={id + '-' + name} label={parameterLabel(name, i)} value={value}
          bounds={catalog?.catalog[item.effect]?.parameters[name]} disabled={locked} onSlideEnd={endSlide}
          change={(value, fromSlider) => editEffect(id, item => { item.parameters[name] = value; }, fromSlider)} />
      )}
      {item.pluginPath && <p title={item.pluginPath} className="blueprint-plugin-path text-caption-1-regular text-text-secondary">{item.pluginPath}</p>}
    </> : kind === 'mixer' ? links.filter(link => link.target === id).map(link =>
      <Parameter key={wireId(link)} name={`branch-${id}-${link.source}`} label={labelOf(link.source)} bounds={GAIN} value={link.gain_db} disabled={locked} onSlideEnd={endSlide}
        change={(value, fromSlider) => {
          const next = copy(draft);
          next.routing.links.find(candidate => wireId(candidate) === wireId(link))!.gain_db = value;
          update(next, fromSlider);
        }} />
    ) : undefined;
    return {
      id, type: 'fx', position: { x, y }, initialWidth: sizes[id][0], initialHeight: sizes[id][1],
      measured: getInternalNode(id)?.measured,
      selected: selectedNodes.includes(id), dragHandle: '.blueprint-node-head', ariaLabel: label,
      data: {
        label, kind, count: counts[id], enabled: item?.enabled ?? true, channelName: kind === 'input' || kind === 'output' ? channelName : undefined, issue: dirty && issueId === id,
        toggle: item && !locked ? enabled => editEffect(id, item => { item.enabled = enabled; }) : undefined,
        body: kind === 'output' ? <NodeTransport {...transport} /> : counts[id] || item?.pluginPath ? body : undefined,
        eq: item?.effect === 'equalizer' ? <EQCurve parameters={item.parameters} sampleRate={sampleRate} enabled={item.enabled} /> : undefined,
      },
    };
  });
  const edges: Edge[] = links.map(link => ({
    ...link, id: wireId(link), selected: wireId(link) === selected, interactionWidth: 16,
    className: items.get(link.source)?.enabled === false || items.get(link.target)?.enabled === false ? 'blueprint-bypassed-edge' : undefined,
    ariaLabel: labelOf(link.source) + '到' + labelOf(link.target),
    label: link.gain_db ? link.gain_db + ' dB' : undefined,
  }));
  const selectedLink = links.find(link => wireId(link) === selected);
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0] : '';
  const selectedEffect = items.get(selectedNode);
  const selectedMixer = draft.routing.mixers.includes(selectedNode);
  const selectedEditable = selectedNodes.filter(id => items.has(id) || draft.routing.mixers.includes(id));
  const removable = !!selectedLink || selectedEditable.length > 0;
  const branch = selectedLink && draft.routing.mixers.includes(selectedLink.target);
  const available = Object.entries(catalog?.catalog ?? {}).filter(([id]) => id !== 'plugin');
  const canAdd = !locked && draft.chain.length < 32;
  const canAddMixer = !locked && draft.routing.mixers.length < 8;
  const canApply = dirty && !locked && !issue;
  const applyDraft = async () => {
    if (canApply) await apply(copy(draft));
  };

  const fit = () => void fitView({ ...FIT, duration: 180 });
  const arrange = () => {
    const next = copy(draft);
    const measured = Object.fromEntries(ids.map(id => {
      const node = getInternalNode(id);
      return [id, [node?.measured?.width ?? sizes[id][0], node?.measured?.height ?? sizes[id][1]] as Point];
    }));
    next.routing.positions = arrangeNodes(ids, measured, depth, links);
    if (JSON.stringify(saved) !== JSON.stringify(next.routing.positions)) update(next);
    requestAnimationFrame(fit);
  };

  const menuPlacement = (): Placement => ({ point: menuPoint.current ?? positions[OUTPUT], insert: selectedLink });
  function addNode(effect: string, placement: Placement, path?: string, copied?: Effect) {
    const mixer = effect === 'mixer';
    const definition = catalog?.catalog[effect];
    if (mixer ? !canAddMixer : !canAdd || !definition && !path && !copied) return;
    const next = copy(draft);
    const id = (mixer ? 'mix_' : path ? 'plugin_' : 'fx_') + crypto.randomUUID().slice(0, 8);
    const parameters = copied ? { ...copied.parameters } : Object.fromEntries(Object.entries(definition?.parameters ?? {}).map(([name, bounds]) => [name, bounds.default]));
    if (mixer) next.routing.mixers.push(id);
    else next.chain.push({ id, effect, enabled: copied?.enabled ?? true, parameters, ...(path ? { pluginPath: path } : {}) });
    const { from, insert, point } = placement;
    const incoming = next.routing.links.find(link => from
      ? from.type === 'target' && link.target === from.id && !next.routing.mixers.includes(from.id)
      : insert ? wireId(link) === wireId(insert) : !mixer && link.target === OUTPUT);
    if (incoming && links.length < 96) {
      next.routing.links.push({ source: id, target: incoming.target, gain_db: incoming.gain_db });
      incoming.target = id;
      incoming.gain_db = 0;
    } else if (from) {
      const connection = from.type === 'source' ? { source: from.id, target: id } : { source: id, target: from.id };
      if (!canConnect(next, connection)) return;
      next.routing.links.push({ ...connection, gain_db: 0 });
    } else if (!mixer && !links.some(link => link.target === OUTPUT) && links.length < 95) {
      next.routing.links.push({ source: INPUT, target: id, gain_db: 0 }, { source: id, target: OUTPUT, gain_db: 0 });
    }
    next.routing.positions = { ...positions };
    const size = nodeSize(Object.keys(parameters).length, mixer ? 'mixer' : 'effect', effect === 'equalizer');
    const x = coordinate(point[0] - (from?.type === 'source' ? 0 : from?.type === 'target' ? size[0] : size[0] / 2));
    let y = coordinate(point[1] - size[1] / 2);
    const occupied = ids.filter(node => overlaps([x, y], size, positions[node], sizes[node]));
    if (occupied.length) {
      const lower = Math.max(...ids.filter(node => x < positions[node][0] + sizes[node][0] + 12 && x + size[0] + 12 > positions[node][0])
        .map(node => positions[node][1] + sizes[node][1] + 24));
      y = coordinate(lower <= 1_000_000 ? lower : Math.min(...occupied.map(node => positions[node][1])) - size[1] - 24);
    }
    next.routing.positions[id] = [x, y];
    update(next);
    select(id);
  }

  const validConnection = (connection: Pick<Link, 'source' | 'target'>) => !locked && canConnect(draft, connection);
  const connect = ({ source, target }: Pick<Link, 'source' | 'target'>) => {
    if (!validConnection({ source, target })) return;
    const next = copy(draft);
    next.routing.links.push({ source, target, gain_db: 0 });
    update(next);
  };
  const connectEnd = (openAt: (x: number, y: number) => void): OnConnectEnd => (event, state) => {
    if (state.isValid || !state.fromHandle || links.length >= 96 || !(canAdd || canAddMixer)) return;
    const pointer = 'changedTouches' in event ? event.changedTouches[0] : event;
    if (!pointer) return;
    const { clientX: x, clientY: y } = pointer;
    const hit = document.elementFromPoint(x, y);
    if (!hit?.closest('.react-flow__pane') || !canvas.current?.contains(hit) || hit.closest('.react-flow__node, .react-flow__edge')) return;
    const point = screenToFlowPosition({ x, y });
    setDrop({ point: [point.x, point.y], from: { id: state.fromHandle.nodeId, type: state.fromHandle.type } });
    openAt(x, y);
  };
  const copyNode = () => {
    if (!selectedEditable.length) return;
    const included = new Set(selectedEditable);
    clipboard.current = {
      effects: copy(draft.chain.filter(item => included.has(item.id))),
      mixers: draft.routing.mixers.filter(id => included.has(id)),
      links: copy(links.filter(link => included.has(link.source) && included.has(link.target))),
      positions: Object.fromEntries(selectedEditable.map(id => [id, [...(movement[id] ?? positions[id])] as Point])),
      sizes: Object.fromEntries(selectedEditable.map(id => [id, [...sizes[id]] as Point])),
    };
    setCopiedNodes(clipboard.current);
  };
  const canPasteNodes = !!copiedNodes && !locked
    && draft.chain.length + copiedNodes.effects.length <= 32
    && draft.routing.mixers.length + copiedNodes.mixers.length <= 8
    && links.length + copiedNodes.links.length <= 96;
  const pasteNode = () => {
    const copied = clipboard.current;
    if (!copied || !canPasteNodes) return;
    const next = copy(draft);
    const copiedIds = [...copied.effects.map(item => item.id), ...copied.mixers];
    const mapping = new Map(copiedIds.map(id => [id, (copied.mixers.includes(id) ? 'mix_' : 'fx_') + crypto.randomUUID().replaceAll('-', '').slice(0, 16)]));
    const overlapsExisting = copiedIds.some(id => ids.some(existing => overlaps(
      [copied.positions[id][0] + 32, copied.positions[id][1] + 32], copied.sizes[id], positions[existing], sizes[existing])));
    const minY = Math.min(...copiedIds.map(id => copied.positions[id][1]));
    const offsetY = overlapsExisting ? Math.max(...ids.map(id => positions[id][1] + sizes[id][1])) + 32 - minY : 32;
    next.chain.push(...copied.effects.map(item => ({ ...copy(item), id: mapping.get(item.id)! })));
    next.routing.mixers.push(...copied.mixers.map(id => mapping.get(id)!));
    next.routing.links.push(...copied.links.map(link => ({ ...copy(link), source: mapping.get(link.source)!, target: mapping.get(link.target)! })));
    next.routing.positions = { ...positions };
    for (const id of copiedIds) next.routing.positions[mapping.get(id)!] = [coordinate(copied.positions[id][0] + 32), coordinate(copied.positions[id][1] + offsetY)];
    update(next);
    setSelected(''); setSelectedNodes(copiedIds.map(id => mapping.get(id)!));
  };
  const remove = () => {
    if (locked || !removable) return;
    const next = copy(draft);
    if (selectedLink) next.routing.links = next.routing.links.filter(link => wireId(link) !== selected);
    else for (const id of selectedEditable) {
      const incoming = next.routing.links.filter(link => link.target === id);
      const outgoing = next.routing.links.filter(link => link.source === id);
      next.chain = next.chain.filter(item => item.id !== id);
      next.routing.mixers = next.routing.mixers.filter(item => item !== id);
      next.routing.links = next.routing.links.filter(link => link.source !== id && link.target !== id);
      if (incoming.length === 1 && outgoing.length === 1 && !next.routing.links.some(link => link.source === incoming[0].source && link.target === outgoing[0].target)) {
        next.routing.links.push({ source: incoming[0].source, target: outgoing[0].target, gain_db: outgoing[0].gain_db });
      }
      delete next.routing.positions[id];
    }
    update(next);
    select('');
  };
  const onNodesChange = (changes: NodeChange<FXNode>[]) => {
    const selections = changes.filter(change => change.type === 'select');
    if (selections.length) {
      setSelectedNodes(previous => {
        const next = new Set(previous);
        for (const change of selections) { if (change.selected) next.add(change.id); else next.delete(change.id); }
        return [...next];
      });
      if (selections.some(change => change.selected)) setSelected('');
    }
    if (locked) return;
    const moving: Positions = {}, finished: Positions = {};
    for (const change of changes) {
      if (change.type !== 'position' || !change.position || !positions[change.id]) continue;
      const point: Point = [coordinate(change.position.x), coordinate(change.position.y)];
      (change.dragging ? moving : finished)[change.id] = point;
    }
    if (Object.keys(moving).length) setMovement(previous => ({ ...previous, ...moving }));
    if (Object.keys(finished).length) {
      setMovement(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !(id in finished))));
      if (Object.entries(finished).some(([id, point]) => positions[id][0] !== point[0] || positions[id][1] !== point[1])) {
        const next = copy(draft);
        next.routing.positions = { ...positions, ...finished };
        update(next);
      }
    }
  };
  const setMenuTarget = (target: Element, x: number, y: number) => {
    setDrop(undefined);
    const hit = target.closest('.react-flow__node[data-id], .react-flow__edge[data-id]');
    const id = hit?.getAttribute('data-id') ?? '';
    if (hit && (!hit.classList.contains('react-flow__node') || !selectedNodes.includes(id))) select(id);
    const point = screenToFlowPosition({ x, y });
    menuPoint.current = [point.x, point.y];
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element) || !event.currentTarget.contains(target) || event.defaultPrevented) return;
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
      const rect = target.getBoundingClientRect();
      setMenuTarget(target, rect.left + Math.min(24, rect.width / 2), rect.top + Math.min(rect.height, 40));
      return;
    }
    if (target.closest('input, textarea, [contenteditable], [role="slider"], [role="menu"], [role="dialog"]') || event.altKey) return;
    const key = event.key.toLowerCase();
    let action: (() => void) | undefined;
    if (event.ctrlKey || event.metaKey) {
      if (key === 'c') action = copyNode;
      if (key === 'v') action = pasteNode;
      if (key === 'z') action = event.shiftKey ? redo : undo;
      if (key === 'y') action = redo;
      if (key === 'enter' && canApply) action = () => void applyDraft();
    } else {
      if (key === 'delete' && removable) action = remove;
      if (key === 'f') action = fit;
      if (key === '+' || key === '=') action = () => void zoomIn();
      if (key === '-') action = () => void zoomOut();
    }
    if (action) { event.preventDefault(); if (!event.repeat) action(); }
  };

  const openPlugin = (placement: Placement) => {
    setPluginPath('');
    setPluginPlacement(placement);
  };

  return <div className="blueprint-editor">
    <ContextMenuTrigger onOpenChange={open => { if (!open) setDrop(undefined); }}>{({ openAt }) => <>
      <div className="blueprint-canvas" ref={canvas} tabIndex={0} aria-label="效果器蓝图，按 Shift+F10 打开操作菜单"
        onContextMenu={event => {
          const target = event.target as Element;
          const rect = target.getBoundingClientRect();
          setMenuTarget(target, event.clientX || rect.left + Math.min(24, rect.width / 2), event.clientY || rect.top + Math.min(rect.height, 40));
        }} onKeyDown={keyboard}>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
          onEdgesChange={changes => {
            if (changes.some(change => change.type === 'select' && !change.selected && change.id === selected)) setSelected('');
          }}
          onEdgeClick={(_, edge) => select(edge.id)}
          onPaneClick={event => { if (event.button !== 0) return; select(''); event.currentTarget.closest<HTMLElement>('.blueprint-canvas')?.focus({ preventScroll: true }); }}
          onConnect={connect} onConnectEnd={connectEnd(openAt)} isValidConnection={validConnection}
          nodesDraggable={!locked} nodesConnectable={!locked} elementsSelectable={!locked}
          nodeExtent={[[-1_000_000, -1_000_000], [1_000_500, 1_001_000]]}
          deleteKeyCode={null} multiSelectionKeyCode={['Control', 'Meta']} selectionKeyCode="Shift" selectionMode={SelectionMode.Partial}
          panOnDrag={[0, 1]} fitView fitViewOptions={FIT} minZoom={.025} maxZoom={2.4} proOptions={{ hideAttribution: true }}>
          <Background variant={BackgroundVariant.Dots} gap={32} size={1.2} />
        </ReactFlow>
        {dirty && issue && <div className="blueprint-issue text-caption-1-medium" role="status">{issueId && labelOf(issueId) + ' · '}{issue}</div>}
        <div className="blueprint-controls">
          <Button className="blueprint-apply" data-pending={dirty} size="small" variant="secondary"
            disabled={!canApply} aria-label={dirty ? '应用更改' : '更改已应用'} onClick={() => void applyDraft()}>
            {dirty ? '应用更改' : '已应用'}
          </Button>
          <ZoomIndicator fit={fit} />
        </div>
      </div>
      {drop ? <ContextMenu key="connection" aria-label="选择要连接的节点" className="orvo-menu-popup blueprint-node-menu">
        {canAddMixer && <ContextMenuItem id="drop-mixer" icon={RiNodeTree} onAction={() => addNode('mixer', drop)}>汇合</ContextMenuItem>}
        {canAdd && available.map(([id, definition]) => <ContextMenuItem key={id} id={'drop-' + id} onAction={() => addNode(id, drop)}>{definition.name}</ContextMenuItem>)}
        {canAdd && <ContextMenuItem id="drop-plugin" onAction={() => openPlugin(drop)}>第三方插件…</ContextMenuItem>}
      </ContextMenu> : <ContextMenu key="graph" aria-label="蓝图操作" className="orvo-menu-popup blueprint-node-menu">
        <ContextMenuSubmenu label={selectedLink ? '插入节点' : '添加节点'} icon={RiAddLine} isDisabled={!canAdd && !canAddMixer} className="orvo-menu-popup blueprint-create-menu">
          <ContextMenuItem id="add-mixer" icon={RiNodeTree} isDisabled={!canAddMixer} onAction={() => addNode('mixer', menuPlacement())}>汇合</ContextMenuItem>
          {available.map(([id, definition]) => <ContextMenuItem key={id} id={'add-' + id} isDisabled={!canAdd} onAction={() => addNode(id, menuPlacement())}>{definition.name}</ContextMenuItem>)}
          <ContextMenuItem id="add-plugin" isDisabled={!canAdd} onAction={() => openPlugin(menuPlacement())}>第三方插件…</ContextMenuItem>
        </ContextMenuSubmenu>
        {selectedEffect && <ContextMenuItem id="bypass" isDisabled={locked}
          onAction={() => editEffect(selectedEffect.id, item => { item.enabled = !item.enabled; })}>{selectedEffect.enabled ? '旁路效果器' : '启用效果器'}</ContextMenuItem>}
        {branch && <ContextMenuItem id="branch-gain" isDisabled={locked} onAction={() => {
          const field = document.getElementById('param-branch-' + selectedLink.target + '-' + selectedLink.source);
          requestAnimationFrame(() => field?.focus());
        }}>编辑支路增益</ContextMenuItem>}
        <ContextMenuItem id="arrange" icon={RiLayoutColumnLine} isDisabled={locked} onAction={arrange}>自动重排</ContextMenuItem>
        <ContextMenuItem id="fit" icon={RiFocus3Line} shortcut="F" onAction={fit}>适应画布</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem id="copy-node" icon={RiFileCopyLine} shortcut={keyPrefix + 'C'} isDisabled={!selectedEditable.length} onAction={copyNode}>复制节点</ContextMenuItem>
        <ContextMenuItem id="paste-node" icon={RiClipboardLine} shortcut={keyPrefix + 'V'} isDisabled={!canPasteNodes} onAction={pasteNode}>粘贴节点</ContextMenuItem>
        <ContextMenuItem id="undo" icon={RiArrowGoBackLine} shortcut={keyPrefix + 'Z'} isDisabled={locked || !past.length} onAction={undo}>撤销</ContextMenuItem>
        <ContextMenuItem id="redo" icon={RiArrowGoForwardLine} shortcut={keyPrefix + 'Shift+Z'} isDisabled={locked || !future.length} onAction={redo}>重做</ContextMenuItem>
        <ContextMenuItem id="remove" icon={RiDeleteBinLine} shortcut="Delete" variant="danger" isDisabled={locked || !removable} onAction={remove}>
          {selectedLink ? '删除连线' : '删除节点'}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem id="apply" shortcut={keyPrefix + 'Enter'} isDisabled={!canApply} onAction={() => void applyDraft()}>应用更改</ContextMenuItem>
        <ContextMenuItem id="discard" icon={RiCloseLine} isDisabled={locked || !dirty} onAction={discard}>放弃修改</ContextMenuItem>
      </ContextMenu>}
    </>}</ContextMenuTrigger>
    <ModalOverlay className="utility-backdrop utility-popup-backdrop" isOpen={!!pluginPlacement} isDismissable onOpenChange={open => { if (!open) setPluginPlacement(undefined); }}>
      <Modal className="utility-panel">
        <Dialog className="utility-dialog" aria-labelledby="blueprint-plugin-title">
          <header><h2 className="text-title-3-semibold" id="blueprint-plugin-title">添加第三方插件</h2>
            <Button size="small" variant="ghost" iconOnly leadingIcon={RiCloseLine} aria-label="关闭" onClick={() => setPluginPlacement(undefined)} />
          </header>
          <form className="blueprint-plugin-form" onSubmit={event => {
            event.preventDefault();
            if (!canAdd || !pluginPlacement || !pluginPath.trim()) return;
            addNode('plugin', pluginPlacement, pluginPath.trim());
            setPluginPlacement(undefined);
          }}>
            <Input label="插件路径" placeholder="C:\…\effect.vst3" value={pluginPath} onChange={setPluginPath} isDisabled={locked} autoFocus />
            <Button type="submit" size="small" disabled={!canAdd || !pluginPath.trim()}>添加插件节点</Button>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  </div>;
});
