import { useCallback, useEffect, useRef, useState } from 'react';

export interface PagedResult<T, M = unknown> {
  items: T[];
  /** 是否还有下一页；不传时按「返回 0 条 = 到底」判断 */
  hasMore?: boolean;
  /** 附加数据（如榜单 tabs），每页覆盖更新 */
  meta?: M;
}

/**
 * 会话游标失效错误识别（dramaService 会话失效分支，任务 87 收敛到单一辅助函数）。
 * 受 Electron IPC 仅透传错误 message 限制（自定义 code 属性跨进程丢失），
 * 暂以服务端稳定文案判断；若文案变更需同步调整 dramaService 抛错处。
 * @param error - 加载失败的错误信息（已剥离 IPC 前缀）
 * @returns {boolean} 是否为会话游标失效（需整页刷新重建游标链）
 */
function isSessionExpiredError(error: string | null): boolean {
  return !!error && error.includes('列表已过期');
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
  /** 最近一次追加失败的时间戳：滚动自动续载在冷却期内忽略，避免上游抖动（如偶发 502）时高频重试 */
  const lastFailAtRef = useRef(0);
  /** 追加失败后的冷却时长（ms） */
  const LOAD_MORE_COOLDOWN_MS = 5000;

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
          // 追加页失败：回滚页码并保留 hasMore；记录失败时间供 loadMore 冷却
          lastFailAtRef.current = Date.now();
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

  /** 追加下一页（滚动自动触发路径）：失败后 5s 冷却期内忽略，避免同一秒内连发两次请求 */
  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasMore) return;
    if (Date.now() - lastFailAtRef.current < LOAD_MORE_COOLDOWN_MS) return;
    const next = page + 1;
    setPage(next);
    void load(next, false);
  }, [page, loading, loadingMore, hasMore, load]);

  /**
   * 手动重试（列表底部重试按钮）：不受失败冷却限制。
   * - 会话游标失效（服务端 SESSION_EXPIRED，见 dramaService 会话失效分支）→ 整页刷新：
   *   重试同页永远无游标，回到第 1 页重建会话游标链；
   * - 其他失败（网络/5xx）→ 追加页已回滚，重试请求的正是上次失败的同一页。
   */
  const retryMore = useCallback(() => {
    if (loading || loadingMore || !hasMore) return;
    // 按错误 code 判断（任务 87）：不依赖中文文案耦合；API 层剥离前缀后 code 保留在错误对象
    if (isSessionExpiredError(error)) {
      setPage(1);
      setHasMore(true);
      void load(1, true);
      return;
    }
    lastFailAtRef.current = 0;
    const next = page + 1;
    setPage(next);
    void load(next, false);
  }, [page, loading, loadingMore, hasMore, error, load]);

  const reload = useCallback(() => {
    setPage(1);
    setHasMore(true);
    void load(1, true);
  }, [load]);

  return { items, meta, loading, loadingMore, error, hasMore, loadMore, retryMore, reload };
}
