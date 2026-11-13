/**
 * 候选打分：加权求和（偏好/热度/质量） × 惩罚因子（推荐冷却 / 分类多样性）。
 */
import type { CandidateScore, RecommendCandidate, UserProfile } from './types';

export interface ScoreWeights {
  /** 偏好匹配（分类 + 标签） */
  preference: number;
  /** 影片热度 */
  heat: number;
  /** 评分质量 */
  quality: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = { preference: 0.55, heat: 0.3, quality: 0.15 };

/** 热度归一对数上限（站点热度以万为单位，峰值约 4000 万） */
const HEAT_LOG_MAX = Math.log1p(4000);

export interface ScoreOptions {
  weights?: Partial<ScoreWeights>;
  /** id → 最近一次被推荐的时间戳（冷却去重） */
  impressions?: ReadonlyMap<string, number>;
  /** 冷却时长，默认 24h */
  impressionCooldownMs?: number;
  /** 最近 feed 已出现的分类（多样性惩罚） */
  recentCategories?: string[];
  now?: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function scoreCandidate(
  c: RecommendCandidate,
  profile: UserProfile,
  opts: ScoreOptions = {},
): CandidateScore {
  const w = { ...DEFAULT_WEIGHTS, ...opts.weights };
  const now = opts.now ?? Date.now();
  const cooldownMs = opts.impressionCooldownMs ?? 24 * 3_600_000;

  // 偏好匹配：主分类权重 60% + 标签命中 40%（2 个高权重标签即满分）
  const catW = c.category ? (profile.categoryWeights[c.category] ?? 0) : 0;
  let tagSum = 0;
  for (const t of (c.tags ?? []).slice(0, 4)) tagSum += profile.tagWeights[t] ?? 0;
  const preference = clamp01(0.6 * catW + 0.4 * Math.min(1, tagSum / 2));

  // 热度：log 归一；未知按中性 0.5
  const heat =
    c.heatValue != null && c.heatValue > 0
      ? clamp01(Math.log1p(c.heatValue) / HEAT_LOG_MAX)
      : 0.5;

  // 质量：评分 5-9.5 线性映射 0-1；未知按中性 0.5
  const quality =
    c.ratingValue != null && c.ratingValue > 0
      ? clamp01((c.ratingValue - 5) / 4.5)
      : 0.5;

  // 惩罚因子
  const penalties: string[] = [];
  let factor = 1;
  const seenAt = opts.impressions?.get(c.id);
  if (seenAt != null && now - seenAt < cooldownMs) {
    penalties.push('cooldown');
    factor -= 0.5;
  }
  if (c.category && opts.recentCategories?.includes(c.category)) {
    penalties.push('recent-category');
    factor -= 0.15;
  }
  factor = Math.max(0, factor);

  const base = w.preference * preference + w.heat * heat + w.quality * quality;
  return {
    total: Math.round(100 * base * factor * 10) / 10,
    preference,
    heat,
    quality,
    penalties,
  };
}
