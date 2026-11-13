/**
 * 推荐算法统一类型
 */

/** 推荐候选（打分所需特征；由分类页卡片 / 榜单条目 / 详情归一而来） */
export interface RecommendCandidate {
  id: string;
  title: string;
  coverUrl: string;
  totalEpisodes?: number | null;
  tags: string[];
  /** 所属主分类 key（real-drama / comic-drama / ai-drama / comic） */
  category?: string;
  /** 热度数值（万为单位，如 2971） */
  heatValue?: number;
  /** 评分 0-10 */
  ratingValue?: number;
  kind?: 'drama' | 'comic';
}

/** 用户行为信号输入（历史条目 + 收藏归一） */
export interface BehaviorSignal {
  dramaId: string;
  tags?: string[];
  /** 主分类 key，未知可缺省 */
  category?: string;
  /** 已看到的集序号（1 起） */
  episodeIndex: number;
  totalEpisodes?: number;
  /** 收藏视为强兴趣 */
  favorite?: boolean;
  updatedAt: number;
}

/** 用户画像（权重均已归一化到 0-1） */
export interface UserProfile {
  categoryWeights: Record<string, number>;
  tagWeights: Record<string, number>;
  /** 参与画像的行为条数 */
  signalCount: number;
}

/** 单个候选的打分细节 */
export interface CandidateScore {
  /** 最终分 0-100 */
  total: number;
  /** 偏好匹配 0-1（分类 + 标签） */
  preference: number;
  /** 热度 0-1（未知按 0.5） */
  heat: number;
  /** 质量 0-1（未知按 0.5） */
  quality: number;
  /** 命中的惩罚项：cooldown / recent-category */
  penalties: string[];
}

/** 打分后的候选，直接供推荐 feed 渲染 */
export interface ScoredCandidate extends RecommendCandidate {
  score: CandidateScore;
  /** 进度中的剧：建议续播的集序号 */
  continueFrom?: number;
}
