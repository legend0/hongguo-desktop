import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { DramaCardView } from '../components/DramaCard';
import { ListShell } from '../components/ListShell';
import { usePagedList } from '../hooks/usePagedList';
import { CATEGORY_MAINS } from '../types';
import type { CategorySub } from '../types';

/**
 * 分类页：主分类由侧边栏直达（/category/:main）。
 * 头部固定（标题 + 子标签筛选），列表独立滚动、触底自动加载下一页。
 * 数据源：App 端目录协议（子标签为协议返回的题材列表）。
 */
export function CategoryPage() {
  const { main = 'real-drama' } = useParams();
  const [sub, setSub] = useState(''); // '' = 全部

  // 切换主分类时重置子标签
  useEffect(() => setSub(''), [main]);

  const { items, meta, loading, loadingMore, error, hasMore, loadMore, reload } =
    usePagedList(
      (page) =>
        api
          .getCategory(main, sub || undefined, page)
          .then((r) => ({ items: r.items, meta: { subs: r.subs } })),
      `${main}|${sub}`,
    );

  const subs: CategorySub[] = meta?.subs ?? [];
  const label = CATEGORY_MAINS.find((m) => m.key === main)?.label ?? '分类';

  return (
    <ListShell
      head={
        <>
          <div className="section-head">
            <h2>{label}</h2>
            <span className="more">{items.length} 部作品</span>
          </div>
          {subs.length > 0 ? (
            <div className="chips">
              {subs.map((s) => (
                <button
                  key={s.key || 'all'}
                  className={`chip${s.key === sub ? ' on' : ''}`}
                  onClick={() => setSub(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          ) : null}
        </>
      }
      loading={loading}
      loadingMore={loadingMore}
      hasMore={hasMore}
      error={error}
      onRetry={reload}
      onLoadMore={loadMore}
      empty={
        items.length === 0 ? <div className="center-tip">该分类暂无内容</div> : null
      }
    >
      <div className="grid">
        {items.map((d) => (
          <DramaCardView key={d.id} drama={d} />
        ))}
      </div>
    </ListShell>
  );
}
