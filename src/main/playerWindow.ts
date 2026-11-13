import { BrowserWindow } from 'electron';
import { join } from 'path';

/**
 * 播放器独立窗口（无边框）：详情页/选集点击"播放"时由主进程创建。
 * - 全局单例：已存在时 focus 并发送 player:open 事件让窗口内路由切集
 * - 复用同一 preload，渲染层 window.hongguo 能力完全一致
 */
let playerWin: BrowserWindow | null = null;

export function createPlayerWindow(seriesId: string, itemId: string): void {
  if (playerWin && !playerWin.isDestroyed()) {
    playerWin.focus();
    playerWin.webContents.send('player:open', { seriesId, itemId });
    return;
  }

  playerWin = new BrowserWindow({
    width: 1080,
    height: 660,
    minWidth: 320, // 沉浸式：宽度会跟随竖屏视频比例收窄
    minHeight: 420,
    frame: false, // 无边框：标题由播放器顶部栏自己画（可拖拽 + 关闭按钮）
    backgroundColor: '#000000',
    show: false,
    title: '黑果短剧 · 播放',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  playerWin.once('ready-to-show', () => playerWin?.show());
  playerWin.on('closed', () => {
    playerWin = null;
  });

  // ===== 控制台调试模式（与主窗口一致）：F12 / Ctrl+Shift+I 开关 DevTools =====
  playerWin.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const isF12 = input.key === 'F12';
    const isCtrlShiftI =
      input.control && input.shift && (input.key === 'I' || input.key === 'i');
    if (isF12 || isCtrlShiftI) {
      playerWin?.webContents.toggleDevTools();
    }
  });

  const hash = itemId ? `#/player/${seriesId}/${itemId}` : `#/player/${seriesId}`;
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    const base = devUrl.endsWith('/') ? devUrl : `${devUrl}/`;
    void playerWin.loadURL(`${base}${hash}`);
  } else {
    void playerWin.loadFile(join(__dirname, '../renderer/index.html'), { hash });
  }
}
