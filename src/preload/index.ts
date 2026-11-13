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
  /** 搜索联想词（demo 协议无此接口，主进程恒返回空数组） */
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
   *  nextVid=下一集 id，随本次取址批量预解析（切集零额外请求） */
  getPlayInfo: (seriesId: string, itemId: string, force?: boolean, nextVid?: string) =>
    ipcRenderer.invoke('net:play', seriesId, itemId, force, nextVid),
  /** 登录态（x-tt-token）：读取当前状态 / 保存粘贴的 token / 清除恢复匿名 */
  getAuthState: () => ipcRenderer.invoke('net:auth-get'),
  setAuthToken: (raw: string) => ipcRenderer.invoke('net:auth-set', raw),
  clearAuthToken: () => ipcRenderer.invoke('net:auth-clear'),
  /** 验证码自动登录：发送验证码（回 mobile_ticket）/ 验证码换登录态（token 写入 login-state） */
  sendLoginCode: (mobile: string) => ipcRenderer.invoke('net:login-send-code', mobile),
  submitLoginCode: (mobile: string, code: string, ticket?: string) =>
    ipcRenderer.invoke('net:login-submit', mobile, code, ticket),
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
};

contextBridge.exposeInMainWorld('hongguo', api);

export type HongguoApi = typeof api;
