/**
 * 推荐引擎（原 @hongguo/core recommend 模块并入桌面端）。
 * 画像（半衰期衰减）→ 加权打分 → 分类轮转 feed + 探索槽 + 冷却。
 * 仅保留桌面端实际消费的四个模块；service.ts（依赖 store/usecase/Web 层）随移动端移除。
 */
export { buildProfile, type ProfileOptions } from './profile';
export {
  EXPLORE_SLOT,
  RecommendationFeed,
  type FeedCallbacks,
  type FeedConfig,
  type FeedSource,
} from './feed';
export { scoreCandidate, DEFAULT_WEIGHTS, type ScoreOptions, type ScoreWeights } from './scoring';
export type {
  BehaviorSignal,
  RecommendCandidate,
  ScoredCandidate,
  UserProfile,
} from './types';
