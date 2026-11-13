import { NavLink, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useFavorites, useHistory } from '../stores';
import {
  IconHome,
  IconTv,
  IconPalette,
  IconSparkles,
  IconStar,
  IconChart,
  IconHeart,
  IconClock,
} from './Icons';
import type { ReactNode } from 'react';

/** 分类主菜单（对应 demo App 端目录协议的 3 个主分类，直达 /category/{main}） */
const CATEGORIES: { to: string; icon: ReactNode; label: string }[] = [
  { to: '/category/real-drama', icon: <IconTv />, label: '真人剧' },
  { to: '/category/comic-drama', icon: <IconPalette />, label: 'AI漫剧' },
  { to: '/category/ai-drama', icon: <IconSparkles />, label: 'AI短剧' },
];

/**
 * 左侧导航（浏览 + 个人区，激活态带品牌色竖条）。
 * 详情页 / 播放页没有自己的导航项，此时保持"来源菜单"的高亮：
 * 例如从「真人剧」分类点进某部剧，侧边栏的真人剧仍是激活态。
 */
export function Sidebar() {
  const favorites = useFavorites();
  const history = useHistory();
  const location = useLocation();
  /** 最后浏览的一级页面（详情/播放页不更新它） */
  const [lastSection, setLastSection] = useState('/');

  useEffect(() => {
    const p = location.pathname;
    const isSubPage = p.startsWith('/drama/') || p.startsWith('/player/');
    if (!isSubPage) setLastSection(p);
  }, [location.pathname]);

  /** 激活判定：详情/播放页回落到 lastSection，其余按前缀匹配 */
  const isActive = (to: string) => {
    const p = location.pathname;
    const isSubPage = p.startsWith('/drama/') || p.startsWith('/player/');
    const target = isSubPage ? lastSection : p;
    if (to === '/') return target === '/';
    return target === to || target.startsWith(`${to}/`);
  };

  const item = (to: string, icon: ReactNode, label: string, badge?: number, key?: string) => (
    <NavLink
      key={key ?? to}
      to={to}
      end={to === '/'}
      className={() => `nav-item${isActive(key ?? to) ? ' active' : ''}`}
    >
      <span className="nav-icon">{icon}</span>
      {label}
      {badge ? <span className="nav-badge">{badge}</span> : null}
    </NavLink>
  );

  return (
    <aside className="sidebar">
      <div className="brand">
        {/* logo 用标准 png（原 logo.svg 为内嵌位图的伪 svg 450KB）；相对路径引用 public/，规避打包后 file:// 绝对路径 404 */}
        <img className="brand-logo" src="logo.png" alt="黑果短剧" />
        <div>
          <div className="brand-name">黑果短剧</div>
          <div className="brand-sub">专注短剧的追剧神器</div>
        </div>
      </div>

      <div className="nav-group">主菜单</div>
      {item('/', <IconHome />, '首页')}
      {CATEGORIES.map((c) => item(c.to, c.icon, c.label, undefined, c.to))}
      {item('/actors', <IconStar />, '剧星榜')}
      {item('/rank', <IconChart />, '剧榜单')}

      <div className="sidebar-bottom">
        <div className="nav-group">我的</div>
        {item('/favorites', <IconHeart />, '我的收藏', Object.keys(favorites.items).length)}
        {item('/history', <IconClock />, '观看历史', history.entries.length || undefined)}
      </div>
    </aside>
  );
}
