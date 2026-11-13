import type {
  ActorCard,
  ActorDetail,
  ActorWorksPage,
  CategoryPageResult,
  DramaCard,
  DramaDetail,
  HomeSection,
  RankPageResult,
  SearchSuggestion,
  SearchResultPage,
} from './types';

/**
 * 渲染层统一 API：全部经 preload 的 window.hongguo 走 IPC 到主进程，
 * 主进程适配 @hongguo/data-server（demo 协议方案）。
 */

/** 播放元信息：视频流由主进程本地解密流端点提供，渲染层直接以 HTTP Range 消费 */
export interface PlayInfo {
  videoUrl: string;
  format: 'mp4' | 'm3u8' | 'unknown';
}

/** 单条弹幕（time 为时间轴秒；likes 用于高赞优先与配色；mode 缺省右→左滚动） */
export interface DanmakuItem {
  time: number;
  text: string;
  likes?: number;
  color?: string;
  mode?: string;
}

/** 弹幕抓取结果（服务层不抛错，异常统一转为 success:false + 中文说明） */
export interface DanmakuResult {
  success: boolean;
  items: DanmakuItem[];
  notice?: string;
  truncated?: boolean;
  error?: string;
}

const hg = window.hongguo;

export const api = {
  // ===== 数据获取 =====

  /** 首页分区（App 端目录协议，按分区并行获取，失败分区自动跳过） */
  getHome: (): Promise<HomeSection[]> => hg.getHome(),

  /** 搜索（官网 Web → App 端双源降级），返回第一页结果 */
  search: (keyword: string): Promise<DramaCard[]> => hg.search(keyword),

  /** 搜索联想词（demo 方案无此接口，恒为空数组，UI 保留"查看全部结果"） */
  searchSuggest: (keyword: string): Promise<SearchSuggestion[]> => hg.searchSuggest(keyword),

  /** 搜索分页（官网 Web → App 端双源降级，session/cursor 由服务层维护） */
  searchPage: (keyword: string, page: number): Promise<SearchResultPage> =>
    hg.searchPage(keyword, page),

  /** 分类目录（App 端目录协议，失败降级热播搜索），sub 为题材 slug */
  getCategory: (main: string, sub?: string, page?: number): Promise<CategoryPageResult> =>
    hg.getCategory(main, sub, page),

  /** 榜单（App 端榜单目录协议），rankKey 如 hot-drama / hot-real-drama */
  getRank: (rankKey: string, page?: number): Promise<RankPageResult> =>
    hg.getRank(rankKey, page),

  /** 剧集详情 + 全部分集（官网 player 页 HTML 解析） */
  getDetail: (seriesId: string): Promise<DramaDetail> => hg.getDetail(seriesId),

  /** 播放元信息：本地解密流地址（主进程先解析播放地址，快速失败给出可读错误） */
  getPlayInfo: (seriesId: string, itemId: string, force?: boolean, nextVid?: string): Promise<PlayInfo> =>
    hg.getPlayInfo(seriesId, itemId, force, nextVid),

  /** 弹幕（官方签名接口，服务层自带缓存/去重/护栏；fresh=true 绕过失败缓存重试） */
  getDanmaku: (seriesId: string, itemId: string, fresh?: boolean): Promise<DanmakuResult> =>
    hg.getDanmaku(seriesId, itemId, fresh),

  /** 登录态（x-tt-token）：读取当前状态 / 保存粘贴的 token / 清除恢复匿名 */
  getAuthState: (): Promise<{ token: string; savedAt: number } | null> => hg.getAuthState(),
  setAuthToken: (raw: string): Promise<{ token: string; savedAt: number }> => hg.setAuthToken(raw),
  clearAuthToken: (): Promise<boolean> => hg.clearAuthToken(),

  /** 验证码自动登录：发送验证码（回 mobile_ticket，供登录提交携带） */
  sendLoginCode: (mobile: string): Promise<{ mobile: string; mobileTicket: string }> =>
    hg.sendLoginCode(mobile),
  /** 验证码换登录态：成功后 token 已在主进程持久化，返回保存后的登录态 */
  submitLoginCode: (mobile: string, code: string, ticket?: string): Promise<{ token: string; savedAt: number; endpoint: string }> =>
    hg.submitLoginCode(mobile, code, ticket),

  // ===== 剧星榜（演员） =====

  /** 剧星榜分页（App 端演员协议；gender: 女演员 female / 男演员 male，缺省全部；rankDate: 榜单统计日期） */
  getActorRanking: (page: number, gender?: string): Promise<{ items: ActorCard[]; hasMore: boolean; rankDate: string }> =>
    hg.getActorRanking(page, gender),

  /** 演员主页信息（含相关演员） */
  getActorDetail: (actorId: string): Promise<ActorDetail> => hg.getActorDetail(actorId),

  /** 演员作品分页（App 端演员协议） */
  getActorWorks: (actorId: string, page: number): Promise<ActorWorksPage> =>
    hg.getActorWorks(actorId, page),

  // ===== 本地存储（渲染层 zustand stores 持久化） =====

  storage: {
    get: <T>(key: string): Promise<T | null> => hg.storage.get(key),
    set: <T>(key: string, value: T): Promise<void> => hg.storage.set(key, value),
    delete: (key: string): Promise<void> => hg.storage.delete(key),
  },

  // ===== 窗口控制 =====

  win: {
    minimize: (): Promise<void> => hg.win.minimize(),
    toggleMaximize: (): Promise<boolean> => hg.win.toggleMaximize(),
    close: (): Promise<void> => hg.win.close(),
    isMaximized: (): Promise<boolean> => hg.win.isMaximized(),
    /** 最小化到托盘（窗口隐藏，托盘图标保留） */
    hideToTray: (): Promise<void> => hg.win.hideToTray(),
    /** 真正退出应用（绕过关闭确认） */
    quitApp: (): Promise<void> => hg.win.quitApp(),
    /** 同步"记住的关闭选择"到主进程（ask/quit/tray） */
    setCloseAction: (action: 'ask' | 'quit' | 'tray'): Promise<void> =>
      hg.win.setCloseAction(action),
    /** 通知主进程关闭确认弹窗已响应（选择/取消均可），清除 3s 关闭兜底定时器 */
    closeResponded: (): Promise<void> => hg.win.closeResponded(),
    /** 主进程转发的关闭请求（Alt+F4 等），返回解除监听函数 */
    onCloseRequested: (cb: () => void): (() => void) => hg.win.onCloseRequested(cb),
    openPlayer: (seriesId: string, itemId: string): Promise<void> =>
      hg.win.openPlayer(seriesId, itemId),
    fitToVideo: (ratio: number): Promise<boolean> => hg.win.fitToVideo(ratio),
    /** 播放器窗口被复用时接收切集指令（返回解除监听函数） */
    onPlayerOpen: (cb: (p: { seriesId: string; itemId: string }) => void): (() => void) =>
      hg.win.onPlayerOpen(cb),
  },

  // ===== 应用设置 =====

  app: {
    setLoginItem: (openAtLogin: boolean): Promise<boolean> => hg.app.setLoginItem(openAtLogin),
    getLoginItem: (): Promise<boolean> => hg.app.getLoginItem(),
    /** 应用版本号 */
    getVersion: (): Promise<string> => hg.app.getVersion(),
    /** 用系统浏览器打开 https 链接（白名单校验在主进程） */
    openExternal: (url: string): Promise<boolean> => hg.app.openExternal(url),
  },
};

/** window.hongguo 全局类型（与 preload/index.ts 暴露的白名单一一对应） */
declare global {
  interface Window {
    hongguo: {
      getHome(): Promise<HomeSection[]>;
      search(keyword: string): Promise<DramaCard[]>;
      searchSuggest(keyword: string): Promise<SearchSuggestion[]>;
      searchPage(keyword: string, page: number): Promise<SearchResultPage>;
      getCategory(main: string, sub?: string, page?: number): Promise<CategoryPageResult>;
      getRank(rankKey: string, page?: number): Promise<RankPageResult>;
      getDetail(seriesId: string): Promise<DramaDetail>;
      getPlayInfo(seriesId: string, itemId: string, force?: boolean, nextVid?: string): Promise<PlayInfo>;
      getAuthState(): Promise<{ token: string; savedAt: number } | null>;
      setAuthToken(raw: string): Promise<{ token: string; savedAt: number }>;
      clearAuthToken(): Promise<boolean>;
      sendLoginCode(mobile: string): Promise<{ mobile: string; mobileTicket: string }>;
      submitLoginCode(mobile: string, code: string, ticket?: string): Promise<{ token: string; savedAt: number; endpoint: string }>;
      getDanmaku(seriesId: string, itemId: string, fresh?: boolean): Promise<DanmakuResult>;
      getActorRanking(page?: number, gender?: string): Promise<{ items: ActorCard[]; hasMore: boolean; rankDate: string }>;
      getActorDetail(actorId: string): Promise<ActorDetail>;
      getActorWorks(actorId: string, page?: number): Promise<ActorWorksPage>;
      storage: {
        get<T>(key: string): Promise<T | null>;
        set<T>(key: string, value: T): Promise<void>;
        delete(key: string): Promise<void>;
      };
      win: {
        minimize(): Promise<void>;
        toggleMaximize(): Promise<boolean>;
        close(): Promise<void>;
        isMaximized(): Promise<boolean>;
        hideToTray(): Promise<void>;
        quitApp(): Promise<void>;
        setCloseAction(action: 'ask' | 'quit' | 'tray'): Promise<void>;
        closeResponded(): Promise<void>;
        onCloseRequested(cb: () => void): () => void;
        openPlayer(seriesId: string, itemId: string): Promise<void>;
        fitToVideo(ratio: number): Promise<boolean>;
        onPlayerOpen(cb: (p: { seriesId: string; itemId: string }) => void): () => void;
        onMaximizedChanged(cb: (maximized: boolean) => void): () => void;
      };
      app: {
        setLoginItem(openAtLogin: boolean): Promise<boolean>;
        getLoginItem(): Promise<boolean>;
        getVersion(): Promise<string>;
        openExternal(url: string): Promise<boolean>;
      };
    };
  }
}

export {};
