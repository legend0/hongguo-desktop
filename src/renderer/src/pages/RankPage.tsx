import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { RankList } from '../components/RankList';
import { ListShell } from '../components/ListShell';
import { usePagedList } from '../hooks/usePagedList';
import { RANK_TABS } from '../types';
import type { RankTab } from '../types';

/** 默认榜单（与站点首页第一个分区一致） */
const DEFAULT_TAB = 'hot-drama';

/**
 * 榜单页：4 个榜单（热播榜 / 真人剧 / AI剧 / 漫剧热播榜）。
 * - 支持 /rank/:key 直达（首页「查看更多」会带上对应 key）
 * - 头部固定（标题 + 榜单切换），列表独立滚动、触底自动加载下一页（排名持续累加）
 * - 列表为 demo 同款卡片网格：排名角标 + 集数 + 标签 + 2 行简介
 */
export function RankPage() {
  const { key } = useParams<{ key: string }>();
  const navigate = useNavigate();
  const [tab, setTab] = useState(key || DEFAULT_TAB);

  // URL 变化（如从首页「查看更多」跳进来）时同步 tab
  useEffect(() => {
    if (key && key !== tab) setTab(key);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const { items, meta, loading, loadingMore, error, hasMore, loadMore, reload } =
    usePagedList(
      (page) =>
        api.getRank(tab, page).then((r) => ({ items: r.items, meta: { tabs: r.tabs } })),
      tab,
    );

  // 接口返回的 tabs 带激活态；首页数据优先，兜底静态表
  const tabs: RankTab[] = meta?.tabs?.length ? meta.tabs : [...RANK_TABS];

  /** 切换榜单时同步 URL，保持可分享 / 可后退 */
  const selectTab = (k: string) => {
    setTab(k);
    navigate(`/rank/${k}`, { replace: true });
  };

  return (
    <ListShell
      head={
        <>
          <div className="section-head">
            <h2>榜单</h2>
            <span className="more">{items.length} 部作品</span>
          </div>
          <div className="main-tabs">
            {tabs.map((t) => (
              <button
                key={t.key}
                className={`main-tab${t.key === tab ? ' on' : ''}`}
                onClick={() => selectTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </>
      }
      loading={loading}
      loadingMore={loadingMore}
      hasMore={hasMore}
      error={error}
      onRetry={reload}
      onLoadMore={loadMore}
      empty={!loading && !error && items.length === 0 ? <div className="center-tip">该榜单暂无内容</div> : undefined}
    >
      <RankList items={items} />
    </ListShell>
  );
}
