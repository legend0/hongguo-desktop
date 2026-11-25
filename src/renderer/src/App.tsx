import { HashRouter, Navigate, Route, Routes, useLocation, type Location } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { CacheLayer, cacheKeyOf } from './components/KeepAlive';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { ToastHost } from './components/Toast';
import { CloseConfirmModal } from './components/CloseConfirmModal';
import { UpdateModal } from './components/UpdateModal';
import { api } from './api';
import { useTheme } from './hooks/useTheme';
import { HomePage } from './pages/HomePage';
import { CategoryPage } from './pages/CategoryPage';
import { RankPage } from './pages/RankPage';
import { ActorsPage } from './pages/ActorsPage';
import { ActorDetailPage } from './pages/ActorDetailPage';
import { SearchPage } from './pages/SearchPage';
import { DetailPage } from './pages/DetailPage';
import { PlayerPage } from './pages/PlayerPage';
import { FavoritesPage } from './pages/FavoritesPage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsPage } from './pages/SettingsPage';

/**
 * 整体布局（视觉稿）：
 * 左右结构 —— 左侧栏（logo + 菜单）全高；右侧列 = 顶部控制栏 + 内容主体。
 * 播放页（/player）跑在独立无边框窗口里，不挂侧栏/顶栏，全屏沉浸式。
 */
export function App() {
  return (
    <HashRouter>
      <RootLayout />
    </HashRouter>
  );
}

/** KeepAlive 缓存层上限（任务 85）：超出按 LRU 淘汰最久未激活的层 */
const CACHE_MAX = 8;

function RootLayout() {
  const location = useLocation();
  const { pathname, search } = location;
  // ===== KeepAlive 缓存（任务 79，自研 display 方案，见 components/KeepAlive.tsx）=====
  // 缓存键含动态参数：/category/:main 切分类、/rank/:key 切榜单、/actor/:actorId 切演员、
  // /search?keyword= 换关键词，各自独立实例，互不串缓存
  const activeKey = cacheKeyOf(pathname, search);
  /**
   * 已访问缓存路由快照：键 → { 首次访问 location, 最近激活时间 }。
   * LRU 上限（任务 85）：超过 CACHE_MAX 淘汰最久未激活的缓存层——
   * 搜索每个关键词都会生成独立缓存层，不淘汰会随使用无界增长。
   */
  const [cacheMap, setCacheMap] = useState<Map<string, { loc: Location; at: number }>>(new Map());
  useEffect(() => {
    if (!activeKey) return;
    setCacheMap((prev) => {
      const hit = prev.get(activeKey);
      const next = new Map(prev);
      if (hit) {
        // 命中：仅刷新活跃时间（location 引用不变，缓存层组件不会重挂载）
        next.set(activeKey, { loc: hit.loc, at: Date.now() });
        return next;
      }
      if (prev.size >= CACHE_MAX) {
        // 淘汰最久未激活的缓存层（当前 key 必然不在 prev 中，为新增）
        let oldestKey = '';
        let oldestAt = Infinity;
        for (const [k, v] of prev) {
          if (v.at < oldestAt) {
            oldestAt = v.at;
            oldestKey = k;
          }
        }
        if (oldestKey) next.delete(oldestKey);
      }
      next.set(activeKey, { loc: location, at: Date.now() });
      return next;
    });
  }, [activeKey, location]);

  // 主题应用（主窗口 + 播放器独立窗口共用）：settings.theme → <html data-theme>
  useTheme();
  // 关闭确认弹窗：Alt+F4（主进程转发）与顶栏关闭按钮（无记住偏好时）共用
  const [closeOpen, setCloseOpen] = useState(false);
  /** 关闭弹窗（选择/取消均走这里）：同步通知主进程"已响应"，清除 3s 关闭兜底定时器 */
  const closeConfirmModal = () => {
    setCloseOpen(false);
    void api.win.closeResponded();
  };
  useEffect(() => {
    const off = api.win.onCloseRequested(() => setCloseOpen(true));
    const onReq = () => setCloseOpen(true);
    window.addEventListener('hg:request-close', onReq);
    return () => {
      off();
      window.removeEventListener('hg:request-close', onReq);
    };
  }, []);
  /** 非缓存路由（当前地址不是缓存页时渲染；播放器窗口路径也走这里） */
  const plainRoutes = (
    <Routes location={location}>
      {/* 详情/播放/收藏/历史/设置不缓存：数据新鲜度优先 */}
      <Route path="/drama/:id" element={<DetailPage />} />
      <Route path="/player/:seriesId/:itemId" element={<PlayerPage />} />
      <Route path="/player/:seriesId" element={<PlayerPage />} />
      <Route path="/favorites" element={<FavoritesPage />} />
      <Route path="/history" element={<HistoryPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      {/* /category 落地重定向与通配兜底：不放缓存层，避免休眠层触发导航 */}
      <Route path="/category" element={<Navigate to="/category/real-drama" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );

  // 播放器独立窗口：无侧栏/顶栏，视频铺满整个窗口（不参与缓存）
  if (pathname.startsWith('/player')) {
    return (
      <div className="app app-player">
        {plainRoutes}
        <ToastHost />
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar />
      <div className="app-main-col">
        {/* 首页主视觉层：Banner 图铺满整列（含顶部控制栏），内容与标题栏压在其上 */}
        <div className="hero-layer" id="hero-layer" />
        <Topbar />
        <main className="app-main" id="app-main">
          {/* 缓存层：每个首次访问的缓存路由常驻一份 Routes（location 固定为快照），
              非当前层 display:none 隐藏——DOM/状态/滚动保留，不重新请求 */}
          {[...cacheMap.entries()].map(([key, entry]) => (
            <CacheLayer key={key} active={key === activeKey}>
              <Routes location={entry.loc}>
                <Route path="/" element={<HomePage />} />
                <Route path="/category/:main" element={<CategoryPage />} />
                <Route path="/rank" element={<RankPage />} />
                <Route path="/rank/:key" element={<RankPage />} />
                <Route path="/actors" element={<ActorsPage />} />
                <Route path="/actor/:actorId" element={<ActorDetailPage />} />
                <Route
                  path="/search"
                  // 快照地址解析关键词传入（休眠层不能用 useSearchParams，读的是 Router 真实地址）
                  element={<SearchPage keyword={new URLSearchParams(entry.loc.search).get('keyword') ?? ''} />}
                />
              </Routes>
            </CacheLayer>
          ))}
          {/* 当前地址是非缓存路由（详情/收藏/历史/设置等）时直接渲染 */}
          {activeKey === null ? plainRoutes : null}
        </main>
      </div>
      <CloseConfirmModal open={closeOpen} onClose={closeConfirmModal} />
      <UpdateModal />
      <ToastHost />
    </div>
  );
}
