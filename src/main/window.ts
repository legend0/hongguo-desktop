import { app, BrowserWindow, Menu, Tray, ipcMain } from 'electron';
import { join } from 'path';

/**
 * 主窗口与托盘管理：
 * - 主窗口创建（无边框）与开发工具开关
 * - 关闭确认状态机：ask（每次询问）/ quit（直接退出）/ tray（最小化到托盘）
 *   记住的选择由渲染层经 win:setCloseAction 同步到主进程，用于 Alt+F4 等系统级关闭
 * - 托盘：单击恢复窗口，菜单 显示主窗口/退出；应用名称 黑果短剧
 */

/** 关闭行为偏好：ask=每次询问（默认） */
export type CloseAction = 'ask' | 'quit' | 'tray';

/** 主进程侧关闭状态（Alt+F4 等系统级关闭时渲染层无法先行判断，由主进程记忆） */
export const appState: { closeAction: CloseAction; quitting: boolean } = {
  closeAction: 'ask',
  quitting: false,
};

/** 关闭确认兜底定时器：ask 转发渲染层后 3s 无响应则隐藏到托盘（防止弹窗事件丢失后窗口无法关闭） */
let closeFallbackTimer: ReturnType<typeof setTimeout> | null = null;

/** 清除关闭确认兜底定时器（渲染层经 win:closeResponded 通知已响应时调用） */
function clearCloseFallback(): void {
  if (closeFallbackTimer) {
    clearTimeout(closeFallbackTimer);
    closeFallbackTimer = null;
  }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

/**
 * 托盘图标（用户提供的 logo）：
 * 打包后经 extraResources 位于 <安装目录>/resources/icon.png（process.resourcesPath）；
 * 开发态位于 <appPath>/resources/icon.png
 */
function trayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'resources', 'icon.png');
}

/** 显示并聚焦主窗口（托盘单击/菜单、second-instance 共用） */
export function showMainWindow(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** 隐藏主窗口到托盘（从任务栏消失，托盘图标保留） */
export function hideMainWindowToTray(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  createTray();
  win.hide();
}

/** 真正退出应用（will-quit 钩子会关闭流端点） */
export function quitApp(): void {
  appState.quitting = true;
  app.quit();
}

/** 创建托盘（幂等）：图标 icon.png，tooltip/菜单使用应用名 黑果短剧 */
export function createTray(): void {
  if (tray) return;
  try {
    tray = new Tray(trayIconPath());
    tray.setToolTip('黑果短剧');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主窗口', click: () => showMainWindow() },
        { type: 'separator' },
        { label: '退出 黑果短剧', click: () => quitApp() },
      ]),
    );
    // Windows 惯例：单击托盘图标恢复窗口
    tray.on('click', () => showMainWindow());
  } catch (err) {
    // 图标缺失等异常不应阻断应用运行
    console.error('[hongguo] 托盘创建失败', err);
    tray = null;
  }
}

export function createMainWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1080,
    minHeight: 680,
    frame: false,
    backgroundColor: '#16161d',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;

  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => win.webContents.send('win:maximized-changed', true));
  win.on('unmaximize', () => win.webContents.send('win:maximized-changed', false));

  // ===== 关闭拦截（仅主窗口）=====
  // Alt+F4 / 任务栏关闭等系统级关闭也走这里；渲染层"关闭"按钮同样触发 win.close()
  win.on('close', (e) => {
    if (appState.quitting) return; // 真正退出：放行
    e.preventDefault();
    if (appState.closeAction === 'tray') {
      hideMainWindowToTray();
      return;
    }
    // ask：交给渲染层弹关闭确认弹窗；3s 内未响应（渲染层未挂监听/卡死）则兜底隐藏到托盘，
    // 保证关闭动作总有去处（托盘菜单"退出"仍可真正退出）
    win.webContents.send('win:close-requested');
    clearCloseFallback();
    closeFallbackTimer = setTimeout(() => {
      closeFallbackTimer = null;
      const w = mainWindow;
      if (w && !w.isDestroyed() && w.isVisible() && !appState.quitting) {
        hideMainWindowToTray();
      }
    }, 3000);
  });

  // ===== 控制台调试模式 =====
  // 触发方式（任一）：
  //   1. 运行时按 F12 或 Ctrl+Shift+I 开关
  //   2. 环境变量 HONGGUO_DEVTOOLS=1 启动时自动打开
  //   3. 开发模式（pnpm dev）默认自动打开
  const isDev = Boolean(process.env['ELECTRON_RENDERER_URL']);
  const forceDevtools = process.env['HONGGUO_DEVTOOLS'] === '1';
  if (isDev || forceDevtools) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const isF12 = input.key === 'F12';
    const isCtrlShiftI =
      input.control && input.shift && (input.key === 'I' || input.key === 'i');
    if (isF12 || isCtrlShiftI) {
      win.webContents.toggleDevTools();
    }
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// ===== 关闭行为 IPC（窗口管理状态在本模块，故随托盘一起注册） =====

export function registerWindowIpc(): void {
  ipcMain.handle('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.handle('win:toggleMaximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.handle('win:isMaximized', (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false);
  /** 最小化到托盘 */
  ipcMain.handle('win:hideToTray', () => hideMainWindowToTray());
  /** 真正退出应用 */
  ipcMain.handle('win:quitApp', () => quitApp());
  /** 渲染层同步"记住的关闭选择"，主进程用于 Alt+F4 等系统级关闭 */
  ipcMain.handle('win:setCloseAction', (_e, action: CloseAction) => {
    appState.closeAction = action === 'quit' || action === 'tray' ? action : 'ask';
  });
  /** 渲染层已响应关闭确认弹窗（选择/取消均可），清除 3s 兜底定时器 */
  ipcMain.handle('win:closeResponded', () => clearCloseFallback());
}
