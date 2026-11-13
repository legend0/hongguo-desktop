import type { ReactNode } from 'react';
import { IconFilm, IconWarning } from './Icons';

interface EmptyStateProps {
  icon?: ReactNode;
  text: string;
  sub?: string;
  children?: ReactNode;
}

/** 空状态占位 */
export function EmptyState({ icon, text, sub, children }: EmptyStateProps) {
  return (
    <div className="center-tip">
      <div className="big">{icon ?? <IconFilm size={40} />}</div>
      <div>{text}</div>
      {sub ? <div className="sub">{sub}</div> : null}
      {children ? <div style={{ marginTop: 16 }}>{children}</div> : null}
    </div>
  );
}

/** 加载占位 */
export function Loading() {
  return <div className="spinner" aria-label="加载中" />;
}

/** 错误占位（含重试） */
export function ErrorTip({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="center-tip">
      <div className="big warn">
        <IconWarning size={40} />
      </div>
      <div className="error-tip">页面解析失败：{message}</div>
      {onRetry ? (
        <button className="btn ghost" style={{ marginTop: 16 }} onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}
