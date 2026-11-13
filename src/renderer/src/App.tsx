import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { ToastHost } from './components/Toast';
import { CloseConfirmModal } from './components/CloseConfirmModal';
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

function RootLayout() {
  const { pathname } = useLocation();
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
  const routes = (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/category" element={<Navigate to="/category/real-drama" replace />} />
      <Route path="/category/:main" element={<CategoryPage />} />
      <Route path="/rank" element={<RankPage />} />
      {/* 榜单直达：/rank/hot-drama（首页「查看更多」跳转带 key） */}
      <Route path="/rank/:key" element={<RankPage />} />
      {/* 剧星榜（演员榜 + 演员主页/作品） */}
      <Route path="/actors" element={<ActorsPage />} />
      <Route path="/actor/:actorId" element={<ActorDetailPage />} />
      <Route path="/search" element={<SearchPage />} />
      <Route path="/drama/:id" element={<DetailPage />} />
      <Route path="/player/:seriesId/:itemId" element={<PlayerPage />} />
      <Route path="/player/:seriesId" element={<PlayerPage />} />
      <Route path="/favorites" element={<FavoritesPage />} />
      <Route path="/history" element={<HistoryPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );

  // 播放器独立窗口：无侧栏/顶栏，视频铺满整个窗口
  if (pathname.startsWith('/player')) {
    return (
      <div className="app app-player">
        {routes}
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
        <main className="app-main">{routes}</main>
      </div>
      <CloseConfirmModal open={closeOpen} onClose={closeConfirmModal} />
      <ToastHost />
    </div>
  );
}
