import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { DramaCard } from './types';
import { api } from './api';

/**
 * 本地状态单例 + 持久化接线（原 @hongguo/core store 就地内联，包方式改造）：
 * store 变更 → IPC → 主进程 JSON 文件持久化。
 */

// ===== 类型 =====

export interface HistoryEntry {
  dramaId: string;
  title: string;
  coverUrl: string;
  episodeIndex: number;
  episodeId: string;
  positionSec: number;
  /** 当前分集总时长（秒），用于计算完播比例 */
  durationSec?: number;
  /** 已完播（播放进度 ≥90%）的分集 id 列表，用于详情页选集"已完播"指示 */
  finishedEpIds?: string[];
  /** 剧集总集数（进度条用） */
  totalEpisodes?: number;
  updatedAt: number;
}

export interface Settings {
  autoNext: boolean;
  defaultSpeed: number;
  rememberProgress: boolean;
}

// ===== stores（与原 @hongguo/core 行为一致） =====

export const favoritesStore = createStore<{
  items: Record<string, DramaCard>;
  toggle: (drama: DramaCard) => void;
  has: (id: string) => boolean;
  clear: () => void;
}>((set, get) => ({
  items: {},
  toggle: (drama) =>
    set((s) => {
      const next = { ...s.items };
      if (next[drama.id]) delete next[drama.id];
      else next[drama.id] = drama;
      return { items: next };
    }),
  has: (id) => !!get().items[id],
  clear: () => set({ items: {} }),
}));

const HISTORY_MAX = 200;

export const historyStore = createStore<{
  entries: HistoryEntry[];
  upsert: (e: HistoryEntry) => void;
  remove: (dramaId: string) => void;
  clear: () => void;
  find: (dramaId: string) => HistoryEntry | undefined;
}>((set, get) => ({
  entries: [],
  upsert: (e) =>
    set((s) => {
      const old = s.entries.find((x) => x.dramaId === e.dramaId);
      // 同剧同集且进度没变 → 不产生新状态（避免订阅方无意义重渲染/持久化）
      if (old && old.episodeId === e.episodeId && old.positionSec === e.positionSec) return s;
      const rest = s.entries.filter((x) => x.dramaId !== e.dramaId);
      return { entries: [e, ...rest].slice(0, HISTORY_MAX) };
    }),
  remove: (dramaId) => set((s) => ({ entries: s.entries.filter((x) => x.dramaId !== dramaId) })),
  clear: () => set({ entries: [] }),
  find: (dramaId) => get().entries.find((x) => x.dramaId === dramaId),
}));

export const settingsStore = createStore<
  Settings & { update: (patch: Partial<Settings>) => void }
>((set) => ({
  autoNext: true,
  defaultSpeed: 1.0,
  rememberProgress: true,
  update: (patch) => set(patch),
}));

const SEARCH_HISTORY_MAX = 15;

/** 搜索历史（本地持久化，最新在前去重） */
export const searchHistoryStore = createStore<{
  items: string[];
  add: (kw: string) => void;
  remove: (kw: string) => void;
  clear: () => void;
}>((set) => ({
  items: [],
  add: (kw) =>
    set((s) => {
      const key = kw.trim();
      if (!key) return s;
      return { items: [key, ...s.items.filter((x) => x !== key)].slice(0, SEARCH_HISTORY_MAX) };
    }),
  remove: (kw) => set((s) => ({ items: s.items.filter((x) => x !== kw) })),
  clear: () => set({ items: [] }),
}));

// ===== 持久化 =====

const KEY = {
  favorites: 'favorites',
  history: 'history',
  settings: 'settings',
  searchHistory: 'searchHistory',
} as const;

/** 启动时从磁盘水合 */
export async function hydrateStores(): Promise<void> {
  try {
    const favs = await api.storage.get<Record<string, DramaCard>>(KEY.favorites);
    if (favs) favoritesStore.setState({ items: favs });

    const history = await api.storage.get<HistoryEntry[]>(KEY.history);
    if (history) historyStore.setState({ entries: history });

    const settings = await api.storage.get<Partial<Settings>>(KEY.settings);
    if (settings) settingsStore.setState(settings);

    const searchHistory = await api.storage.get<string[]>(KEY.searchHistory);
    if (searchHistory) searchHistoryStore.setState({ items: searchHistory });
  } catch (err) {
    console.error('[hongguo] 恢复本地数据失败', err);
  }
}

/** 订阅变更并持久化 */
function wirePersistence(): void {
  favoritesStore.subscribe((s) => {
    void api.storage.set(KEY.favorites, s.items);
  });
  historyStore.subscribe((s) => {
    void api.storage.set(KEY.history, s.entries);
  });
  settingsStore.subscribe((s) => {
    const { autoNext, defaultSpeed, rememberProgress } = s;
    void api.storage.set(KEY.settings, { autoNext, defaultSpeed, rememberProgress });
  });
  searchHistoryStore.subscribe((s) => {
    void api.storage.set(KEY.searchHistory, s.items);
  });
}

// 模块加载即接线（renderer 单例）
void hydrateStores();
wirePersistence();

// 播放器独立窗口写的历史/收藏：主窗口重新聚焦时从磁盘水合，保持两边一致
window.addEventListener('focus', () => {
  void hydrateStores();
});

// ===== React hooks =====
export const useFavorites = () => useStore(favoritesStore);
export const useHistory = () => useStore(historyStore);
export const useSettings = () => useStore(settingsStore);
export const useSearchHistory = () => useStore(searchHistoryStore);
