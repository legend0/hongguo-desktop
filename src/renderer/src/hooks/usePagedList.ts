import { useCallback, useEffect, useRef, useState } from 'react';

export interface PagedResult<T, M = unknown> {
  items: T[];
  /** 是否还有下一页；不传时按「返回 0 条 = 到底」判断 */
  hasMore?: boolean;
  /** 附加数据（如榜单 tabs），每页覆盖更新 */
  meta?: M;
}

/**
 * 无限滚动分页 hook：
 * - resetKey 变化时重置并加载第 1 页
 * - loadMore() 追加下一页（按 id 去重、过期响应丢弃）
 * - loading=首屏加载，loadingMore=追加中
 */
export function usePagedList<T extends { id: string }, M = unknown>(
  fetchPage: (page: number) => Promise<PagedResult<T, M>>,
  resetKey: string,
) {
  const [items, setItems] = useState<T[]>([]);
  const [meta, setMeta] = useState<M | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const seq = useRef(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const load = useCallback(async (p: number, replace: boolean) => {
    const mySeq = ++seq.current;
    if (replace) setLoading(true);
    else setLoadingMore(true);
    setError(null);
    try {
      const r = await fetchRef.current(p);
      if (mySeq !== seq.current) return; // 已有更新的请求，丢弃
      setItems((prev) => {
        if (replace) return r.items;
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...r.items.filter((x) => !seen.has(x.id))];
      });
      setMeta(r.meta);
      setHasMore(r.hasMore ?? r.items.length > 0);
    } catch (e) {
      if (mySeq === seq.current) {
        setError(e instanceof Error ? e.message : String(e));
        if (replace) {
          // 首屏失败：数据为空，置 hasMore=false 停止翻页
          setHasMore(false);
        } else {
          // 追加页失败：回滚页码并保留 hasMore，滚动重试仍会请求同一页
          setPage((prev) => Math.max(1, prev - 1));
        }
      }
    } finally {
      if (mySeq === seq.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  // resetKey 变化：重置并加载第一页
  useEffect(() => {
    setItems([]);
    setMeta(undefined);
    setPage(1);
    setHasMore(true);
    void load(1, true);
  }, [resetKey, load]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasMore) return;
    const next = page + 1;
    setPage(next);
    void load(next, false);
  }, [page, loading, loadingMore, hasMore, load]);

  const reload = useCallback(() => {
    setPage(1);
    setHasMore(true);
    void load(1, true);
  }, [load]);

  return { items, meta, loading, loadingMore, error, hasMore, loadMore, reload };
}
