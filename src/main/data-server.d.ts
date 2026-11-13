/**
 * @hongguo/server（原 @hongguo/data-server，已并入 src/server，CommonJS 无类型）的最小类型声明。
 * 仅声明主进程实际消费的成员；协议层原始字段以 unknown/宽松类型表达。
 */
declare module '@hongguo/server' {
  export interface RawCard {
    series_id: string;
    series_title: string;
    cover?: string;
    episode_count?: number;
    description?: string;
    tags?: string[];
    /** 榜单卡片扩展：热度文案 / 评分 / 排名（hongguo-app-catalog cards 透传） */
    rec_text?: string;
    score?: string;
    rank?: number;
  }

  export interface CatalogResult {
    success?: boolean;
    results?: RawCard[];
    page?: number;
    total?: number;
    hasMore?: boolean;
    genres?: { slug: string; label: string }[];
    error?: string;
  }

  export interface RawEpisode {
    vid: string;
    vid_index: number;
    title?: string;
    series_id?: string;
    series_title?: string;
    cover?: string;
  }

  export interface RawDetail {
    series_id: string;
    series_title: string;
    cover?: string;
    total?: number;
    intro?: string;
    tags?: string[];
    social_info?: {
      rating?: number | null;
      hot_text?: string;
      like_count?: string;
      favorite_count?: string;
    } | null;
    celebrities?: { actor_id?: string; name?: string; avatar?: string; role?: string }[];
    episodes: RawEpisode[];
  }

  /** 官网详情页附加数据（热评 + 推荐位 + 热门，hongguo-web-detail 解析） */
  export interface RawWebDetailExtras {
    reviews: {
      author: string;
      authorAvatarUrl?: string;
      publishedAt?: string;
      rating?: number;
      content: string;
      likes?: number;
    }[];
    reviewTotal: number;
    recommendations: RawCard[];
    hotRecommendations: RawCard[];
  }

  /** 官网搜索联想条目（hongguo-web-suggest 解析） */
  export interface RawSuggestion {
    kind: 'drama' | 'keyword';
    name: string;
    keyword: string;
    coverUrl?: string;
    totalEpisodes?: number;
    heatText?: string;
    categories?: string[];
  }

  export interface RawPlayInfo {
    vid: string;
    url?: string;
    codec?: string;
    quality?: string;
    contentKeyHex?: string | null;
    variants?: { quality?: string; codec?: string; url?: string }[];
  }

  export interface RawActorRank {
    actors?: {
      rank?: number;
      actor_id: string;
      name: string;
      avatar?: string;
      score?: unknown;
      intro?: string;
      sub_titles?: string[];
      rank_change?: { type?: number; num?: number; ChangeNum?: number };
    }[];
    /** 榜单统计日期（上游 rank_date） */
    rank_date?: string;
    hasMore?: boolean;
  }

  export interface RawActorDetail {
    success?: boolean;
    actor?: {
      actor_id?: string;
      name?: string;
      avatar?: string;
      intro?: string;
      related_celebrities?: { actor_id?: string; celebrity_id?: string; name?: string; nickname?: string; avatar?: string }[];
    };
  }

  export interface RawActorWorks {
    works?: RawCard[];
    total_count?: number;
    has_more?: boolean;
  }

  export interface StreamServerHandle {
    server: import('node:http').Server;
    port: number;
    /** 流路由鉴权 token（/stream/:token/:vid，启动时随机生成） */
    token: string;
    close: () => void;
  }

  export interface DataServer {
    dramaService: {
      search(keyword: string, page?: number): Promise<{ results?: RawCard[]; total?: number; hasMore?: boolean; error?: string }>;
      catalog(options?: { page?: number; category?: string; genre?: string }): Promise<CatalogResult>;
      getSeriesDetail(seriesId: string): Promise<RawDetail>;
      getWebDetailExtras(seriesId: string): Promise<RawWebDetailExtras>;
      searchSuggest(keyword: string): Promise<RawSuggestion[]>;
      getPlayInfo(vid: string, quality?: string, options?: { nextVid?: string }): Promise<RawPlayInfo>;
      getActorRankings(options?: { page?: number; limit?: number; gender?: string }): Promise<RawActorRank>;
      getActorDetail(actorId: string): Promise<RawActorDetail>;
      getActorWorks(actorId: string, options?: { count?: number; offset?: number }): Promise<RawActorWorks>;
    };
    streamService: {
      handleStream(req: unknown, res: unknown, vid: string): void;
      prefetch(vid: string, quality?: string, force?: boolean, timeout?: number, nextVids?: string[]): void;
    };
    storeService: Record<string, (...args: unknown[]) => unknown>;
    logger: { info(tag: string, msg: string): void; warn(tag: string, msg: string): void; error(tag: string, msg: string): void };
    danmaku: { fetchDanmaku(options: { seriesId: string; vid: string; fresh?: boolean }): Promise<unknown> };
    /** 登录态（x-tt-token）管理：设置页手动粘贴 token / 验证码自动登录写入 */
    loginState: {
      getLoginState(): { token: string; savedAt: number } | null;
      hasToken(): boolean;
      setToken(raw: string): { token: string; savedAt: number };
      clearToken(): void;
    };
    /** 验证码自动登录（passport 域）：发码 + 验证码换登录态（token 写入 loginState） */
    login: {
      sendSmsCode(mobile: string): Promise<{ mobile: string; mobileTicket: string }>;
      loginWithCode(mobile: string, code: string, mobileTicket?: string): Promise<{ token: string; savedAt: number; endpoint: string; steps?: unknown[] }>;
    };
    createStreamServer(options?: { streamService?: unknown; port?: number }): Promise<StreamServerHandle>;
  }

  const hg: DataServer;
  export default hg;
}
