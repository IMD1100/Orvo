import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Bounds } from './Parameter';

export type Effect = { id: string; effect: string; enabled: boolean; parameters: Record<string, number>; pluginPath?: string };
export type Link = { source: string; target: string; gain_db: number };
export type Graph = { schema_version: 3; chain: Effect[]; routing: { mixers: string[]; links: Link[]; positions: Record<string, [number, number]> } };
export const audioGraphKey = (graph: Graph) => JSON.stringify([graph.chain, graph.routing.mixers, graph.routing.links]);
export type Channel = { gainDb: number; pan: number; solo: boolean; muted: boolean; fxEnabled: boolean; graph: Graph };
export type Clip = { id: string; name?: string; source: string; start: number; duration: number; waveform: { duration: number; peaks: [number, number][] } };
export type Track = Channel & { id: string; label: string; source: string | null; clips: Clip[]; duration: number; waveform: { duration: number; peaks: [number, number][] }; pan: number; solo: boolean };
export type AiContext = { instruction: string; reference: string | null; rounds: number; availableEffects: string[] };
export type LoopSelection = { start: number; end: number; enabled: boolean };
export type Project = { schemaVersion: 1; name: string; sampleRate: number; tracks: Track[]; master: Channel; loop?: LoopSelection; ai?: AiContext };
export type SpectrumData = { frequencies: number[]; db: number[] };
export type EngineState = { position: number; duration: number; playing: boolean; playbackSource?: string; levels: Record<string, [number, number]>; master: [number, number]; overload: boolean; spectrum: SpectrumData; masterSpectrum?: SpectrumData };
export type Settings = { baseUrl: string; model: string; hasKey: boolean; deviceId: string };
export type Device = { id: string; label: string; isDefault: boolean };
export type Catalog = { catalog: Record<string, { name: string; parameters: Record<string, Bounds & { default: number }> }>; labels: Record<string, string>; presets: { label: string; instruction: string }[] };
export type Processing = { active: boolean; total: number; completed: number; trackId: string; label: string; phase: 'planning' | 'rendering' | 'measuring' | 'reviewing' | 'comparing' | 'applying' | 'complete' | 'failed' | 'cancelled'; round: number; rounds: number };
export type AIRunResult = { project: Project; cancelled: boolean; items: { trackId: string; label: string; status: 'complete' | 'failed'; rounds: number; stopReason: string; warning?: string; error?: string }[] };
type TrackPatch = Partial<Pick<Track, 'label' | 'gainDb' | 'pan' | 'muted' | 'solo' | 'fxEnabled' | 'graph'>>;
export type EngineRequest = { command: 'project' | 'add_track' | 'pause' | 'stop' | 'state' | 'devices' }
  | { command: 'duplicate_track' | 'remove_track'; id: string }
  | { command: 'set_graph_positions'; id: string; positions: Graph['routing']['positions'] }
  | { command: 'paste_track'; track: Track; after: string } | { command: 'restore_tracks'; tracks: Track[] }
  | { command: 'play'; position?: number; trackId?: string } | { command: 'preview_graph'; id: string; graph: Graph | null }
  | { command: 'import'; paths: string[]; trackId?: string; position?: number }
  | { command: 'move_clip'; fromTrack: string; toTrack?: string; clipId: string; start: number } | { command: 'load_project'; project: Project }
  | ({ command: 'set_track'; id: string } & TrackPatch) | ({ command: 'set_master' } & Partial<Channel>)
  | { command: 'seek'; position: number } | { command: 'set_device'; id: string }
  | ({ command: 'set_loop' } & LoopSelection)
  | { command: 'set_spectrum'; source: string } | { command: 'export'; path: string } | { command: 'export_track'; id: string; path: string };
export type AIRequest = { command: 'catalog' } | { command: 'analyze'; source: string }
  | { command: 'optimize'; instruction: string; availableEffects: string[]; referenceProvided: boolean; batchFileCount: number }
  | { command: 'plan'; source: string; instruction: string; reference: string | null; currentGraph: Graph; availableEffects: string[] };
export async function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error('请使用 orvo 桌面程序。浏览器预览无法连接音频引擎。');
  return invoke<T>(command, args);
}
export const engine = <T>(request: EngineRequest) => native<T>('engine', { request });
export const ai = <T>(request: AIRequest) => native<T>('ai', { request });
export const copy = <T,>(value: T): T => structuredClone(value);
export const clock = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${(ms / 1000 % 60).toFixed(2).padStart(5, '0')}`;
