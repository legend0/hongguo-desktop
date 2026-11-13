import { useEffect, useState } from 'react';
import { api } from '../api';
import { IconClose, IconMinimize } from './Icons';

/**
 * 主窗口关闭确认弹窗：
 * 点击关闭按钮 / Alt+F4 时询问用户"退出应用"还是"最小化到托盘"，
 * 支持记住选择（localStorage hg-close-action，并同步主进程用于系统级关闭）。
 * UI 对齐桌面端深色主题（--bg-panel / --radius-control / 品牌渐变）。
 */

const LS_KEY = 'hg-close-action';
export type CloseActionPref = 'quit' | 'tray';

/** 读取记住的关闭偏好；未记住返回 'ask'（每次询问） */
export function readCloseActionPref(): CloseActionPref | 'ask' {
  const v = localStorage.getItem(LS_KEY);
  return v === 'quit' || v === 'tray' ? v : 'ask';
}

/** 顶栏关闭按钮入口：有记住的偏好直接执行，否则触发关闭确认弹窗 */
export function requestClose(): void {
  const pref = readCloseActionPref();
  if (pref === 'quit') void api.win.quitApp();
  else if (pref === 'tray') void api.win.hideToTray();
  else window.dispatchEvent(new Event('hg:request-close'));
}

interface CloseConfirmModalProps {
  open: boolean;
  onClose: () => void;
}

export function CloseConfirmModal({ open, onClose }: CloseConfirmModalProps) {
  const [remember, setRemember] = useState(false);

  // 每次重新打开时重置记住选择
  useEffect(() => {
    if (!open) setRemember(false);
  }, [open]);

  // Escape 取消
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const choose = (action: CloseActionPref) => {
    // 先关弹窗再执行动作：否则最小化到托盘恢复后弹窗仍停留在打开状态
    onClose();
    if (remember) {
      localStorage.setItem(LS_KEY, action);
      void api.win.setCloseAction(action);
    }
    void (action === 'quit' ? api.win.quitApp() : api.win.hideToTray());
  };

  return (
    <div className="cc-overlay" onMouseDown={onClose}>
      <div
        className="cc-modal"
        role="dialog"
        aria-modal="true"
        aria-label="关闭确认"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cc-badge">
          <IconClose size={18} />
        </div>
        <h3 className="cc-title">关闭 黑果短剧</h3>
        <p className="cc-desc">退出应用，或最小化到系统托盘随时回来</p>
        <div className="cc-options">
          <button className="cc-option primary" onClick={() => choose('tray')}>
            <span className="cc-option-icon tray">
              <IconMinimize size={15} />
            </span>
            <span className="cc-option-title">最小化到托盘</span>
            <span className="cc-option-sub">单击托盘图标恢复</span>
          </button>
          <button className="cc-option" onClick={() => choose('quit')}>
            <span className="cc-option-icon quit">
              <IconClose size={14} />
            </span>
            <span className="cc-option-title">退出应用</span>
            <span className="cc-option-sub">完全关闭，后台不保留</span>
          </button>
        </div>
        <label className="cc-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          记住我的选择，下次不再询问
        </label>
        <button className="cc-cancel" onClick={onClose}>
          取消
        </button>
      </div>
    </div>
  );
}
