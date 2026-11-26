import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { DramaCard, CloudProgressRow } from './types';
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

/** 主题模式：dark 暗色 / light 亮色 / system 跟随系统 */
export type ThemeMode = 'dark' | 'light' | 'system';

export interface Settings {
  autoNext: boolean;
  defaultSpeed: number;
  rememberProgress: boolean;
  theme: ThemeMode;
  /** 自动更新开关（任务 66；缺省视为开启，旧配置兼容） */
  autoUpdate: boolean;
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
  theme: 'dark',
  autoUpdate: true,
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

/** 启动时从磁盘水合；window focus 也会重水合（播放器窗口写入的主窗口同步） */
export async function hydrateStores(): Promise<void> {
  try {
    // 各 store 与内存当前值一致时跳过 setState（任务 87）：
    // 主窗口自身 focus 时磁盘值即自己刚写的，全量覆盖会触发订阅方的冗余回写
    // （storage.set 回写 + 云端进度/收藏上报防抖重排），且可能覆盖内存中尚未落盘的新变更
    const favs = await api.storage.get<Record<string, DramaCard>>(KEY.favorites);
    if (favs && JSON.stringify(favs) !== JSON.stringify(favoritesStore.getState().items)) {
      favoritesStore.setState({ items: favs });
    }

    const history = await api.storage.get<HistoryEntry[]>(KEY.history);
    if (history && JSON.stringify(history) !== JSON.stringify(historyStore.getState().entries)) {
      historyStore.setState({ entries: history });
    }

    const settings = await api.storage.get<Partial<Settings>>(KEY.settings);
    if (settings && JSON.stringify(settings) !== JSON.stringify(pickSettings(settingsStore.getState()))) {
      settingsStore.setState(settings);
    }

    const searchHistory = await api.storage.get<string[]>(KEY.searchHistory);
    if (searchHistory && JSON.stringify(searchHistory) !== JSON.stringify(searchHistoryStore.getState().items)) {
      searchHistoryStore.setState({ items: searchHistory });
    }
  } catch (err) {
    console.error('[hongguo] 恢复本地数据失败', err);
  }
}

/** 提取 settings 的持久化字段（与 wirePersistence 写盘字段一致，供水合对比） */
function pickSettings(s: Settings): Pick<Settings, 'autoNext' | 'defaultSpeed' | 'rememberProgress' | 'theme' | 'autoUpdate'> {
  const { autoNext, defaultSpeed, rememberProgress, theme, autoUpdate } = s;
  return { autoNext, defaultSpeed, rememberProgress, theme, autoUpdate };
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
    const { autoNext, defaultSpeed, rememberProgress, theme, autoUpdate } = s;
    void api.storage.set(KEY.settings, { autoNext, defaultSpeed, rememberProgress, theme, autoUpdate });
    // 开关同步到主进程：true 开启定时检查 / false 关闭（自动更新任务 66）
    void api.updater.setEnabled(autoUpdate).catch(() => {});
  });
  searchHistoryStore.subscribe((s) => {
    void api.storage.set(KEY.searchHistory, s.items);
  });
}

// 模块加载即接线（renderer 单例）
void hydrateStores();
wirePersistence();
wireProgressReport();
wireFavoritesReport();
// 账号状态水合（登录态在主进程持久化，这里只刷新展示资料）
void refreshAccountStatus();

// 播放器独立窗口写的历史/收藏：主窗口重新聚焦时从磁盘水合，保持两边一致
window.addEventListener('focus', () => {
  void hydrateStores();
});

// ===== 账号（官网扫码登录 + 云同步） =====

export interface AccountUserState {
  userId: string;
  name: string;
  avatar?: string;
}

/**
 * 账号状态：主窗口 UI 单例（头像按钮 / 设置页登录卡片 / 扫码弹窗共用）。
 * 登录态本身在主进程 login-state + account_session 持久化，此处只缓存展示用资料。
 */
export const accountStore = createStore<{
  status: 'loading' | 'loggedOut' | 'loggedIn';
  user: AccountUserState | null;
  /** 扫码登录弹窗开关（顶栏头像 / 设置页卡片都能打开，弹窗挂在 Topbar） */
  loginModalOpen: boolean;
  /** 最近一次云端进度拉取时间戳（0 = 未同步过） */
  lastSyncAt: number;
  setLoginModalOpen: (v: boolean) => void;
}>((set) => ({
  status: 'loading',
  user: null,
  loginModalOpen: false,
  lastSyncAt: 0,
  setLoginModalOpen: (v) => set({ loginModalOpen: v }),
}));

/** 刷新账号状态（启动水合 / 登录成功 / 退出登录后调用） */
export async function refreshAccountStatus(): Promise<void> {
  try {
    const s = await api.account.status();
    accountStore.setState({
      status: s.loggedIn ? 'loggedIn' : 'loggedOut',
      user: s.user,
      lastSyncAt: s.savedAt ?? accountStore.getState().lastSyncAt,
    });
  } catch {
    accountStore.setState({ status: 'loggedOut', user: null });
  }
}

/**
 * 云端进度行 → 本地历史条目映射。
 * 云端 vidIndex 1 起 / 时间毫秒；本地 episodeIndex 0 起 / 秒。
 */
function cloudRowToEntry(row: CloudProgressRow): HistoryEntry {
  return {
    dramaId: row.seriesId,
    title: row.seriesTitle,
    coverUrl: row.coverUrl || '',
    episodeIndex: Math.max(0, (row.vidIndex || 1) - 1),
    episodeId: row.vid,
    positionSec: Math.floor((row.positionMs || 0) / 1000),
    durationSec: row.durationMs ? Math.floor(row.durationMs / 1000) : undefined,
    totalEpisodes: row.episodeCnt || undefined,
    updatedAt: row.lastWatchTime || Date.now(),
  };
}

/** 云端拉取期间置 true：抑制「拉取 → upsert → 上报」回声 */
let cloudPulling = false;

/**
 * 拉取云端播放进度并合并进本地历史（新者胜：云端 lastWatchTime 更新才覆盖本地）。
 * 登录成功后与设置页「立即同步」调用；返回合并进来的条数。
 */
export async function pullCloudHistory(): Promise<number> {
  const rows = await api.account.history();
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  cloudPulling = true;
  let merged = 0;
  try {
    for (const row of rows) {
      const entry = cloudRowToEntry(row);
      const local = historyStore.getState().find(entry.dramaId);
      // 云端时间戳不比本地新（同剧已本地记录且更新）→ 跳过
      if (local && local.updatedAt >= entry.updatedAt) continue;
      historyStore.getState().upsert(entry);
      merged++;
    }
  } finally {
    // 微任务结束后解除抑制（upsert 同步触发订阅，此时上报已被抑制）
    Promise.resolve().then(() => { cloudPulling = false; });
  }
  if (merged > 0) accountStore.setState({ lastSyncAt: Date.now() });
  return merged;
}

/** 进度上报防抖（本地 5s 节流写历史，云端无需同频） */
const REPORT_DEBOUNCE_MS = 8000;
let reportTimer: ReturnType<typeof setTimeout> | null = null;

/** 进度上报入参构造（缺 vid/序号的脏数据直接跳过） */
function entryToReport(e: HistoryEntry): Parameters<typeof api.account.reportProgress>[0] | null {
  if (!e.dramaId || !e.episodeId) return null;
  return {
    seriesId: e.dramaId,
    vid: e.episodeId,
    episodeIndex: e.episodeIndex + 1,
    positionSec: e.positionSec,
    durationSec: e.durationSec,
    episodeCount: e.totalEpisodes,
    title: e.title,
  };
}

/** 进度上报重置（防抖取消 + 云端拉取抑制解除；退出登录 / 登录成功后调用） */
export function resetProgressReport(): void {
  if (reportTimer) { clearTimeout(reportTimer); reportTimer = null; }
  if (favReportTimer) { clearTimeout(favReportTimer); favReportTimer = null; }
  cloudPulling = false;
}

/**
 * 云端进度上报接线：本地历史每次变更 → 防抖 8s 后把最新一条上报云端。
 * 未登录时服务端自动 no-op（返回 false），渲染层无需关心登录态。
 */
function wireProgressReport(): void {
  historyStore.subscribe((s) => {
    const latest = s.entries[0];
    if (!latest) return;
    if (cloudPulling) return;
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = setTimeout(() => {
      reportTimer = null;
      const input = entryToReport(s.entries[0] ?? latest);
      if (input) void api.account.reportProgress(input).catch(() => {});
    }, REPORT_DEBOUNCE_MS);
  });
}

/**
 * 拉取云端收藏并合并进本地收藏（并集策略：本地没有的从云端补上，不做删除；
 * 本地的增删由订阅自动上报云端）。返回补进来的条数。
 */
export async function pullCloudFavorites(): Promise<number> {
  const rows = await api.account.favorites();
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  cloudPulling = true;
  let merged = 0;
  try {
    for (const row of rows) {
      if (!row.seriesId) continue;
      const cur = favoritesStore.getState().items;
      if (cur[row.seriesId]) continue;
      favoritesStore.setState((s) => ({
        items: {
          ...s.items,
          [row.seriesId]: {
            id: row.seriesId,
            title: row.title,
            coverUrl: row.coverUrl || '',
            totalEpisodes: row.episodeCnt || null,
            tags: [],
          },
        },
      }));
      merged++;
    }
  } finally {
    Promise.resolve().then(() => { cloudPulling = false; });
  }
  if (merged > 0) accountStore.setState({ lastSyncAt: Date.now() });
  return merged;
}

/**
 * 云端全量拉取：播放进度 + 收藏一次同步（登录成功 / 手动「立即同步」入口）。
 */
export async function pullCloudAll(): Promise<{ history: number; favorites: number }> {
  // 两个接口独立请求， singly 失败互不阻塞（Promise.allSettled 语义）
  const [h, f] = await Promise.allSettled([pullCloudHistory(), pullCloudFavorites()]);
  return {
    history: h.status === 'fulfilled' ? h.value : 0,
    favorites: f.status === 'fulfilled' ? f.value : 0,
  };
}

/** 收藏上报防抖（与进度上报同模式，批量合并 3s 内的增删） */
const FAV_REPORT_DEBOUNCE_MS = 3000;
let favReportTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 云端收藏上报接线：本地收藏每次增删 → 防抖 3s 后批量写入云端书架。
 * 未登录时服务端 no-op；云端拉取期间抑制（防「拉取 → setState → 上报」回声）。
 */
function wireFavoritesReport(): void {
  favoritesStore.subscribe((s, prev) => {
    if (cloudPulling) return;
    const added = Object.keys(s.items).filter((id) => !prev.items[id]);
    const removed = Object.keys(prev.items).filter((id) => !s.items[id]);
    if (added.length === 0 && removed.length === 0) return;
    if (favReportTimer) clearTimeout(favReportTimer);
    favReportTimer = setTimeout(() => {
      favReportTimer = null;
      for (const id of added) void api.account.setFavorite(id, true).catch(() => {});
      for (const id of removed) void api.account.setFavorite(id, false).catch(() => {});
    }, FAV_REPORT_DEBOUNCE_MS);
  });
}

// ===== React hooks =====
export const useFavorites = () => useStore(favoritesStore);
export const useHistory = () => useStore(historyStore);
export const useSettings = () => useStore(settingsStore);
export const useSearchHistory = () => useStore(searchHistoryStore);
export const useAccount = () => useStore(accountStore);
