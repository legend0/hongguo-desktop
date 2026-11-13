/**
 * 推荐 Feed（消费驱动 + 风控节奏）：
 * - 分类轮转：喜欢分类按画像权重排序成计划队列，每成功取一批就轮转到队尾，天然避免同分类连刷；
 * - 批量拉取：一次只拉一个分类的 batchSize（2-3）部高匹配候选；
 * - 惰性预取：缓冲剩余 <= refillAt 部（即用户切到该批第三部时）才后台预取下一批，不阻塞当前返回；
 * - 失败退避：某分类拉取失败后 5 分钟内跳过，改试下一个槽位；
 * - 去重：会话内不重复 + 跨会话推荐冷却（impressions）。
 */
import { scoreCandidate, type ScoreOptions, type ScoreWeights } from './scoring';
import type { RecommendCandidate, ScoredCandidate, UserProfile } from './types';

/** 特殊槽位：热门榜单（冷启动 / 探索） */
export const EXPLORE_SLOT = '__explore__';

export interface FeedConfig {
  /** 每个分类批次取多少部（2-3），默认 3 */
  batchSize?: number;
  /** 缓冲剩余多少部时后台预取下一批，默认 1（用户切到第三部时触发） */
  refillAt?: number;
  /** 探索比例 0-1：热门榜批次间隔，默认 0.25（每 4 批 1 个探索槽） */
  exploreRatio?: number;
  /** 分类拉取失败退避 ms，默认 5 分钟 */
  retryBackoffMs?: number;
  /** 打分权重 */
  weights?: Partial<ScoreWeights>;
  /** 跨会话推荐冷却 ms，默认 24h */
  impressionCooldownMs?: number;
  /** 终选前参与详情补全的候选池大小，默认 12 */
  poolSize?: number;
}

export interface FeedSource {
  /** 取一个分类的候选（page 由 feed 内部翻页游标维护） */
  getCategoryCandidates(main: string, sub: string | undefined, page: number): Promise<RecommendCandidate[]>;
  /** 热门榜单候选（冷启动 / 探索槽） */
  getHotCandidates(): Promise<RecommendCandidate[]>;
}

export interface FeedCallbacks {
  /** 终选批次补全热度/评分（服务层用 getDetail 实现，可选） */
  enrich?: (items: RecommendCandidate[]) => Promise<RecommendCandidate[]>;
  /** 不可推荐的剧（如已在历史中）；支持惰性取值 */
  excluded?: ReadonlySet<string> | (() => ReadonlySet<string>);
}

export class RecommendationFeed {
  private readonly cfg: Required<Omit<FeedConfig, 'weights'>> & { weights: Partial<ScoreWeights> };
  private buffer: ScoredCandidate[] = [];
  private plan: string[] = [];
  private pages = new Map<string, number>();
  private backoffUntil = new Map<string, number>();
  private impressions = new Map<string, number>();
  private sessionSeen = new Set<string>();
  private recentCategories: string[] = [];
  private fetching: Promise<void> | null = null;

  constructor(
    private readonly source: FeedSource,
    private profile: UserProfile,
    cfg: FeedConfig = {},
    private readonly callbacks: FeedCallbacks = {},
  ) {
    this.cfg = {
      batchSize: cfg.batchSize ?? 3,
      refillAt: cfg.refillAt ?? 1,
      exploreRatio: cfg.exploreRatio ?? 0.25,
      retryBackoffMs: cfg.retryBackoffMs ?? 5 * 60_000,
      impressionCooldownMs: cfg.impressionCooldownMs ?? 24 * 3_600_000,
      poolSize: cfg.poolSize ?? 12,
      weights: cfg.weights ?? {},
    };
    this.rebuildPlan();
  }

  /** 画像更新（看完新剧 / 改喜欢分类）后重建计划 */
  updateProfile(profile: UserProfile): void {
    this.profile = profile;
    this.rebuildPlan();
  }

  /** 跨会话冷却记录（持久化由调用方负责） */
  setImpressions(map: Map<string, number>): void {
    this.impressions = map;
  }

  getImpressions(): ReadonlyMap<string, number> {
    return this.impressions;
  }

  /**
   * 取下一部推荐。
   * 缓冲不够时同步补批；返回后若剩余 <= refillAt 则后台预取下一批（不阻塞）。
   */
  async next(count = 1): Promise<ScoredCandidate[]> {
    await this.ensureBuffer(count);
    const out = this.buffer.splice(0, count);
    const now = Date.now();
    for (const it of out) {
      this.sessionSeen.add(it.id);
      this.impressions.set(it.id, now);
      if (it.category && it.category !== this.recentCategories[0]) {
        this.recentCategories = [it.category, ...this.recentCategories].slice(0, 3);
      }
    }
    if (this.buffer.length <= this.cfg.refillAt) {
      void this.ensureBuffer(this.cfg.batchSize);
    }
    return out;
  }

  private async ensureBuffer(n: number): Promise<void> {
    while (this.buffer.length < n) {
      const before = this.buffer.length;
      if (!this.fetching) {
        this.fetching = this.fillBatch().finally(() => { this.fetching = null; });
      }
      await this.fetching;
      // 所有来源耗尽或全部失败 → 放弃本次补齐，避免死循环
      if (this.buffer.length === before) return;
    }
  }

  /** 拉取一个槽位（分类 / 探索）的批次；成功则轮转回队尾 */
  private async fillBatch(): Promise<void> {
    if (!this.plan.length) this.rebuildPlan();
    while (this.plan.length) {
      const slot = this.plan.shift()!;
      if (Date.now() < (this.backoffUntil.get(slot) ?? 0)) continue;
      try {
        const cands = await this.fetchSlot(slot);
        const picked = await this.selectFrom(slot, cands);
        if (picked.length) {
          this.buffer.push(...picked);
          this.plan.push(slot);
          return;
        }
        // 空结果 → 不回置，继续下一槽位
      } catch {
        this.backoffUntil.set(slot, Date.now() + this.cfg.retryBackoffMs);
      }
    }
    this.rebuildPlan();
  }

  private fetchSlot(slot: string): Promise<RecommendCandidate[]> {
    const page = this.pages.get(slot) ?? 1;
    const p = slot === EXPLORE_SLOT
      ? this.source.getHotCandidates()
      : this.source.getCategoryCandidates(slot, undefined, page);
    return p.then((items) => {
      if (items.length) this.pages.set(slot, page + 1);
      return items;
    });
  }

  /** 计划：喜欢分类按画像权重排序，探索槽按 exploreRatio 间隔插入 */
  private rebuildPlan(): void {
    const cats = Object.entries(this.profile.categoryWeights)
      .filter(([, w]) => w > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
    const gap = Math.max(1, Math.round(1 / this.cfg.exploreRatio));
    const plan: string[] = [];
    let ci = 0;
    while (ci < cats.length) {
      for (let i = 0; i < gap && ci < cats.length; i++) plan.push(cats[ci++]);
      plan.push(EXPLORE_SLOT);
    }
    this.plan = plan.length ? plan : [EXPLORE_SLOT];
  }

  /** 批内终选：过滤 → 初选 poolSize → 补全 → 重打分 → 取 batchSize */
  private async selectFrom(slot: string, cands: RecommendCandidate[]): Promise<ScoredCandidate[]> {
    const excluded = typeof this.callbacks.excluded === 'function'
      ? this.callbacks.excluded()
      : this.callbacks.excluded;
    const now = Date.now();
    const pool = cands.filter((c) =>
      c.kind !== 'comic' &&
      !this.sessionSeen.has(c.id) &&
      !excluded?.has(c.id) &&
      !(this.impressions.get(c.id) != null &&
        now - this.impressions.get(c.id)! < this.cfg.impressionCooldownMs),
    );
    if (!pool.length) return [];

    const withCategory = (c: RecommendCandidate): RecommendCandidate =>
      c.category || slot === EXPLORE_SLOT ? c : { ...c, category: slot };
    const rank = (list: RecommendCandidate[]) =>
      list
        .map((c) => ({ c, s: scoreCandidate(withCategory(c), this.profile, this.scoreOpts()) }))
        .sort((a, b) => b.s.total - a.s.total);

    let finals = rank(pool).slice(0, this.cfg.poolSize).map((x) => x.c);
    if (this.callbacks.enrich) {
      try {
        finals = await this.callbacks.enrich(finals);
      } catch {
        // 补全失败用原始候选继续
      }
    }

    const picked: ScoredCandidate[] = [];
    for (const { c, s } of rank(finals)) {
      if (picked.length >= this.cfg.batchSize) break;
      if (this.sessionSeen.has(c.id) || excluded?.has(c.id)) continue;
      picked.push({ ...withCategory(c), score: s });
    }
    return picked;
  }

  private scoreOpts(): ScoreOptions {
    return {
      weights: this.cfg.weights,
      impressions: this.impressions,
      impressionCooldownMs: this.cfg.impressionCooldownMs,
      recentCategories: this.recentCategories,
    };
  }
}
