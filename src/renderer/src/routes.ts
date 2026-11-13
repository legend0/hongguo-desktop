/**
 * 站内路由工具：把站点返回的绝对路径转换成应用内的 HashRouter 路由。
 *
 * 背景：站点页面里的链接（首页分区「查看更多」→ /rank/hot-drama、详情页
 * 「短剧热播榜 No.1」→ /rank/hot-drama 等）都是站点自身的绝对路径。
 * 应用用的是 HashRouter，直接把 /rank/xxx 塞进 <Link to> 会被当成
 * 站内相对路径处理，跳到错误地址，所以统一在这里转换。
 */

/** 站点绝对路径 → 应用内路由 */
export function siteHref(path: string | null | undefined): string | null {
  if (!path) return null;
  // 只处理站内相对路径；http(s) 外链交给浏览器直接打开
  if (/^https?:\/\//i.test(path)) return path;
  if (!path.startsWith('/')) return null;
  return path;
}

/**
 * 榜单链接 → 应用内榜单路由。
 * /rank/hot-drama → /rank/hot-drama
 * /rank → /rank（无 key 时走默认榜单）
 */
export function rankHref(path: string | null | undefined): string | null {
  const href = siteHref(path);
  if (!href) return null;
  const m = href.match(/\/rank\/([\w-]+)/);
  if (m) return `/rank/${m[1]}`;
  if (href.startsWith('/rank')) return '/rank';
  return null;
}

/** 详情页链接 → 应用内详情路由（/detail?series_id=xxx → /drama/xxx） */
export function detailHref(path: string | null | undefined): string | null {
  const href = siteHref(path);
  if (!href) return null;
  const m = href.match(/series_id=(\d+)/);
  if (m) return `/drama/${m[1]}`;
  return null;
}
