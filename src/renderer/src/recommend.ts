import {
  buildProfile,
  RecommendationFeed,
  type BehaviorSignal,
  type FeedSource,
  type RecommendCandidate,
  type ScoredCandidate,
  type UserProfile,
} from './recommend-engine';
import { api } from './api';
import { historyStore, favoritesStore } from './stores';

/**
 * 桌面端推荐接入（渲染层适配 @hongguo/core 推荐算法，不改动 packages 核心）：
 * - 数据源：App 端目录/榜单协议经 IPC（渲染层无法直连外站，CORS 限制）；
 * - 画像：观看历史（看完度×时间衰减）+ 收藏（强兴趣）+ 近期历史详情补全标签；
 * - Feed：分类轮转 + 探索槽 + 会话去重 + 跨会话冷却（impressions 持久化）；
 * - 详情补全：仅对缺热度的前 3 个候选调 getDetail（并发受限，失败保持原样）。
 */

/** 跨会话冷却记录持久化 key / 上限 / 冷却时长 */
const IMPRESSIONS_KEY = 'recommend.impressions.v1';
const IMPRESSIONS_MAX = 500;
const IMPRESSION_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** 画像信号补全：最多补全的近期历史条数（详情接口较重，宁少勿多） */
const SIGNAL_ENRICH_LIMIT = 5;
/** 详情补全单次并发上限 */
const ENRICH_CONCURRENCY = 3;

/** 详情标签补全会话级缓存（id → tags/category），避免重复请求 */
const signalTagCache = new Map<string, { tags: string[]; category?: string }>();

/** 详情请求 in-flight 去重（画像补全与候选补全可能同时请求同一部剧） */
const detailInflight = new Map<string, Promise<Awaited<ReturnType<typeof api.getDetail>> | null>>();

/**
 * 详情请求去重封装：同一 seriesId 的并发请求共享同一 Promise，失败返回 null。
 * @param {string} id - 剧集 seriesId
 * @returns {Promise<Awaited<ReturnType<typeof api.getDetail>> | null>} 详情（失败为 null）
 */
function fetchDetailOnce(id: string): Promise<Awaited<ReturnType<typeof api.getDetail>> | null> {
  let p = detailInflight.get(id);
  if (!p) {
    p = api
      .getDetail(id)
      .catch(() => null)
      .finally(() => detailInflight.delete(id));
    detailInflight.set(id, p);
  }
  return p;
}

/**
 * App 端目录/榜单协议 → 推荐候选（FeedSource 适配）。
 * 分类候选不带热度（heat 由详情补全或按未知 0.5 处理）；榜单候选自带热度/评分。
 */
class IpcFeedSource implements FeedSource {
  /** 热门榜翻页游标（探索槽防同页堆叠；见 getHotCandidates 注释） */
  private hotPage = 1;

  /**
   * 取一个分类的候选（page 游标由 feed 内部维护）。
   * @param {string} main - 主分类 key（hot-drama / real-drama / comic-drama / ai-drama）
   * @param {string|undefined} sub - 题材子分类 slug（当前不用）
   * @param {number} page - 页码（1 起）
   * @returns {Promise<RecommendCandidate[]>} 候选列表（失败由 feed 捕获退避）
   */
  async getCategoryCandidates(main: string, sub: string | undefined, page: number): Promise<RecommendCandidate[]> {
    const res = await api.getCategory(main, sub, page);
    return (res.items ?? []).map(
      (d): RecommendCandidate => ({
        id: d.id,
        title: d.title,
        coverUrl: d.coverUrl,
        totalEpisodes: d.totalEpisodes ?? null,
        tags: d.tags ?? [],
        category: main,
        kind: d.kind,
      }),
    );
  }

  /**
   * 热门榜单候选（冷启动 / 探索槽）。
   * 内部自维护翻页游标：探索槽接口（FeedSource.getHotCandidates）无 page 参数，
   * 若每次都取第 1 页，同一候选会在 feed 缓冲区反复堆叠（core 仅对已发出项去重）；
   * 空页时回到第 1 页从头轮换（feed 对空结果按槽位耗尽处理，无副作用）。
   * @returns {Promise<RecommendCandidate[]>} 热播榜条目（含 heatValue/scoreValue）
   */
  async getHotCandidates(): Promise<RecommendCandidate[]> {
    const res = await api.getRank('hot-drama', this.hotPage);
    const items = res.items ?? [];
    this.hotPage = items.length === 0 ? 1 : this.hotPage + 1;
    return (items ?? []).map(
      (r): RecommendCandidate => ({
        id: r.id,
        title: r.title,
        coverUrl: r.coverUrl,
        totalEpisodes: r.totalEpisodes ?? null,
        tags: r.tags ?? [],
        category: 'hot-drama',
        kind: 'drama',
        heatValue: r.heatValue,
        ratingValue: r.scoreValue,
      }),
    );
  }
}

/**
 * 有限并发执行异步任务。
 * @param {T[]} items - 任务输入
 * @param {(item: T) => Promise<void>} task - 单项任务（内部自行捕获异常）
 */
async function runWithConcurrency<T>(items: T[], task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(ENRICH_CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await task(item);
    }
  });
  await Promise.all(workers);
}

/**
 * 详情补全热度/评分（feed 终选回调）：仅补缺热度的前 3 个候选，失败保持原样。
 * @param {RecommendCandidate[]} items - 终选池候选
 * @returns {Promise<RecommendCandidate[]>} 补全后的候选（新对象，不改入参引用）
 */
async function enrichItems(items: RecommendCandidate[]): Promise<RecommendCandidate[]> {
  const need = items.filter((it) => it.heatValue == null && it.ratingValue == null).slice(0, 3);
  if (need.length === 0) return items;
  const updates = new Map<string, Partial<RecommendCandidate>>();
  await runWithConcurrency(need, async (it) => {
    try {
      const d = await fetchDetailOnce(it.id);
      if (!d) return;
      const patch: Partial<RecommendCandidate> = {};
      if (d.heatValue != null) patch.heatValue = d.heatValue;
      if (d.ratingValue != null) patch.ratingValue = d.ratingValue;
      if (d.tags?.length && it.tags.length === 0) patch.tags = d.tags.slice(0, 6);
      if (Object.keys(patch).length > 0) updates.set(it.id, patch);
    } catch {
      /* 补全失败保持原样（热度按未知 0.5 计） */
    }
  });
  if (updates.size === 0) return items;
  return items.map((it) => (updates.has(it.id) ? { ...it, ...updates.get(it.id) } : it));
}

/**
 * 构建行为信号：历史条目（看完度信号）+ 收藏（强兴趣）；近期历史补全标签提升画像质量。
 * @returns {Promise<BehaviorSignal[]>} 画像输入信号
 */
async function buildSignals(): Promise<BehaviorSignal[]> {
  const entries = historyStore.getState().entries;
  const signals: BehaviorSignal[] = entries.map((e) => ({
    dramaId: e.dramaId,
    episodeIndex: e.episodeIndex,
    totalEpisodes: e.totalEpisodes,
    updatedAt: e.updatedAt,
  }));
  // 收藏视为强兴趣（tags 来自收藏卡片）
  const favs = favoritesStore.getState().items;
  for (const [id, card] of Object.entries(favs)) {
    signals.push({
      dramaId: id,
      tags: card.tags ?? [],
      episodeIndex: 1,
      favorite: true,
      updatedAt: Date.now(),
    });
  }
  // 近期历史补全 tags/category（桌面历史条目未落 tags，画像分类/标签权重靠收藏与近期补全）
  const need = entries.filter((e) => !signalTagCache.has(e.dramaId)).slice(0, SIGNAL_ENRICH_LIMIT);
  await runWithConcurrency(need, async (e) => {
    try {
      const d = await fetchDetailOnce(e.dramaId);
      if (!d) {
        signalTagCache.set(e.dramaId, { tags: [] });
        return;
      }
      signalTagCache.set(e.dramaId, { tags: d.tags ?? [], category: d.category?.[0] });
    } catch {
      signalTagCache.set(e.dramaId, { tags: [] });
    }
  });
  for (const s of signals) {
    const hit = signalTagCache.get(s.dramaId);
    if (hit) {
      if (hit.tags.length > 0) s.tags = hit.tags;
      if (hit.category) s.category = hit.category;
    }
  }
  return signals;
}

let impressionsLoaded = false;

/**
 * 加载跨会话冷却记录（首次调用时从主进程 JSON 存储读取）。
 * @param {RecommendationFeed} feed - 目标 feed
 */
async function loadImpressions(feed: RecommendationFeed): Promise<void> {
  if (impressionsLoaded) return;
  impressionsLoaded = true;
  try {
    const saved = await api.storage.get<Record<string, number>>(IMPRESSIONS_KEY);
    if (saved) feed.setImpressions(new Map(Object.entries(saved)));
  } catch {
    /* 冷却记录读取失败按无冷却处理 */
  }
}

/** 持久化冷却记录（超出上限保留最新；失败静默） */
function saveImpressions(map: ReadonlyMap<string, number>): void {
  const entries = [...map].slice(-IMPRESSIONS_MAX);
  void api.storage.set(IMPRESSIONS_KEY, Object.fromEntries(entries)).catch(() => { });
}

let feed: RecommendationFeed | null = null;

/**
 * 确保推荐 feed 就绪：重建画像（信号补全有缓存，开销小）并加载冷却记录。
 * @returns {Promise<RecommendationFeed>} 就绪的推荐 feed
 */
async function ensureFeed(): Promise<RecommendationFeed> {
  const signals = await buildSignals();
  const profile: UserProfile = buildProfile(signals, { preferredCategories: [] });
  if (!feed) {
    feed = new RecommendationFeed(
      new IpcFeedSource(),
      profile,
      { batchSize: 3, impressionCooldownMs: IMPRESSION_COOLDOWN_MS },
      {
        enrich: enrichItems,
        // 惰性取值：历史条目变化即时生效（看过的剧不再推荐）
        excluded: () => new Set(historyStore.getState().entries.map((e) => e.dramaId)),
      },
    );
  } else {
    feed.updateProfile(profile);
  }
  await loadImpressions(feed);
  return feed;
}

/**
 * 取下一批推荐（首页 banner 与「猜你喜欢」共用同一 feed，会话内天然互不重复）。
 * 探索槽模式下 feed 缓冲区可能堆叠同一候选的重复拷贝（core 只对已发出项去重，
 * 不对已缓冲项去重），故这里按 id 跨轮去重并多轮补齐到目标数量。
 * @param {number} count - 期望部数
 * @returns {Promise<ScoredCandidate[]>} 推荐候选（失败返回空数组，首页降级为原分区头部）
 */
export async function fetchRecommendations(count: number): Promise<ScoredCandidate[]> {
  try {
    const f = await ensureFeed();
    const out: ScoredCandidate[] = [];
    const seen = new Set<string>();
    // 最多 3 轮：每轮发出项会进 feed 的 sessionSeen，重复候选被滤掉后 feed 会拉新批次
    for (let round = 0; round < 3 && out.length < count; round++) {
      const items = await f.next(count - out.length + 4);
      if (items.length === 0) break;
      for (const it of items) {
        if (!seen.has(it.id)) {
          seen.add(it.id);
          out.push(it);
        }
      }
    }
    saveImpressions(f.getImpressions());
    return out.slice(0, count);
  } catch {
    return [];
  }
}
