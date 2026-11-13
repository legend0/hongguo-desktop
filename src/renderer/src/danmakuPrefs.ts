/**
 * 弹幕显示偏好（播放器控制栏与设置页共享的单一数据源）。
 * 存储键 hg-player-danmaku（localStorage），PlayerPage 与 SettingsPage 均通过
 * 本模块读写，避免两处实现漂移。
 */

/** 弹幕速度档位：屏幕宽度 / 系数 = 全屏滚动秒数（与参考实现一致） */
export const DM_SPEEDS = { fast: 12, medium: 16, slow: 20 } as const;
/** 弹幕可选行数（行高 32px） */
export const DM_ROW_OPTIONS = [1, 3, 5] as const;
/** 弹幕行高（px），层高 = 行数 × 行高 */
export const DM_ROW_HEIGHT = 32;

/** 弹幕显示偏好（本地持久化） */
export interface DanmakuPrefs {
  enabled: boolean;
  rows: number;
  speed: keyof typeof DM_SPEEDS;
  opacity: number;
  likesPriority: boolean;
}

/** 默认弹幕偏好 */
export const DM_PREFS_DEFAULT: DanmakuPrefs = { enabled: true, rows: 3, speed: 'medium', opacity: 0.8, likesPriority: true };

const LS_KEY = 'hg-player-danmaku';

/**
 * 读取本地弹幕偏好；缺失/损坏时回退默认值。
 * @returns {DanmakuPrefs} 校验后的完整偏好
 */
export function readDanmakuPrefs(): DanmakuPrefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DM_PREFS_DEFAULT;
    const p = JSON.parse(raw) as Partial<DanmakuPrefs>;
    return {
      enabled: typeof p.enabled === 'boolean' ? p.enabled : DM_PREFS_DEFAULT.enabled,
      rows: DM_ROW_OPTIONS.includes((p.rows as typeof DM_ROW_OPTIONS[number]) ?? 3)
        ? (p.rows as number)
        : DM_PREFS_DEFAULT.rows,
      speed: p.speed && p.speed in DM_SPEEDS ? p.speed : DM_PREFS_DEFAULT.speed,
      opacity: typeof p.opacity === 'number' && p.opacity > 0 && p.opacity <= 1 ? p.opacity : DM_PREFS_DEFAULT.opacity,
      likesPriority: typeof p.likesPriority === 'boolean' ? p.likesPriority : DM_PREFS_DEFAULT.likesPriority,
    };
  } catch {
    return DM_PREFS_DEFAULT;
  }
}

/**
 * 写回本地弹幕偏好（整体覆盖）。
 * @param prefs 完整偏好对象
 */
export function writeDanmakuPrefs(prefs: DanmakuPrefs): void {
  localStorage.setItem(LS_KEY, JSON.stringify(prefs));
}
