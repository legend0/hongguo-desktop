import { useEffect, useState, type CSSProperties } from 'react';
import { useSettings, useAccount, accountStore, pullCloudAll, refreshAccountStatus, resetProgressReport } from '../stores';
import { api } from '../api';
import { toast } from '../components/Toast';
import { useUpdaterState } from '../updater';
import { IconLogout, IconSync, IconUser } from '../components/Icons';
import {
  DM_PREFS_DEFAULT,
  DM_ROW_OPTIONS,
  DM_SPEEDS,
  readDanmakuPrefs,
  writeDanmakuPrefs,
} from '../danmakuPrefs';
import type { DanmakuPrefs } from '../danmakuPrefs';

type AuthState = { token: string; savedAt: number } | null;

const SPEEDS = [1.0, 1.25, 1.5, 2.0];

/** 设置页左侧索引项（锚定右侧对应分组） */
const SECTIONS = [
  { key: 'account', label: '登录' },
  { key: 'player', label: '播放器' },
  { key: 'danmaku', label: '弹幕' },
  { key: 'app', label: '应用' },
  { key: 'keys', label: '快捷键' },
  { key: 'about', label: '关于' },
] as const;
type SectionKey = (typeof SECTIONS)[number]['key'];

/** 自定义滑动条填充比例（CSS 变量 --fill，配合 .hg-range 渐变轨道） */
const fillStyle = (v: number): CSSProperties =>
  ({ '--fill': `${Math.round(v * 100)}%` }) as CSSProperties;

/**
 * 设置页：左侧索引 + 右侧设置内容区。
 * 分组：播放器（连播/进度/倍速）、弹幕（与播放器控制栏同源偏好）、应用（自启动）、关于。
 */
export function SettingsPage() {
  const settings = useSettings();
  const acct = useAccount();
  const [syncing, setSyncing] = useState(false);
  const updateState = useUpdaterState();
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const [active, setActive] = useState<SectionKey>('account');
  const [dmPrefs, setDmPrefs] = useState<DanmakuPrefs>(() => readDanmakuPrefs());
  const [authState, setAuthState] = useState<AuthState>(null);
  const [appVersion, setAppVersion] = useState('…');
  const [tokenInput, setTokenInput] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [phone, setPhone] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [smsTicket, setSmsTicket] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);

  useEffect(() => {
    // 初始态查询失败静默降级（任务 87）：保持默认值，不打断设置页渲染
    void api.app.getLoginItem().then(setOpenAtLogin).catch(() => {});
    void api.getAuthState().then(setAuthState).catch(() => {});
    void api.app.getVersion().then(setAppVersion).catch(() => setAppVersion('0.1.0'));
  }, []);

  // ===== 检查更新（任务 66） =====
  const [checking, setChecking] = useState(false);

  /** 手动检查：不自动取消（主进程状态机必然以 available/downloaded/idle/error 收尾） */
  const checkNow = () => {
    if (checking) return;
    setChecking(true);
    void api.updater.check();
  };
  // 检查进入收尾阶段（离开 checking）即恢复按钮；仅手动检查给轻提示（启动/定时自动检查静默，任务 69）
  useEffect(() => {
    if (updateState.phase === 'checking') return;
    setChecking(false);
    if (updateState.phase === 'idle' && updateState.manual) toast('当前已是最新版本');
  }, [updateState.phase, updateState.manual]);

  /** 「检查更新」行的状态说明（与主进程状态机逐段对应，任务 66-B） */
  const upStatusText = (() => {
    const s = updateState;
    if (!s.supported) return '便携版 / 开发模式不支持自动更新';
    switch (s.phase) {
      case 'checking': return '正在检查更新…';
      case 'available': return `发现新版本 v${s.version}（当前 v${appVersion}），点击「立即升级」开始下载`;
      case 'downloading': return `新版本 v${s.version || '?'} 下载中 ${s.progress}%${
        s.bps > 0 ? `（${(s.bps / 1048576).toFixed(1)} MB/s）` : ''}`;
      case 'downloaded': return `v${s.version} 下载完成，正在重启安装…`;
      case 'error': return `上次检查失败：${s.error || '未知原因'}`;
      case 'idle': return `当前已是最新版本（v${appVersion}）`;
      default: return '';
    }
  })();

  /** 「立即升级」：触发主进程下载，全局更新弹窗随之切换为下载进度（任务 66-B） */
  const startUpgrade = () => {
    void api.updater.download().then((ok) => {
      if (!ok) toast('当前状态无法开始下载，请重新检查更新');
    });
  };

  /** 保存粘贴的 x-tt-token（主进程校验归一化，失败给 toast） */
  const saveToken = () => {
    if (!tokenInput.trim() || authBusy) return;
    setAuthBusy(true);
    api.setAuthToken(tokenInput)
      .then((state) => {
        setAuthState(state);
        setTokenInput('');
        toast('登录态已保存，匿名配额限制解除');
      })
      .catch((e) => toast(String((e as Error)?.message ?? e)))
      .finally(() => setAuthBusy(false));
  };

  /** 清除登录态恢复匿名运行 */
  const resetToken = () => {
    if (authBusy) return;
    setAuthBusy(true);
    api.clearAuthToken()
      .then(() => {
        setAuthState(null);
        toast('已清除登录态，恢复匿名观看');
      })
      .catch((e) => toast(String((e as Error)?.message ?? e)))
      .finally(() => setAuthBusy(false));
  };

  /** 发送登录验证码（成功保存 mobile_ticket 供提交登录时携带） */
  const sendCode = () => {
    if (codeBusy) return;
    setCodeBusy(true);
    api.sendLoginCode(phone)
      .then((r) => {
        setSmsTicket(r.mobileTicket);
        toast('验证码已发送，请查收短信');
      })
      .catch((e) => toast(String((e as Error)?.message ?? e)))
      .finally(() => setCodeBusy(false));
  };

  /** 验证码换登录态（token 由主进程持久化，成功后刷新状态并清空输入） */
  const submitCode = () => {
    if (loginBusy) return;
    setLoginBusy(true);
    api.submitLoginCode(phone, smsCode, smsTicket)
      .then((r) => {
        setAuthState({ token: r.token, savedAt: r.savedAt });
        setPhone('');
        setSmsCode('');
        setSmsTicket('');
        toast('登录成功，匿名配额限制解除');
      })
      .catch((e) => toast(String((e as Error)?.message ?? e)))
      .finally(() => setLoginBusy(false));
  };

  /** 更新弹幕偏好并整体写回（与播放器控制栏共享同一 localStorage 键） */
  const updateDmPrefs = (patch: Partial<DanmakuPrefs>) => {
    const next = { ...dmPrefs, ...patch };
    setDmPrefs(next);
    writeDanmakuPrefs(next);
  };

  const switchRow = (
    label: string,
    hint: string | null,
    value: boolean,
    onChange: (v: boolean) => void,
  ) => (
    <div className="setting-row">
      <div>
        {label}
        {hint ? <div className="hint">{hint}</div> : null}
      </div>
      <button
        className={`switch${value ? ' on' : ''}`}
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
      >
        <i />
      </button>
    </div>
  );

  const chipsRow = (label: string, node: React.ReactNode) => (
    <div className="setting-row">
      <div>{label}</div>
      <div className="speed-group">{node}</div>
    </div>
  );

  return (
    <div className="page page-pad" style={{ maxWidth: 960, margin: '0 auto' }}>
      <div className="section-head">
        <h2>设置</h2>
      </div>

      <div className="settings-layout">
        <aside className="settings-nav">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              className={`settings-nav-item${active === s.key ? ' on' : ''}`}
              onClick={() => setActive(s.key)}
            >
              {s.label}
            </button>
          ))}
        </aside>

        <div className="settings-panel">
          {/* 登录状态卡片（用户要求：设置页顶部，未登录显示默认卡片） */}
          {active === 'account' ? (
            <div className="settings-group">
              <h3>登录状态</h3>
              {acct.status === 'loggedIn' && acct.user ? (
                <>
                  <div className="setting-row acct-card-row">
                    <div className="acct-card-user">
                      <span className="acct-card-avatar">
                        {acct.user.avatar
                          ? <img src={acct.user.avatar} alt="" referrerPolicy="no-referrer" />
                          : <IconUser size={20} />}
                      </span>
                      <span className="acct-card-meta">
                        <span className="acct-card-name">{acct.user.name || '红果用户'}</span>
                        <span className="hint">ID {acct.user.userId || '—'} · 播放进度云端同步已开启</span>
                      </span>
                    </div>
                    <button
                      className="btn-ghost"
                      onClick={() => {
                        if (window.confirm('退出后播放进度将不再云端同步，确定退出？')) {
                          resetProgressReport();
                          void api.account.logout()
                            .then(() => { void refreshAccountStatus(); toast('已退出登录'); })
                            .catch((e) => toast(`退出失败：${String((e as Error)?.message ?? e)}`));
                        }
                      }}
                    >
                      <IconLogout size={13} /> 退出登录
                    </button>
                  </div>
                  <div className="setting-row">
                    <div>
                      立即同步
                      <div className="hint">把云端播放进度拉取合并到本机（本机观看自动上报云端）</div>
                    </div>
                    <button
                      className="btn-ghost"
                      disabled={syncing}
                      onClick={() => {
                        setSyncing(true);
                        pullCloudAll()
                          .then((r) => {
                            const parts: string[] = [];
                            if (r.history > 0) parts.push(`${r.history} 条播放进度`);
                            if (r.favorites > 0) parts.push(`${r.favorites} 条收藏`);
                            toast(parts.length > 0 ? `已从云端同步 ${parts.join('、')}` : '云端暂无新内容');
                          })
                          .catch((e) => toast(`同步失败：${String((e as Error)?.message ?? e)}`))
                          .finally(() => setSyncing(false));
                      }}
                    >
                      <IconSync size={13} /> {syncing ? '同步中…' : '同步'}
                    </button>
                  </div>
                </>
              ) : (
                <div className="setting-row acct-card-row">
                  <div className="acct-card-user">
                    <span className="acct-card-avatar"><IconUser size={20} /></span>
                    <span className="acct-card-meta">
                      <span className="acct-card-name">未登录</span>
                      <span className="hint">扫码登录红果账号，播放进度可在多设备间同步</span>
                    </span>
                  </div>
                  <button
                    className="btn-primary"
                    onClick={() => accountStore.setState({ loginModalOpen: true })}
                  >
                    扫码登录
                  </button>
                </div>
              )}
            </div>
          ) : null}

          {active === 'player' ? (
            <div className="settings-group">
              <h3>播放器</h3>
              {switchRow('自动连播', '一集播完自动播放下一集', settings.autoNext, (v) =>
                settings.update({ autoNext: v }),
              )}
              {switchRow('记住播放进度', '下次打开自动跳到上次位置', settings.rememberProgress, (v) =>
                settings.update({ rememberProgress: v }),
              )}
              {chipsRow(
                '默认倍速',
                SPEEDS.map((s) => (
                  <button
                    key={s}
                    className={`chip${settings.defaultSpeed === s ? ' on' : ''}`}
                    onClick={() => settings.update({ defaultSpeed: s })}
                  >
                    {s}x
                  </button>
                )),
              )}
            </div>
          ) : null}

          {active === 'danmaku' ? (
            <div className="settings-group">
              <h3>弹幕</h3>
              {switchRow('显示弹幕', '播放器内叠加显示弹幕', dmPrefs.enabled, (v) =>
                updateDmPrefs({ enabled: v }),
              )}
              {switchRow('高赞优先', '弹幕密集时优先显示高赞弹幕', dmPrefs.likesPriority, (v) =>
                updateDmPrefs({ likesPriority: v }),
              )}
              {chipsRow(
                '同时显示行数',
                DM_ROW_OPTIONS.map((n) => (
                  <button
                    key={n}
                    className={`chip${dmPrefs.rows === n ? ' on' : ''}`}
                    onClick={() => updateDmPrefs({ rows: n })}
                  >
                    {n} 行
                  </button>
                )),
              )}
              {chipsRow(
                '滚动速度',
                (Object.keys(DM_SPEEDS) as Array<keyof typeof DM_SPEEDS>).map((v) => (
                  <button
                    key={v}
                    className={`chip${dmPrefs.speed === v ? ' on' : ''}`}
                    onClick={() => updateDmPrefs({ speed: v })}
                  >
                    {{ fast: '快', medium: '中', slow: '慢' }[v]}
                  </button>
                )),
              )}
              <div className="setting-row">
                <div>
                  不透明度
                  <div className="hint">{Math.round(dmPrefs.opacity * 100)}%</div>
                </div>
                <input
                  type="range"
                  className="hg-range"
                  style={{ width: 160, ...fillStyle(dmPrefs.opacity) }}
                  min={10}
                  max={100}
                  step={5}
                  value={Math.round(dmPrefs.opacity * 100)}
                  onChange={(e) => {
                    const v = Number(e.target.value) / 100;
                    updateDmPrefs({ opacity: Number.isFinite(v) ? v : DM_PREFS_DEFAULT.opacity });
                  }}
                />
              </div>
              <div className="setting-row">
                <div className="hint">弹幕设置与播放器控制栏实时同步</div>
              </div>
            </div>
          ) : null}

          {active === 'app' ? (
            <div className="settings-group">
              <h3>应用</h3>
              {switchRow('开机自动启动', '登录系统后自动运行黑果短剧', openAtLogin, (v) => {
                void api.app.setLoginItem(v).then((ok) => {
                  setOpenAtLogin(ok);
                  toast(ok ? (v ? '已开启开机自启' : '已关闭开机自启') : '设置失败');
                });
              })}
              {/* 自动更新（任务 66）：仅安装版可用；便携版无固定安装目录不支持就地升级 */}
              {updateState.supported ? (
                switchRow(
                  '自动更新',
                  '启动时与每 6 小时自动检查新版本，发现更新后询问是否下载安装；关闭后仍可在「关于」手动检查',
                  settings.autoUpdate !== false,
                  (v) => settings.update({ autoUpdate: v }),
                )
              ) : (
                <div className="setting-row">
                  <div>
                    自动更新
                    <div className="hint">便携版 / 开发模式不支持自动更新，请前往 GitHub Releases 下载新版本</div>
                  </div>
                </div>
              )}
              {/* 登录态（x-tt-token）：匿名观看有约 9 集配额上限，登录态是可播性分水岭。
                  优先验证码自动登录，手动粘贴抓包 token 作为兜底。
                  任务 28：验证码自动登录换登录态已在协议层证死（aid=8662 拦截），登录态注入
                  效果待风控升级（任务 27）后重估，先隐藏设置入口；代码保留随时可恢复 */}
              {false ? (
              <div className="setting-row" style={{ alignItems: 'flex-start' }}>
                <div style={{ maxWidth: 560, width: '100%' }}>
                  登录态（x-tt-token）
                  <div className="hint" style={{ lineHeight: 1.7 }}>
                    {authState
                      ? `已启用登录态（保存于 ${new Date(authState?.savedAt ?? Date.now()).toLocaleString()}），播放/搜索/弹幕请求将携带 token，不再受匿名约 9 集配额限制`
                      : '未启用：匿名观看有约 9 集配额上限。可输入手机号获取短信验证码自动登录；也可从官方 App 抓包复制 x-tt-token 值手动粘贴（兜底方式）'}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <input
                      value={phone}
                      onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
                      placeholder="手机号（11 位）"
                      inputMode="numeric"
                      autoComplete="tel"
                      style={{
                        flex: 1, padding: '8px 10px', borderRadius: 8,
                        border: '1px solid var(--border, #333)', background: 'var(--bg-secondary, transparent)',
                        color: 'inherit', fontSize: 12,
                      }}
                    />
                    <button
                      className="chip"
                      disabled={codeBusy || !/^1\d{10}$/.test(phone)}
                      onClick={sendCode}
                    >
                      {codeBusy ? '发送中…' : '获取验证码'}
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <input
                      value={smsCode}
                      onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                      placeholder="短信验证码"
                      inputMode="numeric"
                      style={{
                        flex: 1, padding: '8px 10px', borderRadius: 8,
                        border: '1px solid var(--border, #333)', background: 'var(--bg-secondary, transparent)',
                        color: 'inherit', fontSize: 12,
                      }}
                    />
                    <button
                      className="chip"
                      disabled={loginBusy || !/^1\d{10}$/.test(phone) || !/^\d{4,8}$/.test(smsCode)}
                      onClick={submitCode}
                    >
                      {loginBusy ? '登录中…' : '验证码登录'}
                    </button>
                  </div>
                  <textarea
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder="粘贴 x-tt-token 值（支持整段 x-tt-token: xxx 或整段 Cookie 串复制）"
                    rows={3}
                    spellCheck={false}
                    style={{
                      width: '100%', marginTop: 8, padding: '8px 10px', borderRadius: 8,
                      border: '1px solid var(--border, #333)', background: 'var(--bg-secondary, transparent)',
                      color: 'inherit', fontSize: 12, fontFamily: 'monospace', resize: 'vertical',
                    } as CSSProperties}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button
                      className="chip"
                      disabled={authBusy || !tokenInput.trim()}
                      onClick={saveToken}
                    >
                      {authBusy ? '处理中…' : '保存登录态'}
                    </button>
                    {authState ? (
                      <button className="chip" disabled={authBusy} onClick={resetToken}>
                        清除登录态
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
              ) : null}
            </div>
          ) : null}

          {active === 'keys' ? (
            <div className="settings-group">
              <h3>快捷键</h3>
              {/* 全局与播放器快捷键一览（任务 70）：Alt+Q 为系统级全局键，应用在后台也生效 */}
              <div className="setting-row">
                <div>
                  老板键 Alt+Q
                  <div className="hint">
                    系统级全局快捷键（应用在后台也生效）：一键隐藏 / 恢复主窗口与播放器窗口，
                    隐藏时主窗口进入托盘
                  </div>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  聚焦搜索 <kbd className="kbd">Ctrl</kbd> + <kbd className="kbd">K</kbd>
                  <div className="hint">主窗口内快速跳转搜索框</div>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  播放 / 暂停 <kbd className="kbd">空格</kbd>
                  <div className="hint">播放器窗口内生效</div>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  快退 / 快进 5 秒 <kbd className="kbd">←</kbd> / <kbd className="kbd">→</kbd>
                  <div className="hint">播放器窗口内生效</div>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  音量增减 10% <kbd className="kbd">↑</kbd> / <kbd className="kbd">↓</kbd>
                  <div className="hint">播放器窗口内生效</div>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  全屏切换 <kbd className="kbd">F</kbd>
                  <div className="hint">播放器窗口内生效</div>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  关闭面板 / 退出全屏 <kbd className="kbd">Esc</kbd>
                  <div className="hint">优先收起选集 / 弹幕设置等展开面板，再退出全屏</div>
                </div>
              </div>
            </div>
          ) : null}

          {active === 'about' ? (
            <div className="settings-group">
              <h3>关于</h3>
              <div className="setting-row">
                <div>应用</div>
                <div style={{ color: 'var(--text-tertiary)' }}>红果短剧桌面版 v{appVersion}</div>
              </div>
              {/* 检查更新（任务 66-B）：手动入口 + 版本对比 + 实时状态（发现新版本显示版本号，
                  「立即升级」与全局更新弹窗共用同一状态机与下载流程） */}
              <div className="setting-row">
                <div>
                  检查更新
                  <div className="hint" style={{ lineHeight: 1.7 }}>{upStatusText}</div>
                  {updateState.phase === 'downloading' ? (
                    <div className="up-progress">
                      <div className="up-progress-fill" style={{ width: `${Math.max(2, updateState.progress)}%` }} />
                    </div>
                  ) : null}
                </div>
                {updateState.phase === 'available' ? (
                  <button className="chip on" onClick={startUpgrade}>
                    立即升级
                  </button>
                ) : (
                  <button className="chip" disabled={checking || !updateState.supported} onClick={checkNow}>
                    {checking ? '检查中…' : '检查更新'}
                  </button>
                )}
              </div>
              <div className="setting-row">
                <div>项目介绍</div>
                <div style={{ color: 'var(--text-tertiary)', maxWidth: 560 }}>
                  红果短剧（hongguoduanju.com）的第三方桌面客户端：浏览 / 分类 / 榜单 / 搜索 /
                  智能推荐、独立沉浸式播放器与弹幕，收藏与观看进度本地持久化。
                </div>
              </div>
              <div className="setting-row">
                <div>开源协议</div>
                <div style={{ color: 'var(--text-tertiary)' }}>
                  AGPL-3.0（
                  <span
                    className="ext-link"
                    title="https://github.com/legend0/hongguo-desktop（点击在浏览器中打开）"
                    onClick={() => {
                      void api.app.openExternal('https://github.com/legend0/hongguo-desktop')
                        .catch((e: unknown) => toast(`打开失败：${String((e as Error)?.message ?? e)}`));
                    }}
                  >
                    GitHub 仓库
                  </span>
                  ）
                </div>
              </div>
              <div className="setting-row" style={{ alignItems: 'flex-start' }}>
                <div style={{ maxWidth: 560 }}>
                  免责声明
                  <div className="hint" style={{ lineHeight: 1.7 }}>
                    本应用仅对公开网页做技术性解析与展示，不缓存、不转存、不二次分发任何视频内容；
                    视频流直连原站点 CDN，版权归原作者及平台所有，请仅作个人学习用途。
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
