import { api } from '../api';
import { RankList } from '../components/RankList';
import { EmptyState } from '../components/Feedback';
import { ListShell } from '../components/ListShell';
import { usePagedList } from '../hooks/usePagedList';
import { IconSearch, IconFilm } from '../components/Icons';

/**
 * 搜索结果页：JSON API 分页（/api/search/result）。
 * 头部固定（关键词 + 数量），列表独立滚动、触底自动加载下一页，UI 与榜单一致。
 * 关键词由 App 经 props 传入（KeepAlive 休眠层不能用 useSearchParams：
 * 该 hook 读 Router 层真实地址，休眠期间会读到其它页面地址导致状态被清）。
 * @param {Object} props - 组件属性。
 * @param {string} props.keyword - 搜索关键词（空串显示引导空态）。
 * @returns {JSX.Element} 搜索结果列表页。
 */
export function SearchPage({ keyword = '' }: { keyword?: string }) {

  const { items, meta, loading, loadingMore, error, hasMore, loadMore, retryMore, reload } =
    usePagedList(
      (page) =>
        api
          .searchPage(keyword, page)
          .then((r) => ({ items: r.items, hasMore: r.hasMore, meta: { total: r.totalCount } })),
      keyword,
    );

  if (!keyword) return <EmptyState icon={<IconSearch size={40} />} text="输入关键词开始搜索" />;

  return (
    <ListShell
      head={
        <div className="section-head">
          <h2 style={{ fontSize: 16 }}>
            “{keyword}” 的搜索结果
            {meta?.total ? (
              <span style={{ fontSize: 12, color: '#888', marginLeft: 8 }}>{meta.total} 部</span>
            ) : null}
          </h2>
        </div>
      }
      loading={loading}
      loadingMore={loadingMore}
      hasMore={hasMore}
      error={error}
      hasItems={items.length > 0}
      onRetry={reload}
      onRetryMore={retryMore}
      onLoadMore={loadMore}
      contentKey={items.length}
      empty={
        items.length === 0 && !loading ? (
          <EmptyState
            icon={<IconFilm size={40} />}
            text="没有找到相关短剧"
            sub="换个关键词试试，比如「王妈」「逆袭」"
          />
        ) : null
      }
    >
      {/* 行式列表（对齐榜单样式）：搜索结果带简介/标签/集数，无排名时不显示名次徽章 */}
      <RankList items={items} />
    </ListShell>
  );
}
