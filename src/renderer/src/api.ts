import type {
  AccountStatus,
  ActorCard,
  ActorDetail,
  ActorWorksPage,
  CategoryPageResult,
  CloudFavoriteRow,
  CloudProgressRow,
  DramaCard,
  DramaDetail,
  HomeSection,
  ProgressReportInput,
  QrLoginPollResult,
  QrLoginSession,
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

/** 更新状态机阶段（与主进程 src/main/updater.ts 保持一致） */
export type UpdaterPhase =
  | 'idle' | 'checking' | 'available' | 'downloading'
  | 'downloaded' | 'error' | 'unsupported';

/** 主进程广播的更新状态快照 */
export interface UpdaterState {
  phase: UpdaterPhase;
  /** 下载进度百分比（0-100，仅 downloading 阶段有效） */
  progress: number;
  /** 下载速度（字节/秒，仅 downloading 阶段有效） */
  bps: number;
  /** 已下载字节数（仅 downloading 阶段有效） */
  transferred: number;
  /** 安装包总字节数（仅 downloading 阶段有效） */
  total: number;
  /** 新版本号（available/downloading/downloaded 阶段有效） */
  version: string;
  /** 失败原因（error 阶段有效，已用户可读化） */
  error: string;
  /** 当前安装形态是否支持自动更新（便携版/开发模式为 false） */
  supported: boolean;
  /** 本轮检查是否用户手动触发（自动检查静默，仅手动检查结果才提示） */
  manual: boolean;
}

/**
 * 剥离 Electron IPC 错误前缀：ipcMain.handle 抛出的错误经 ipcRenderer.invoke
 * 会被 Electron 包装为 "Error invoking remote method 'net:xxx': Error: 原始信息"，
 * 此处剥掉包装（含嵌套的 "Error:"），仅向用户展示真实错误内容。
 * @param {unknown} e - IPC 链路 rejection 的原始错误
 * @returns {Error} 仅含真实错误信息的新 Error
 */
function stripIpcPrefix(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(
    msg.replace(/Error invoking remote method '[^']+':\s*(?:Error:\s*)?/g, '').trim(),
  );
}

/**
 * 递归包装 preload 暴露的 window.hongguo API：所有 Promise 调用在 rejection 时
 * 统一剥离 IPC 错误前缀（一处生效，覆盖全部页面与播放器）。
 * 非函数/非对象成员原样保留；返回值不是 Promise 的方法（如事件订阅）不做包装。
 * @param {T} obj - preload API 对象（嵌套 win/app/updater/storage 等）
 * @returns {T} 包装后的同结构对象
 */
function wrapHg<T>(obj: T): T {
  if (typeof obj !== 'object' || obj === null) return obj;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof value === 'function') {
      out[key] = (...args: unknown[]) => {
        const r = (value as (...a: unknown[]) => unknown)(...args);
        // 仅包装返回 Promise 的调用（事件订阅返回解绑函数，原样透传）
        if (r && typeof (r as Promise<unknown>).catch === 'function') {
          return (r as Promise<unknown>).catch((err: unknown) => Promise.reject(stripIpcPrefix(err)));
        }
        return r;
      };
    } else if (typeof value === 'object' && value !== null) {
      out[key] = wrapHg(value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

const hg = wrapHg(window.hongguo);

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

  /** 播放元信息：本地解密流地址（主进程先解析播放地址，快速失败给出可读错误）。
   *  allowHevc：渲染层 HEVC 硬解探测结果，false 时主进程在流地址追加 hevc=0 */
  getPlayInfo: (seriesId: string, itemId: string, force?: boolean, nextVid?: string, allowHevc?: boolean): Promise<PlayInfo> =>
    hg.getPlayInfo(seriesId, itemId, force, nextVid, allowHevc),

  /** 下一集整集预解密（无感切换）：后台全量拉取+解密入内存缓存，切集时命中缓存零等待 */
  streamPrefetch: (vid: string, allowHevc?: boolean): Promise<boolean> => hg.streamPrefetch(vid, allowHevc),

  /** 重置播放设备：重新注册全新匿名设备并作废旧设备缓存，返回新设备身份 */
  resetDevice: (): Promise<{ device_id: string; iid: string }> => hg.resetDevice(),

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

  // ===== 账号（官网扫码登录 + 云同步） =====

  account: {
    /** 登录态概览（含用户资料，未登录 user 为 null） */
    status: (): Promise<AccountStatus> => hg.account.status(),
    /** 获取扫码会话（token + 二维码 data URI + 有效期秒数） */
    loginStart: (): Promise<QrLoginSession> => hg.account.loginStart(),
    /** 轮询扫码状态（2s 一次由渲染层驱动） */
    loginPoll: (token: string): Promise<QrLoginPollResult> => hg.account.loginPoll(token),
    /** 退出登录（清除账号凭据与 login-state） */
    logout: (): Promise<boolean> => hg.account.logout(),
    /** 云端播放进度列表（未登录返回空数组） */
    history: (): Promise<CloudProgressRow[]> => hg.account.history(),
    /** 云端收藏列表（未登录返回空数组） */
    favorites: (): Promise<CloudFavoriteRow[]> => hg.account.favorites(),
    /** 收藏写入云端书架（未登录 no-op 返回 false） */
    setFavorite: (seriesId: string, add: boolean): Promise<boolean> => hg.account.setFavorite(seriesId, add),
    /** 播放进度上报（秒入参；未登录服务端 no-op 返回 false） */
    reportProgress: (p: ProgressReportInput): Promise<boolean> => hg.account.reportProgress(p),
  },

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
    /** 最大化状态变化订阅（最大化/还原时回调）。@returns 解绑函数 */
    onMaximizedChanged: (cb: (maximized: boolean) => void): (() => void) =>
      hg.win.onMaximizedChanged(cb),
    /** 最小化到托盘（窗口隐藏，托盘图标保留） */
    hideToTray: (): Promise<void> => hg.win.hideToTray(),
    /** 真正退出应用（绕过关闭确认） */
    quitApp: (): Promise<void> => hg.win.quitApp(),
    /** 同步"记住的关闭选择"到主进程（ask/quit/tray） */
    setCloseAction: (action: 'ask' | 'quit' | 'tray'): Promise<void> =>
      hg.win.setCloseAction(action),
    /** 通知主进程关闭确认弹窗已响应（选择/取消均可），清除 3s 关闭兜底定时器 */
    closeResponded: (): Promise<void> => hg.win.closeResponded(),
    /** 切换窗口置顶（播放器「钉住」按钮）。@returns 切换后的置顶状态 */
    toggleAlwaysOnTop: (): Promise<boolean> => hg.win.toggleAlwaysOnTop(),
    /** 播放器窗口被隐藏（老板键等），返回解除监听函数 */
    onPlayerWindowHidden: (cb: () => void): (() => void) => hg.win.onPlayerWindowHidden(cb),
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

  // ===== 自动更新（electron-updater + GitHub Releases，任务 66） =====

  /** 主进程更新状态快照（与 src/main/updater.ts UpdaterState 对应） */
  updater: {
    getState: (): Promise<UpdaterState> => hg.updater.getState(),
    /** 同步设置页开关（true 开启定时检查；false 关闭自动检查） */
    setEnabled: (value: boolean): Promise<UpdaterState> => hg.updater.setEnabled(value),
    /** 手动检查更新（不受开关限制；结果经 onState 广播） */
    check: (): Promise<void> => hg.updater.check(),
    /** 触发下载更新包（仅 available 阶段有效；进度经 onState 广播） */
    download: (): Promise<boolean> => hg.updater.download(),
    /** 下载完成后重启并安装 */
    install: (): Promise<boolean> => hg.updater.install(),
    /** 订阅状态广播，返回解除监听函数 */
    onState: (cb: (state: UpdaterState) => void): (() => void) =>
      hg.updater.onState((s) => cb(s as UpdaterState)),
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
      getPlayInfo(seriesId: string, itemId: string, force?: boolean, nextVid?: string, allowHevc?: boolean): Promise<PlayInfo>;
      streamPrefetch(vid: string, allowHevc?: boolean): Promise<boolean>;
      resetDevice(): Promise<{ device_id: string; iid: string }>;
      getAuthState(): Promise<{ token: string; savedAt: number } | null>;
      setAuthToken(raw: string): Promise<{ token: string; savedAt: number }>;
      clearAuthToken(): Promise<boolean>;
      sendLoginCode(mobile: string): Promise<{ mobile: string; mobileTicket: string }>;
      submitLoginCode(mobile: string, code: string, ticket?: string): Promise<{ token: string; savedAt: number; endpoint: string }>;
      account: {
        status(): Promise<AccountStatus>;
        loginStart(): Promise<QrLoginSession>;
        loginPoll(token: string): Promise<QrLoginPollResult>;
        logout(): Promise<boolean>;
        history(): Promise<CloudProgressRow[]>;
        favorites(): Promise<CloudFavoriteRow[]>;
        setFavorite(seriesId: string, add: boolean): Promise<boolean>;
        reportProgress(p: ProgressReportInput): Promise<boolean>;
      };
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
        onMaximizedChanged(cb: (maximized: boolean) => void): () => void;
        hideToTray(): Promise<void>;
        quitApp(): Promise<void>;
        setCloseAction(action: 'ask' | 'quit' | 'tray'): Promise<void>;
        closeResponded(): Promise<void>;
        toggleAlwaysOnTop(): Promise<boolean>;
        onPlayerWindowHidden(cb: () => void): () => void;
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
      updater: {
        getState(): Promise<UpdaterState>;
        setEnabled(value: boolean): Promise<UpdaterState>;
        check(): Promise<void>;
        download(): Promise<boolean>;
        install(): Promise<boolean>;
        onState(cb: (state: UpdaterState) => void): () => void;
      };
    };
  }
}

export {};
