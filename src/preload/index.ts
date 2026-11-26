import { contextBridge, ipcRenderer } from 'electron';

/**
 * 渲染进程可用 API（window.hongguo）。
 * 只暴露白名单方法，不暴露 ipcRenderer 本体。
 */
const api = {
  /** 首页分区（热播短剧/真人剧/漫剧/AI剧，来自 App 端目录协议） */
  getHome: () => ipcRenderer.invoke('net:home'),
  /** 搜索（结果第一页，官网 Web → App 端双源降级） */
  search: (keyword: string) => ipcRenderer.invoke('net:search', keyword),
  /** 搜索联想词（官网 Web 源，主进程缓存 60s + LRU 上限） */
  searchSuggest: (keyword: string) => ipcRenderer.invoke('net:search-suggest', keyword),
  /** 搜索结果分页 */
  searchPage: (keyword: string, page: number) => ipcRenderer.invoke('net:search-page', keyword, page),
  /** 分类页（主分类 + 子标签 + 卡片，App 端目录协议） */
  getCategory: (main: string, sub?: string, page = 1) =>
    ipcRenderer.invoke('net:category', main, sub, page),
  /** 榜单页（tab + 排名列表，App 端榜单协议） */
  getRank: (rankKey: string, page = 1) => ipcRenderer.invoke('net:rank', rankKey, page),
  /** 详情（官网 player 页解析，含全部分集 vid） */
  getDetail: (seriesId: string) => ipcRenderer.invoke('net:detail', seriesId),
  /** 播放信息：本地解密流地址；force=true 重置解密计划（签名过期/错误重试）；
   *  nextVid=下一集 id，随本次取址批量预解析（切集零额外请求）；
   *  allowHevc=渲染层 HEVC 硬解探测结果，false 时流地址追加 hevc=0（H264/转码兜底） */
  getPlayInfo: (seriesId: string, itemId: string, force?: boolean, nextVid?: string, allowHevc?: boolean) =>
    ipcRenderer.invoke('net:play', seriesId, itemId, force, nextVid, allowHevc),
  /** 下一集整集预解密（无感切换）：后台全量拉取+解密入内存缓存，切集时命中缓存零等待 */
  streamPrefetch: (vid: string, allowHevc?: boolean) => ipcRenderer.invoke('net:stream-prefetch', vid, allowHevc),
  /** 重置播放设备：重新注册全新匿名设备并作废旧设备缓存（连续播放失败后的恢复手段） */
  resetDevice: () => ipcRenderer.invoke('net:device-reset'),
  /** 登录态（x-tt-token）：读取当前状态 / 保存粘贴的 token / 清除恢复匿名 */
  getAuthState: () => ipcRenderer.invoke('net:auth-get'),
  setAuthToken: (raw: string) => ipcRenderer.invoke('net:auth-set', raw),
  clearAuthToken: () => ipcRenderer.invoke('net:auth-clear'),
  /** 验证码自动登录：发送验证码（回 mobile_ticket）/ 验证码换登录态（token 写入 login-state） */
  sendLoginCode: (mobile: string) => ipcRenderer.invoke('net:login-send-code', mobile),
  submitLoginCode: (mobile: string, code: string, ticket?: string) =>
    ipcRenderer.invoke('net:login-submit', mobile, code, ticket),

  /** 账号（官网扫码登录 + 账号域云同步）：登录态写 login-state，凭据在主进程持久化 */
  account: {
    /** 登录态概览（loggedIn + 用户资料 + 保存时间） */
    status: () => ipcRenderer.invoke('net:account-status'),
    /** 获取扫码会话（token + 二维码 data URI + 有效期秒数） */
    loginStart: () => ipcRenderer.invoke('net:account-login-start'),
    /** 轮询扫码状态（pending/scanned/confirmed/expired/canceled） */
    loginPoll: (token: string) => ipcRenderer.invoke('net:account-login-poll', token),
    /** 退出登录（清除账号凭据与 login-state） */
    logout: () => ipcRenderer.invoke('net:account-logout'),
    /** 云端播放进度列表（read_progress，未登录返回空数组） */
    history: () => ipcRenderer.invoke('net:account-history'),
    /** 云端收藏列表（视频书架，未登录返回空数组） */
    favorites: () => ipcRenderer.invoke('net:account-favorites'),
    /** 收藏写入云端书架（add true 加收藏 / false 取消；未登录 no-op 返回 false） */
    setFavorite: (seriesId: string, add: boolean) => ipcRenderer.invoke('net:account-favorite-set', seriesId, add),
    /** 播放进度上报（秒入参；未登录服务端 no-op 返回 false） */
    reportProgress: (p: {
      seriesId: string;
      vid: string;
      episodeIndex: number;
      positionSec: number;
      durationSec?: number;
      episodeCount?: number;
      title?: string;
    }) => ipcRenderer.invoke('net:account-report-progress', p),
  },
  /** 弹幕（官方签名接口，服务层自带缓存/去重/护栏；fresh=true 绕过失败缓存重试） */
  getDanmaku: (seriesId: string, itemId: string, fresh?: boolean) =>
    ipcRenderer.invoke('net:danmaku', seriesId, itemId, fresh),

  /** 剧星榜分页（App 端演员协议；gender: female/male，缺省全部） */
  getActorRanking: (page = 1, gender?: string) => ipcRenderer.invoke('actors:ranking', page, gender),
  /** 演员主页信息（含相关演员） */
  getActorDetail: (actorId: string) => ipcRenderer.invoke('actors:detail', actorId),
  /** 演员作品分页 */
  getActorWorks: (actorId: string, page = 1) => ipcRenderer.invoke('actors:works', actorId, page),

  storage: {
    get: (key: string) => ipcRenderer.invoke('storage:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('storage:set', key, value),
    delete: (key: string) => ipcRenderer.invoke('storage:delete', key),
  },

  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggleMaximize'),
    close: () => ipcRenderer.invoke('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
    /** 最小化到托盘（窗口隐藏，托盘图标保留） */
    hideToTray: () => ipcRenderer.invoke('win:hideToTray'),
    /** 真正退出应用（绕过关闭确认） */
    quitApp: () => ipcRenderer.invoke('win:quitApp'),
    /** 同步"记住的关闭选择"到主进程（ask/quit/tray），用于 Alt+F4 等系统级关闭 */
    setCloseAction: (action: 'ask' | 'quit' | 'tray') =>
      ipcRenderer.invoke('win:setCloseAction', action),
    /** 通知主进程关闭确认弹窗已响应（选择/取消均可），清除 3s 兜底定时器 */
    closeResponded: () => ipcRenderer.invoke('win:closeResponded'),
    /** 切换窗口置顶（播放器「钉住」按钮）。@returns 切换后的置顶状态 */
    toggleAlwaysOnTop: () => ipcRenderer.invoke('win:toggleAlwaysOnTop'),
    /** 播放器窗口被隐藏（老板键等），渲染层据此自动暂停播放 */
    onPlayerWindowHidden: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('player:window-hidden', handler);
      return () => ipcRenderer.removeListener('player:window-hidden', handler);
    },
    /** 主进程转发的关闭请求（Alt+F4 / 系统级关闭），渲染层据此弹出关闭确认弹窗 */
    onCloseRequested: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('win:close-requested', handler);
      return () => ipcRenderer.removeListener('win:close-requested', handler);
    },
    /** 打开/聚焦播放器独立窗口（已存在时主进程发 player:open 切集） */
    openPlayer: (seriesId: string, itemId: string) =>
      ipcRenderer.invoke('win:openPlayer', seriesId, itemId),
    /** 沉浸式：高度固定，宽度跟随视频比例（ratio = videoWidth/videoHeight） */
    fitToVideo: (ratio: number) => ipcRenderer.invoke('win:fitToVideo', ratio),
    /** 播放器窗口被复用时接收切集指令 */
    onPlayerOpen: (cb: (p: { seriesId: string; itemId: string }) => void) => {
      const handler = (_e: unknown, p: { seriesId: string; itemId: string }) => cb(p);
      ipcRenderer.on('player:open', handler);
      return () => ipcRenderer.removeListener('player:open', handler);
    },
    onMaximizedChanged: (cb: (maximized: boolean) => void) => {
      const handler = (_e: unknown, v: boolean) => cb(v);
      ipcRenderer.on('win:maximized-changed', handler);
      return () => ipcRenderer.removeListener('win:maximized-changed', handler);
    },
  },

  app: {
    setLoginItem: (openAtLogin: boolean) => ipcRenderer.invoke('app:setLoginItem', openAtLogin),
    getLoginItem: () => ipcRenderer.invoke('app:getLoginItem'),
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  },

  /** 自动更新（任务 66）：状态快照 / 开关同步 / 手动检查 / 重启安装 / 状态事件 */
  updater: {
    /** 读取主进程当前更新状态快照 */
    getState: () => ipcRenderer.invoke('hg:updater:get-state'),
    /** 同步设置页开关（true 开启定时检查；false 关闭自动检查） */
    setEnabled: (value: boolean) => ipcRenderer.invoke('hg:updater:set-enabled', value),
    /** 手动检查更新（不受开关限制；结果经 onState 广播） */
    check: () => ipcRenderer.invoke('hg:updater:check'),
    /** 触发下载更新包（仅 available 阶段有效；进度经 onState 广播） */
    download: () => ipcRenderer.invoke('hg:updater:download'),
    /** 下载完成后重启并安装（仅 downloaded 阶段有效） */
    install: () => ipcRenderer.invoke('hg:updater:install'),
    /** 订阅状态广播（主进程 → 全部窗口），返回取消订阅函数 */
    onState: (cb: (state: unknown) => void) => {
      const handler = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on('hg:updater:state', handler);
      return () => ipcRenderer.removeListener('hg:updater:state', handler);
    },
  },
};

contextBridge.exposeInMainWorld('hongguo', api);

export type HongguoApi = typeof api;
