import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import { randomUUID } from 'crypto';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import './dataEnv'; // 必须先于 data-server：设置 HONGGUO_DATA_DIR / HONGGUO_LOG_DIR
import hg from '@hongguo/server';
import { registerWindowIpc } from './window';
import type {
  ActorCard,
  ActorDetail,
  CategoryPageResult,
  DramaCard,
  DramaDetail,
  Episode,
  HomeSection,
  RankItem,
  RankPageResult,
  RankTab,
  SearchResultPage,
} from '../renderer/src/types';
import { RANK_TABS } from '../renderer/src/types';
import { createPlayerWindow } from './playerWindow';

/**
 * 数据层（方案 v2）：
 * @hongguo/server（原 @hongguo/data-server，已并入 src/server）跑在主进程（协议层 Node 原生，双源降级）。
 * Renderer 通过 IPC 调用下面的适配器；demo 的原始字段在这里映射为渲染层数据模型。
 * 视频流是唯一 HTTP 面：本地解密流端点（stream-server）供 <video> Range 消费。
 */

// ===== 原始字段 → 渲染层模型适配 =====

type RawCard = {
  series_id: string;
  series_title?: string;
  cover?: string;
  episode_count?: number;
  tags?: string[];
  /** 目录/榜单卡片扩展字段（hongguo-app-catalog cards 透传） */
  description?: string;
  rec_text?: string;
  score?: string;
  rank?: number;
};

const toCard = (r: RawCard): DramaCard => ({
  id: String(r.series_id),
  title: String(r.series_title ?? ''),
  coverUrl: r.cover || '',
  totalEpisodes: r.episode_count || null,
  tags: Array.isArray(r.tags) ? r.tags : [],
  description: r.description || undefined,
  recText: r.rec_text || undefined,
  kind: 'drama',
});

/** 榜单条目：在卡片基础上补齐排名/热度/集数/简介/分类标签 */
const toRankItem = (r: RawCard): RankItem => {
  const scoreNum = r.score ? Number(r.score) : NaN;
  return {
    ...toCard(r),
    rank: r.rank,
    episodeCount: r.episode_count || undefined,
    categories: Array.isArray(r.tags) ? r.tags : [],
    description: r.description || undefined,
    heatText: r.rec_text || undefined,
    heatValue: parseHotValue(r.rec_text),
    score: r.score || undefined,
    scoreValue: Number.isFinite(scoreNum) && r.score ? scoreNum : undefined,
  };
};

/** "9116万" / "1.2亿" 文案 → 渲染层 fmtMetric 可还原的数值（万为单位） */
function parseHotValue(text?: string | null): number | undefined {
  if (!text) return undefined;
  let m = /([\d.]+)\s*亿/.exec(text);
  if (m) return parseFloat(m[1]) * 10000;
  m = /([\d.]+)\s*万/.exec(text);
  if (m) return parseFloat(m[1]);
  m = /(\d+)/.exec(text);
  return m ? parseFloat(m[1]) : undefined;
}

// ===== 数据获取适配器 =====

const HOME_SECTIONS = [
  { name: '热播短剧', category: 'hot-drama', more: '/rank/hot-drama' },
  { name: '真人剧', category: 'real-drama', more: '/category/real-drama' },
  { name: '漫剧', category: 'comic-drama', more: '/category/comic-drama' },
  { name: 'AI剧', category: 'ai-drama', more: '/category/ai-drama' },
] as const;

async function homeSections(): Promise<HomeSection[]> {
  const sections = await Promise.all(
    HOME_SECTIONS.map(async (s): Promise<HomeSection> => {
      try {
        const r = await hg.dramaService.catalog({ category: s.category, page: 1 });
        return { name: s.name, moreUrl: s.more, items: (r.results ?? []).map(toCard) };
      } catch (e) {
        hg.logger.warn('Adapter', `首页分区 ${s.name} 获取失败: ${String((e as Error)?.message ?? e)}`);
        return { name: s.name, moreUrl: s.more, items: [] };
      }
    }),
  );
  return sections.filter((s) => s.items.length > 0);
}

async function searchPage(keyword: string, page: number): Promise<SearchResultPage> {
  const r = await hg.dramaService.search(keyword, page);
  // 搜索结果带简介/标签/集数，按榜单条目映射，供搜索页行式（RankList）展示
  return {
    items: (r.results ?? []).map(toRankItem),
    totalCount: r.total || undefined,
    hasMore: Boolean(r.hasMore),
  };
}

async function categoryPage(main: string, sub?: string, page = 1): Promise<CategoryPageResult> {
  const r = await hg.dramaService.catalog({ category: main, genre: sub || '', page });
  return {
    items: (r.results ?? []).map(toCard),
    // "全部"是协议外的默认筛选（genre 传空即全部），在适配层补到子标签首位
    subs: [{ key: '', label: '全部' }, ...(r.genres ?? []).map((g) => ({ key: g.slug, label: g.label }))],
    hasMore: Boolean(r.hasMore),
  };
}

async function rankPage(rankKey: string, page = 1): Promise<RankPageResult> {
  const r = await hg.dramaService.catalog({ category: rankKey, page });
  const tabs: RankTab[] = RANK_TABS;
  return { items: (r.results ?? []).map(toRankItem), tabs, hasMore: Boolean(r.hasMore) };
}

/** 根据详情 tags 推断目录分类（用于"相关短剧"同分类热门兜底） */
function guessCategory(tags: string[]): string {
  if (tags.some((t) => t.includes('漫'))) return 'comic-drama';
  if (tags.some((t) => /ai/i.test(t))) return 'ai-drama';
  return 'real-drama';
}

/** 卡片列表去重（官网推荐载荷同一剧集可能出现多次；React 列表 key 要求唯一） */
function uniqCards(list: RawCard[]): RawCard[] {
  const seen = new Set<string>();
  const out: RawCard[] = [];
  for (const c of list) {
    const key = String(c.series_id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

async function detail(seriesId: string): Promise<DramaDetail> {
  // 详情主数据与官网附加数据（热评/推荐位，原 scraper 方案）并行拉取；附加数据失败不影响主数据
  const [d, extras] = await Promise.all([
    hg.dramaService.getSeriesDetail(String(seriesId)),
    hg.dramaService
      .getWebDetailExtras(String(seriesId))
      .catch((e: unknown) => {
        hg.logger.warn('Adapter', `详情附加数据（热评/推荐）获取失败: ${String((e as Error)?.message ?? e)}`);
        return null;
      }),
  ]);
  const tags = Array.isArray(d.tags) ? d.tags : [];
  // 官网推荐位为空时用同分类热门榜兜底（失败不影响详情主数据）；
  // 推荐载荷可能含重复剧集（且含自身），去重并排除当前剧
  const recCards = uniqCards(extras?.recommendations ?? []).filter(
    (x) => String(x.series_id) !== String(seriesId),
  );
  const recommendations = recCards.length
    ? recCards.map(toCard)
    : await hg.dramaService
        .catalog({ category: guessCategory(tags), page: 1 })
        .then((r) =>
          (r.results ?? [])
            .filter((x) => String(x.series_id) !== String(seriesId))
            .slice(0, 12)
            .map(toCard),
        )
        .catch(() => [] as DramaCard[]);
  const social = d.social_info ?? null;
  const episodes: Episode[] = (d.episodes ?? []).map((ep) => ({
    id: String(ep.vid),
    index: Number(ep.vid_index) || 0,
    title: ep.title || `第 ${ep.vid_index} 集`,
    locked: false,
    playPath: String(ep.vid),
  }));
  return {
    id: d.series_id,
    title: d.series_title,
    coverUrl: d.cover || '',
    totalEpisodes: d.total || episodes.length,
    tags,
    category: [],
    description: d.intro || '',
    accessibleEpisodeCount: episodes.length,
    ratingValue: social?.rating ?? undefined,
    rating: social?.rating != null ? String(social.rating) : undefined,
    heatValue: parseHotValue(social?.hot_text),
    rankInfo: null,
    actors: (d.celebrities ?? [])
      .filter((c) => c?.name)
      .map((c) => ({ id: String(c.actor_id ?? ''), name: String(c.name), role: c.role || '', avatarUrl: c.avatar || '' })),
    episodes,
    // 热评来自官网详情页 SSR 剧评卡片（原 scraper 方案），无数据时页面自动隐藏
    reviews: extras?.reviews ?? [],
    reviewTotal: extras?.reviewTotal ?? 0,
    recommendations,
    hotRecommendations: uniqCards(extras?.hotRecommendations ?? [])
      .filter((x) => String(x.series_id) !== String(seriesId))
      .map(toCard),
  };
}

// ===== 视频流端点（唯一 HTTP 面） =====

let streamBase = '';
/** 流端点鉴权 token（启动时随机生成，路由 /stream/:token/:vid，见 stream-server.js） */
let streamToken = '';
let streamReady: Promise<void> | null = null;
let streamClose: (() => void) | null = null;

/** 启动本地解密流端点；幂等，返回就绪 Promise 供 net:play 等待 */
function ensureStreamServer(): Promise<void> {
  if (!streamReady) {
    streamReady = hg
      .createStreamServer({ streamService: hg.streamService })
      .then((s) => {
        streamBase = `http://127.0.0.1:${s.port}`;
        streamToken = s.token;
        streamClose = s.close;
        hg.logger.info('Stream', `本地解密流端点已启动: ${streamBase}`);
      })
      .catch((err: unknown) => {
        streamReady = null; // 允许下次重试
        throw err;
      });
  }
  return streamReady;
}

/** 播放元信息 + 流地址：先解析一次播放地址（快速失败给出可读错误），再发预取。
 *  nextVid：下一集 id，随本次批量取址一并解析并进入 entryCache，切集时零额外签名请求。
 *  allowHevc：渲染层 HEVC 硬解探测结果（false 时流地址追加 hevc=0，走 H264/转码兜底）。 */
async function resolvePlay(seriesId: string, itemId: string, force?: boolean, nextVid?: string, allowHevc?: boolean): Promise<{ videoUrl: string; format: 'mp4' }> {
  assertId(seriesId, '剧集ID');
  await ensureStreamServer();
  const vid = String(itemId ?? '').trim();
  if (!/^\d{1,30}$/.test(vid)) throw new Error('无效的分集编号');
  const next = String(nextVid ?? '').trim();
  const nextArg = /^\d{1,30}$/.test(next) ? next : '';
  try {
    await hg.dramaService.getPlayInfo(vid, '1080p', nextArg ? { nextVid: nextArg } : {});
  } catch (e) {
    throw new Error(String((e as Error)?.message ?? e) || '未能解析到有效的播放地址');
  }
  // 预取当前集（与 demo 客户端行为一致），失败不影响播放；
  // 流端点侧同时带上 next_vid，播放稳定后由 streamService 二次兜底预取
  try {
    hg.streamService.prefetch(vid, 'auto', true, 45000, nextArg ? [nextArg] : [], allowHevc !== false);
  } catch {
    /* 预取失败由流端点自行兜底 */
  }
  const params: string[] = [];
  if (force) params.push(`refresh=${Date.now()}`);
  if (allowHevc === false) params.push('hevc=0');
  const qs = params.length ? `?${params.join('&')}` : '';
  return { videoUrl: `${streamBase}/stream/${streamToken}/${vid}${qs}`, format: 'mp4' };
}

// ===== 本地持久化（渲染层 zustand stores 用） =====

const DATA_FILE = (): string => join(app.getPath('userData'), 'storage.json');

type StoreData = Record<string, unknown>;
let cache: StoreData | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** 渲染层允许持久化的 storage key 白名单（对应 stores.ts 的 KEY 集合） */
const STORAGE_KEYS = new Set(['favorites', 'history', 'settings', 'searchHistory', 'recommend.impressions.v1', 'recommend.list.v1']);
/** 单键 value 体积上限（序列化后 2MB，防异常大数据撑爆本地存储） */
const STORAGE_VALUE_MAX_BYTES = 2 * 1024 * 1024;

function load(): StoreData {
  if (!cache) {
    const file = DATA_FILE();
    // 主文件缺失/损坏时回读 .bak 备份（与 data-server storeService 相同的恢复策略）
    for (const f of [file, `${file}.bak`]) {
      try {
        const parsed = JSON.parse(readFileSync(f, 'utf-8')) as StoreData;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          cache = parsed;
          break;
        }
      } catch {
        /* 尝试下一个文件 */
      }
    }
    cache ??= {};
  }
  return cache;
}

/** 同步短暂休眠（ms）：renameSync 重试间隔用（主进程内 Atomics.wait 可用） */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Windows 下目标文件可能被杀软/索引服务短暂占用，rename 失败时指数退避重试 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? '';
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(code) || attempt >= 3) throw err;
      sleepSync(25 * 2 ** attempt);
    }
  }
}

/** 立即落盘待写缓存（任务 87）：应用退出时防抖定时器可能未触发，避免最后一次变更丢失 */
function flushPendingStorage(): void {
  if (!saveTimer || !cache) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const file = DATA_FILE();
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(cache), 'utf-8');
    try {
      copyFileSync(file, `${file}.bak`);
    } catch {
      /* 首次写入无旧文件，忽略 */
    }
    renameWithRetry(tmp, file);
  } catch (err) {
    console.error('[hongguo] 退出时本地数据写入失败', err);
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 忽略 */
    }
  }
}

function save(): void {
  if (saveTimer) clearTimeout(saveTimer);
  // 100ms 合并写，避免收藏/历史高频变更时反复落盘
  saveTimer = setTimeout(() => {
    const file = DATA_FILE();
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(app.getPath('userData'), { recursive: true });
      // 原子写：先写临时文件 → 旧数据备份为 .bak → 原子改名覆盖（防止写一半损坏唯一副本）
      writeFileSync(tmp, JSON.stringify(load()), 'utf-8');
      try {
        copyFileSync(file, `${file}.bak`);
      } catch {
        /* 首次写入无旧文件，忽略 */
      }
      renameWithRetry(tmp, file);
    } catch (err) {
      console.error('[hongguo] 本地数据写入失败', err);
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }, 100);
}

/** 校验 storage key 在白名单内（渲染层是不可信边界，防任意键写入/读取） */
function assertStorageKey(key: unknown): string {
  if (typeof key !== 'string' || !STORAGE_KEYS.has(key)) throw new Error('无效的存储键');
  return key;
}

const storagePort = {
  async get<T>(key: string): Promise<T | null> {
    return (load()[assertStorageKey(key)] as T) ?? null;
  },
  async set<T>(key: string, value: T): Promise<void> {
    assertStorageKey(key);
    let json: string;
    try {
      json = JSON.stringify(value) ?? '';
    } catch {
      throw new Error('无效的存储值');
    }
    if (json.length > STORAGE_VALUE_MAX_BYTES) throw new Error('存储内容过大');
    load()[key] = value;
    save();
  },
  async delete(key: string): Promise<void> {
    delete load()[assertStorageKey(key)];
    save();
  },
};

// ===== IPC 入参校验（渲染层是不可信边界：类型/长度/格式白名单） =====

/**
 * 字符串参数校验：必须是 string、长度受控、可选格式白名单；不合法直接抛错。
 * @param v 待校验值
 * @param name 参数名（用于错误提示）
 * @param maxLen 最大长度
 * @param pattern 可选格式白名单（完整匹配）
 * @param allowEmpty 是否允许空串（默认不允许）
 */
function assertStr(v: unknown, name: string, maxLen: number, pattern?: RegExp, allowEmpty = false): string {
  if (
    typeof v !== 'string' ||
    v.length > maxLen ||
    (!allowEmpty && v.length === 0) ||
    (pattern && !pattern.test(v))
  ) {
    throw new Error(`无效的参数: ${name}`);
  }
  return v;
}

/** 可选字符串参数校验：允许 undefined/null（走调用方默认值），其余同 assertStr（允许空串） */
function assertOptional(v: unknown, name: string, maxLen: number, pattern?: RegExp): string | undefined {
  if (v === undefined || v === null) return undefined;
  return assertStr(v, name, maxLen, pattern, true);
}

/** 数字 id 校验（series_id / vid / actor_id 上游均为纯数字字符串，≤30 位） */
function assertId(v: unknown, name: string): string {
  return assertStr(v, name, 30, /^\d{1,30}$/);
}

/** 页码校验：缺省视为 1，必须是 1~10000 整数 */
function assertPage(v: unknown): number {
  const p = v === undefined || v === null ? 1 : v;
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 10000) {
    throw new Error('无效的参数: page');
  }
  return p;
}

// ===== 用户友好错误（面向用户：非开发模式不透出错误码/内部信息） =====

/** 开发模式（dev server 或强制 DevTools）保留原始错误便于调试 */
const isDevMode = (): boolean =>
  Boolean(process.env['ELECTRON_RENDERER_URL']) || process.env['HONGGUO_DEVTOOLS'] === '1';

const NET_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTFOUND',
  'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ERR_NETWORK',
  'ERR_CANCELED', 'ERR_INTERNET_DISCONNECTED',
]);

/** 原始错误 → 用户可读提示（完整原始错误仅记入主进程日志） */
function toUserError(e: unknown): Error {
  const err = e as { code?: string; status?: number; message?: string } | null;
  hg.logger.warn(
    'Ipc',
    `接口错误(原始): code=${err?.code ?? '-'} status=${err?.status ?? '-'} message=${String(err?.message ?? e)}`,
  );
  const code = String(err?.code ?? '');
  const msg = String(err?.message ?? '');
  // 服务层已给出中文用户可读提示（如「列表已过期，请刷新重新加载」）：直接透传，避免笼统文案掩盖根因
  if (/[\u4e00-\u9fff]/.test(msg)) return new Error(msg);
  let text = '加载失败，请稍后重试';
  if (code === 'EMPTY_RESPONSE' || msg.includes('空响应')) text = '视频服务暂时无响应，请稍后重试';
  else if (code === 'RATE_LIMITED' || msg.includes('冷却') || msg.includes('频繁')) text = '操作过于频繁，请稍等片刻再试';
  else if (NET_CODES.has(code)) text = '网络连接失败，请检查网络后重试';
  else if (typeof err?.status === 'number' && err.status >= 400) text = '服务暂时不可用，请稍后重试';
  return new Error(text);
}

/** IPC 处理器包装：开发模式透传原始错误，生产模式统一转为用户友好提示 */
function userFacing<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return async (...args: A): Promise<unknown> => {
    try {
      return await fn(...args);
    } catch (e) {
      throw isDevMode() ? e : toUserError(e);
    }
  };
}

// ===== IPC 注册 =====

export function registerIpc(): void {
  // ===== 数据（userFacing：生产模式错误转为用户友好提示） =====
  ipcMain.handle('net:home', userFacing(() => homeSections()));
  ipcMain.handle('net:search', userFacing((_e, keyword: string) =>
    searchPage(assertStr(keyword, '搜索关键词', 100), 1).then((r) => r.items),
  ));
  // 官网搜索联想（原 scraper 方案）；入参非法或请求失败时降级为空列表，下拉仍保留"查看全部结果"
  ipcMain.handle('net:search-suggest', async (_e, keyword: string) => {
    try {
      return await hg.dramaService.searchSuggest(assertStr(keyword, '搜索关键词', 50));
    } catch (e: unknown) {
      hg.logger.warn('Adapter', `搜索联想失败: ${String((e as Error)?.message ?? e)}`);
      return [] as { kind: 'drama' | 'keyword'; name: string; keyword: string; coverUrl?: string; totalEpisodes?: number; heatText?: string; categories?: string[] }[];
    }
  });
  ipcMain.handle('net:search-page', userFacing((_e, keyword: string, page?: number) =>
    searchPage(assertStr(keyword, '搜索关键词', 100), assertPage(page)),
  ));
  ipcMain.handle('net:category', userFacing((_e, main: string, sub?: string, page?: number) =>
    categoryPage(
      assertStr(main, '分类', 60, /^[a-z0-9_-]{1,60}$/i),
      assertOptional(sub, '子分类', 60, /^[a-z0-9_-]{0,60}$/i),
      assertPage(page),
    ),
  ));
  ipcMain.handle('net:rank', userFacing((_e, rankKey: string, page?: number) =>
    rankPage(assertStr(rankKey, '榜单', 60, /^[a-z0-9_-]{1,60}$/i), assertPage(page)),
  ));
  ipcMain.handle('net:detail', userFacing((_e, seriesId: string) => detail(assertId(seriesId, '剧集ID'))));
  // ===== 登录态（x-tt-token）：匿名配额（约 9 集）的分水岭，见风控分析文档 L3 =====
  ipcMain.handle('net:auth-get', userFacing(async () => hg.loginState.getLoginState()));
  ipcMain.handle('net:auth-set', userFacing(async (_e, raw: string) => {
    // token 长度受控（任务 87）：x-tt-token 实际数百字节，4096 已宽裕，防异常超大串落盘
    assertStr(raw, 'token', 4096);
    return hg.loginState.setToken(raw);
  }));
  ipcMain.handle('net:auth-clear', userFacing(async () => {
    hg.loginState.clearToken();
    return true;
  }));
  // 验证码自动登录：发码（回 mobile_ticket）+ 验证码换登录态（token 写入 login-state）
  ipcMain.handle('net:login-send-code', userFacing(async (_e, mobile: string) => {
    // 手机号：可选 + 前缀 + 4~20 位数字（任务 87）
    assertStr(mobile, 'mobile', 20, /^\+?\d{4,20}$/);
    return hg.login.sendSmsCode(mobile);
  }));
  ipcMain.handle('net:login-submit', userFacing(async (_e, mobile: string, code: string, ticket?: string) => {
    assertStr(mobile, 'mobile', 20, /^\+?\d{4,20}$/);
    // 验证码：4~16 位数字或字母组合（任务 87）
    assertStr(code, 'code', 16, /^[A-Za-z0-9]{4,16}$/);
    // mobile_ticket：上游回传的长串，4096 上限（任务 87）
    assertOptional(ticket, 'ticket', 4096);
    return hg.login.loginWithCode(mobile, code, ticket ?? '');
  }));
  // ===== 账号（官网扫码登录 + 账号域云同步）：凭据在 account_session 持久化，
  // 扫码成功后 Cookie 同步写入 login-state（播放链路自动携带）。
  // 此处把 server 层 snake_case 返回适配为渲染层 camelCase 契约 =====
  const acctStr = (v: unknown): string => (typeof v === 'string' ? v : '');
  const acctUser = (u: unknown): { userId: string; name: string; avatar?: string } | null => {
    const o = u as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') return null;
    const user = { userId: acctStr(o.user_id ?? o.user_id_str), name: acctStr(o.name ?? o.screen_name) };
    const avatar = acctStr(o.avatar_url ?? o.avatar);
    return { ...user, ...(avatar ? { avatar } : {}) };
  };
  ipcMain.handle('net:account-status', userFacing(async () => {
    const s = hg.account.status();
    let user = s.logged_in ? acctUser(s.user) : null;
    // 登录凭据缓存里没有头像时补拉一次资料（/reading/user/info/v1/）
    if (user && !user.avatar) {
      try {
        const p = await hg.account.profile();
        if (p?.success && p.user) {
          const fresh = acctUser(p.user);
          if (fresh) user = { ...user, name: fresh.name || user.name, ...(fresh.avatar ? { avatar: fresh.avatar } : {}) };
        }
      } catch { /* 头像补拉失败不阻塞状态查询 */ }
    }
    return { loggedIn: Boolean(s.logged_in), user, savedAt: null };
  }));
  ipcMain.handle('net:account-login-start', userFacing(async () => {
    const s = await hg.account.startLogin();
    if (!s?.success || !s.token || !s.qrcode) throw new Error(s?.notice || '二维码获取失败，请稍后重试');
    return {
      token: s.token,
      qrcode: s.qrcode,
      expiresInSec: s.expire_at ? Math.max(20, Math.round((Number(s.expire_at) - Date.now()) / 1000)) : 60,
    };
  }));
  ipcMain.handle('net:account-login-poll', userFacing(async (_e, token: string) => {
    if (typeof token !== 'string') throw new Error('无效的参数: token');
    const r = await hg.account.pollLogin(token);
    if (!r?.success) throw new Error(r?.notice || '扫码状态查询失败，请稍后重试');
    const status = r.status === 'confirmed' ? 'confirmed'
      : r.status === 'expired' ? 'expired'
        : r.scanned ? 'scanned' : 'pending';
    return { status, user: r.user ? acctUser(r.user) ?? undefined : undefined };
  }));
  ipcMain.handle('net:account-logout', userFacing(async () => {
    const r = await hg.account.logout();
    return Boolean(r?.success);
  }));
  ipcMain.handle('net:account-history', userFacing(async () => {
    const r = await hg.account.history();
    if (!r?.success) throw new Error(r?.notice || r?.error || '云端播放进度获取失败');
    const items = Array.isArray(r.items) ? r.items : [];
    return items.map((it: Record<string, unknown>) => ({
      seriesId: acctStr(it.series_id),
      vid: acctStr(it.vid),
      seriesTitle: acctStr(it.title),
      vidIndex: Math.max(1, Number(it.episode_index) || 1),
      episodeCnt: Number(it.episode_count) || undefined,
      positionMs: Number(it.position_ms) || 0,
      durationMs: Number(it.duration_ms) || undefined,
      lastWatchTime: Number(it.watched_at) || Date.now(),
      coverUrl: acctStr(it.cover) || undefined,
    }));
  }));
  ipcMain.handle('net:account-favorites', userFacing(async () => {
    const r = await hg.account.favorites();
    if (!r?.success) throw new Error(r?.notice || r?.error || '云端收藏获取失败');
    const items = Array.isArray(r.items) ? r.items : [];
    return items.map((it: Record<string, unknown>) => ({
      seriesId: acctStr(it.series_id),
      title: acctStr(it.title),
      coverUrl: acctStr(it.cover) || undefined,
      episodeCnt: Number(it.episode_count) || undefined,
      favoritedAt: Number(it.favorited_at) || Date.now(),
    }));
  }));
  ipcMain.handle('net:account-favorite-set', userFacing(async (_e, seriesId: string, add: boolean) => {
    if (typeof seriesId !== 'string' || !seriesId) throw new Error('无效的参数: seriesId');
    if (typeof add !== 'boolean') throw new Error('无效的参数: add');
    const r = await hg.account.setFavorite(seriesId, add);
    // 未登录按 no-op（渲染层无需关心登录态）；真失败上抛中文错误
    if (!r?.success) {
      if (r?.need_login) return false;
      throw new Error(r?.error || '收藏同步失败，请稍后重试');
    }
    return true;
  }));
  ipcMain.handle('net:account-report-progress', userFacing(async (_e, p: unknown) => {
    if (!p || typeof p !== 'object') throw new Error('无效的参数: progress');
    const r = p as Record<string, unknown>;
    const reqStr = (v: unknown, name: string) => {
      if (typeof v !== 'string' || !v) throw new Error(`无效的参数: ${name}`);
      return v;
    };
    const reqNum = (v: unknown, name: string) => {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`无效的参数: ${name}`);
      return v;
    };
    const optNum = (v: unknown, name: string) => {
      if (v === undefined) return undefined;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`无效的参数: ${name}`);
      return v;
    };
    const out = await hg.account.reportProgress({
      seriesId: reqStr(r.seriesId, 'seriesId'),
      vid: reqStr(r.vid, 'vid'),
      episodeIndex: reqNum(r.episodeIndex, 'episodeIndex'),
      positionSec: reqNum(r.positionSec, 'positionSec'),
      durationSec: optNum(r.durationSec, 'durationSec'),
      episodeCount: optNum(r.episodeCount, 'episodeCount'),
    });
    // 未登录 / 参数无效按 no-op 处理（渲染层无需关心登录态）
    if (!out?.success) return false;
    return true;
  }));
  ipcMain.handle('net:play', userFacing((_e, seriesId: string, itemId: string, force?: boolean, nextVid?: string, allowHevc?: boolean) => {
    if (force !== undefined && typeof force !== 'boolean') throw new Error('无效的参数: force');
    if (nextVid !== undefined && typeof nextVid !== 'string') throw new Error('无效的参数: nextVid');
    if (allowHevc !== undefined && typeof allowHevc !== 'boolean') throw new Error('无效的参数: allowHevc');
    return resolvePlay(seriesId, itemId, force, nextVid, allowHevc);
  }));
  // 下一集整集预解密（无感切换）：幂等后台任务，失败静默（播放侧自会走常规流式兜底）
  ipcMain.handle('net:stream-prefetch', userFacing(async (_e, vid: string, allowHevc?: boolean) => {
    assertId(vid, '分集ID');
    if (allowHevc !== undefined && typeof allowHevc !== 'boolean') throw new Error('无效的参数: allowHevc');
    hg.streamService.prefetchNext(vid, 'auto', allowHevc !== false);
    return true;
  }));
  // 重置播放设备（播放页连续失败后的恢复手段）：重新注册全新匿名设备并作废旧设备缓存
  ipcMain.handle('net:device-reset', userFacing(async () => {
    const r = await hg.resetDevice();
    hg.logger.info('Ipc', `播放设备已重置: device_id=${r.device_id}, iid=${r.iid}`);
    return r;
  }));
  // 弹幕（官方签名接口；fetchDanmaku 不抛错，异常统一转为 success:false + 中文说明）
  ipcMain.handle('net:danmaku', (_e, seriesId: string, itemId: string, fresh?: boolean) =>
    hg.danmaku.fetchDanmaku({
      seriesId: assertId(seriesId, '剧集ID'),
      vid: assertId(itemId, '分集ID'),
      fresh: fresh === true,
    }),
  );

  // ===== 剧星榜（演员，userFacing 同上） =====
  ipcMain.handle(
    'actors:ranking',
    userFacing((_e, page?: number, gender?: string): Promise<{ items: ActorCard[]; hasMore: boolean; rankDate: string }> =>
      hg.dramaService.getActorRankings({ page: assertPage(page), gender: assertOptional(gender, '性别', 20, /^[a-z]{0,20}$/i) || undefined }).then((r) => ({
        items: (r.actors ?? []).map((a) => ({
          id: String(a.actor_id),
          name: String(a.name ?? ''),
          avatarUrl: a.avatar || '',
          rank: a.rank,
          score: a.score != null ? String(a.score) : '',
          subTitles: Array.isArray(a.sub_titles) ? a.sub_titles.map(String) : [],
          rankChange: a.rank_change
            ? { type: Number(a.rank_change.type) || 3, num: Number(a.rank_change.num ?? a.rank_change.ChangeNum) || 0 }
            : undefined,
          intro: a.intro || '',
        })),
        hasMore: Boolean(r.hasMore),
        // 榜单统计日期（上游协议 rank_date，如 "2026-11-09"）
        rankDate: String(r.rank_date ?? ''),
      })),
    ),
  );
  ipcMain.handle('actors:detail', userFacing((_e, actorId: string): Promise<ActorDetail> =>
    hg.dramaService.getActorDetail(assertId(actorId, '演员ID')).then((r) => {
      const a = r.actor ?? {};
      return {
        id: String(a.actor_id ?? actorId),
        name: String(a.name ?? ''),
        avatarUrl: a.avatar || '',
        intro: a.intro || '',
        related: (a.related_celebrities ?? [])
          .map((c) => ({
            id: String(c.actor_id ?? c.celebrity_id ?? ''),
            name: String(c.name ?? c.nickname ?? ''),
            avatarUrl: c.avatar || '',
          }))
          .filter((c) => /^\d+$/.test(c.id) && c.name),
      };
    }),
    ),
  );
  ipcMain.handle('actors:works', userFacing((_e, actorId: string, page?: number) => {
    const p = assertPage(page);
    const count = 20;
    return hg.dramaService.getActorWorks(assertId(actorId, '演员ID'), { count, offset: (p - 1) * count }).then((r) => ({
      items: (r.works ?? []).map(toCard),
      hasMore: Boolean(r.has_more),
      total: r.total_count ?? 0,
    }));
  }));

  // ===== 存储 =====
  ipcMain.handle('storage:get', (_e, key: string) => storagePort.get(key));
  ipcMain.handle('storage:set', (_e, key: string, value: unknown) => storagePort.set(key, value));
  ipcMain.handle('storage:delete', (_e, key: string) => storagePort.delete(key));

  // ===== 窗口控制（无边框标题栏 + 托盘/关闭确认，见 window.ts） =====
  registerWindowIpc();

  /** 播放器独立窗口（无边框）：全局单例，已存在时切集 */
  ipcMain.handle('win:openPlayer', (_e, seriesId: string, itemId: string) => {
    createPlayerWindow(assertId(seriesId, '剧集ID'), assertId(itemId, '分集ID'));
  });

  /** 沉浸式初始化：窗口尺寸按视频宽高比计算一次（ratio = videoWidth / videoHeight）。
   *  比例仅用于初始化，不锁定拖拽（不调用 setAspectRatio），用户可自由调整窗口大小。
   *  每个窗口只 fit 一次：切下一集时即使分辨率/比例有细微差异也不改尺寸、不居中，
   *  窗口位置固定在用户移动后的位置。横屏（ratio ≥ 1）高度沿用当前、宽度 = 高 × 比例
   *  （最小宽 711px = 400 高 × 16/9）；竖屏（ratio < 1）宽度取下限 400px、高度 = 宽 ÷ 比例
   *  （9:16 即 711px），不超过工作区。 */
  const fittedWins = new WeakSet<BrowserWindow>();
  ipcMain.handle('win:fitToVideo', (e, ratio: number) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || !Number.isFinite(ratio) || ratio <= 0) return false;
    // 已初始化过：什么都不做（保留用户调整后的尺寸与位置）
    if (fittedWins.has(win)) return true;
    fittedWins.add(win);
    const minW = Math.max(400, Math.round(400 * ratio)); // 横屏 16:9 → 711；竖屏 → 400
    let width: number;
    let height: number;
    if (ratio >= 1) {
      height = win.getContentSize()[1];
      width = Math.round(Math.min(1280, Math.max(minW, height * ratio)));
    } else {
      width = minW;
      // 以窗口实际所在显示器的工作区为基准（任务 87：副屏分辨率/缩放可能与主屏不同）
      const workH = screen.getDisplayMatching(win.getBounds()).workAreaSize.height;
      height = Math.round(Math.min(workH - 40, Math.max(400, width / ratio)));
    }
    win.setMinimumSize(Math.min(minW, width), 400);
    const prev = win.getContentSize();
    win.setContentSize(width, height);
    if (prev[0] !== width || prev[1] !== height) win.center();
    return true;
  });

  // ===== 应用设置 =====
  ipcMain.handle('app:setLoginItem', (_e, openAtLogin: boolean) => {
    app.setLoginItemSettings({ openAtLogin });
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle('app:getLoginItem', () => app.getLoginItemSettings().openAtLogin);

  /** 应用版本（package.json version，由 electron-builder 注入产物） */
  ipcMain.handle('app:getVersion', () => app.getVersion());

  /**
   * 用系统默认浏览器打开外部链接。
   * @param {string} url - 目标链接，仅允许 https: 协议（防任意协议命令执行）。
   * @returns {Promise<boolean>} 是否已打开。
   */
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (typeof url !== 'string' || !url.startsWith('https://')) return false;
    // openExternal 可能因系统默认浏览器异常 reject（任务 87），捕获记日志避免 unhandled rejection
    shell.openExternal(url).catch((err: unknown) => {
      hg.logger.warn('Ipc', `外部链接打开失败: ${String((err as Error)?.message ?? err)} url=${url}`);
    });
    return true;
  });

  // 退出前关闭流端点 + 强制落盘待写存储（任务 87：防抖写盘可能未触发）
  app.on('will-quit', () => {
    streamClose?.();
    flushPendingStorage();
  });
}
