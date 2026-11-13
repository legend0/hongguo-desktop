import { useEffect } from 'react';
import { useSettings, type ThemeMode } from '../stores';

/**
 * 主题模式应用：把设置中的 theme（dark/light/system）解析为实际主题，
 * 写入 <html data-theme="...">，亮色样式由 CSS 变量覆盖实现。
 * system 模式下监听系统配色变化实时跟随。主窗口与播放器独立窗口均调用。
 * @returns 实际生效的主题（'dark' | 'light'），用于图标等 UI 判定
 */
export function useTheme(): 'dark' | 'light' {
  const theme = useSettings().theme;

  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved: 'dark' | 'light' = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme;
      root.dataset.theme = resolved;
    };
    apply();
    if (theme !== 'system') return;
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  // 渲染期同步读一次系统配色（首帧即正确，避免闪烁后回调再切换）
  return theme === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
    : theme;
}

/** 主题循环顺序：暗色 → 亮色 → 跟随系统 → 暗色 */
export const THEME_CYCLE: ThemeMode[] = ['dark', 'light', 'system'];

/** 下一个主题模式 */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  return THEME_CYCLE[(THEME_CYCLE.indexOf(mode) + 1) % THEME_CYCLE.length];
}
