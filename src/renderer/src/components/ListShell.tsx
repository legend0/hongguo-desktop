import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useCacheActive } from './KeepAlive';
import { ErrorTip, Loading } from './Feedback';
import { toast } from './Toast';

interface ListShellProps {
  /** 固定区：标题 + 类型切换按钮（不随列表滚动） */
  head: ReactNode;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  /** 列表是否已有内容：有内容时追加页失败不再整页替换，保留列表 + 底部重试 */
  hasItems: boolean;
  onRetry: () => void;
  /** 手动重试追加页（底部重试按钮；不受失败冷却限制） */
  onRetryMore: () => void;
  onLoadMore: () => void;
  /** 内容版本号（列表条数，任务 87）：替代 children 依赖驱动"不足一屏自动续载"复查，
   *  children 每次渲染都是新 JSX 引用，作为依赖会让该 effect 在每次渲染都执行强制 reflow */
  contentKey?: number;
  /** 空态 */
  empty?: ReactNode;
  /** 列表内容（滚动区） */
  children: ReactNode;
}

/**
 * 列表页骨架：头部固定（标题 + 筛选按钮），列表独立滚动，
 * 触底前 600px 自动加载下一页。
 * 分页容错：首屏失败显示整页错误；追加页失败保留已有列表，
 * 错误信息经 toast 提示，列表底部显示重试按钮。
 */
export function ListShell({
  head,
  loading,
  loadingMore,
  hasMore,
  error,
  hasItems,
  onRetry,
  onRetryMore,
  onLoadMore,
  contentKey,
  empty,
  children,
}: ListShellProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // 防抖标记：一次触底只触发一次加载
  const lockRef = useRef(false);
  // 上一次自动续载时的内容高度：若两次高度相同（新页全是去重掉的重复项），停止自动续载避免死循环
  const lastAutoHeightRef = useRef(0);
  // KeepAlive 休眠前的滚动位置：display:none 会重置 scrollTop，恢复激活时写回（任务 79）
  const scrollTopRef = useRef(0);
  // 缓存层激活状态（非缓存环境恒为 true，effect 只在状态变化时恢复/记录一次）
  const active = useCacheActive();
  // 失活记录在 render 阶段：DOM 尚未隐藏，能读到真实滚动位置（useEffect 里读时已归零）
  if (!active) {
    const el = bodyRef.current;
    if (el) scrollTopRef.current = el.scrollTop;
  }
  useEffect(() => {
    if (!active) return;
    const el = bodyRef.current;
    if (!el) return;
    const top = scrollTopRef.current;
    // 恢复激活：等一帧布局完成（display:none → 恢复显示）后写回滚动位置
    requestAnimationFrame(() => {
      el.scrollTop = top;
    });
  }, [active]);
  // 追加失败是否已 toast 过：避免同一次失败在依赖变化时重复提示
  const toastedErrRef = useRef<string | null>(null);

  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el || lockRef.current) return;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 600;
    if (nearBottom) {
      lockRef.current = true;
      onLoadMore();
    }
  }, [onLoadMore]);

  // 追加页失败且已有内容：错误信息只 toast 一次（整页错误走 ErrorTip，不 toast）
  useEffect(() => {
    if (error && hasItems && toastedErrRef.current !== error) {
      toastedErrRef.current = error;
      toast(error);
    }
  }, [error, hasItems]);

  // 内容不足一屏（无滚动空间）时自动续载下一页，直到产生滚动条或没有更多。
  // 兜底分页条数少于屏幕可容纳行数的场景（如高分屏全屏 + 每页 15/20 条）。
  // 内容变化经 contentKey（条数）驱动复查，避免 children 引用不稳定造成每次渲染 reflow（任务 87）
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
  }, [loading, loadingMore, hasMore, error, onLoadMore, contentKey]);

  // 加载结束后释放锁
  if (!loadingMore && lockRef.current) lockRef.current = false;

  // 有内容时的追加失败：保留列表内容，底部显示重试
  const appendFailed = !!error && hasItems && !loading;

  return (
    <div className="page list-page">
      <div className="list-head">{head}</div>
      <div className="list-body" ref={bodyRef} onScroll={onScroll}>
        {loading ? <Loading /> : null}
        {error && !hasItems ? <ErrorTip message={error} onRetry={onRetry} /> : null}

        {!loading && (!error || hasItems) ? (
          <>
            {children}
            {loadingMore ? <Loading /> : null}
            {appendFailed ? (
              <div className="list-retry">
                <span className="list-retry-msg">加载失败</span>
                <button className="btn ghost" onClick={onRetryMore}>
                  重试
                </button>
              </div>
            ) : null}
            {!hasMore && !loadingMore && !appendFailed ? (
              <div className="list-end">已经到底了</div>
            ) : null}
            {empty}
          </>
        ) : null}
      </div>
    </div>
  );
}
