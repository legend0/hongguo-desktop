import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { ErrorTip, Loading } from './Feedback';

interface ListShellProps {
  /** 固定区：标题 + 类型切换按钮（不随列表滚动） */
  head: ReactNode;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  onRetry: () => void;
  onLoadMore: () => void;
  /** 空态 */
  empty?: ReactNode;
  /** 列表内容（滚动区） */
  children: ReactNode;
}

/**
 * 列表页骨架：头部固定（标题 + 筛选按钮），列表独立滚动，
 * 触底前 600px 自动加载下一页。
 */
export function ListShell({
  head,
  loading,
  loadingMore,
  hasMore,
  error,
  onRetry,
  onLoadMore,
  empty,
  children,
}: ListShellProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // 防抖标记：一次触底只触发一次加载
  const lockRef = useRef(false);
  // 上一次自动续载时的内容高度：若两次高度相同（新页全是去重掉的重复项），停止自动续载避免死循环
  const lastAutoHeightRef = useRef(0);

  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el || lockRef.current) return;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 600;
    if (nearBottom) {
      lockRef.current = true;
      onLoadMore();
    }
  }, [onLoadMore]);

  // 内容不足一屏（无滚动空间）时自动续载下一页，直到产生滚动条或没有更多。
  // 兜底分页条数少于屏幕可容纳行数的场景（如高分屏全屏 + 每页 15/20 条）。
  useEffect(() => {
    if (loading) {
      lastAutoHeightRef.current = 0; // 重载（切筛选/重试）时清零，允许重新自动续载
      return;
    }
    if (loadingMore || !hasMore || error) return;
    const el = bodyRef.current;
    if (!el || el.scrollHeight > el.clientHeight) return;
    if (lastAutoHeightRef.current === el.scrollHeight) return;
    lastAutoHeightRef.current = el.scrollHeight;
    onLoadMore();
  }, [loading, loadingMore, hasMore, error, onLoadMore, children]);

  // 加载结束后释放锁
  if (!loadingMore && lockRef.current) lockRef.current = false;

  return (
    <div className="page list-page">
      <div className="list-head">{head}</div>
      <div className="list-body" ref={bodyRef} onScroll={onScroll}>
        {loading ? <Loading /> : null}
        {error ? <ErrorTip message={error} onRetry={onRetry} /> : null}

        {!loading && !error ? (
          <>
            {children}
            {loadingMore ? <Loading /> : null}
            {!hasMore && !loadingMore ? (
              <div className="list-end">已经到底了</div>
            ) : null}
            {empty}
          </>
        ) : null}
      </div>
    </div>
  );
}
