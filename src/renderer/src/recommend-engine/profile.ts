/**
 * 用户画像：从观看记录 / 收藏 / 设置的喜欢分类 构建偏好权重。
 */
import type { BehaviorSignal, UserProfile } from './types';

export interface ProfileOptions {
  /** 偏好半衰期（天）：距今越久权重越低，默认 7 */
  halfLifeDays?: number;
  /** 设置中选择喜欢的分类（主分类 key），作为强先验 */
  preferredCategories?: string[];
  /** 喜欢分类的先验权重（约等于完整追完 3 部剧），默认 3 */
  preferredWeight?: number;
}

/** 无总集数时的默认看完度 */
const DEFAULT_COMPLETION = 0.4;
const MIN_COMPLETION = 0.15;

function normalize(map: Record<string, number>): void {
  let max = 0;
  for (const v of Object.values(map)) if (v > max) max = v;
  if (max > 0) for (const k of Object.keys(map)) map[k] /= max;
}

/** 看完度：看至第 N 集 / 总集数；收藏直接视为看完 */
function completionRatio(s: BehaviorSignal): number {
  if (s.favorite) return 1;
  if (s.totalEpisodes && s.totalEpisodes > 0) {
    return Math.min(1, Math.max(MIN_COMPLETION, s.episodeIndex / s.totalEpisodes));
  }
  return DEFAULT_COMPLETION;
}

/**
 * 构建用户画像。
 * 权重 = 看完度 × 时间衰减（半衰期），收藏条目权重恒为 1；
 * 喜欢分类（设置项）追加固定先验后整体按最大值归一化。
 */
export function buildProfile(
  signals: BehaviorSignal[],
  opts: ProfileOptions = {},
  now: number = Date.now(),
): UserProfile {
  const halfLifeMs = (opts.halfLifeDays ?? 7) * 86_400_000;
  const cat: Record<string, number> = {};
  const tag: Record<string, number> = {};

  for (const s of signals) {
    let w = completionRatio(s) * 0.5 ** (Math.max(0, now - s.updatedAt) / halfLifeMs);
    if (w < 0.01) continue;
    if (s.category) cat[s.category] = (cat[s.category] ?? 0) + w;
    for (const t of s.tags ?? []) tag[t] = (tag[t] ?? 0) + w;
  }

  for (const c of opts.preferredCategories ?? []) {
    cat[c] = (cat[c] ?? 0) + (opts.preferredWeight ?? 3);
  }

  normalize(cat);
  normalize(tag);
  return { categoryWeights: cat, tagWeights: tag, signalCount: signals.length };
}
