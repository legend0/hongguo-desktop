import { useEffect, useState, type CSSProperties } from 'react';
import { useSettings } from '../stores';
import { api } from '../api';
import { toast } from '../components/Toast';
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
  { key: 'player', label: '播放器' },
  { key: 'danmaku', label: '弹幕' },
  { key: 'app', label: '应用' },
  { key: 'about', label: '关于' },
] as const;
type SectionKey = (typeof SECTIONS)[number]['key'];

/** 自定义滑动条填充比例（CSS 变量 --fill，配合 .hg-range 渐变轨道） */
const fillStyle = (v: number): CSSProperties =>
  ({ '--fill': `${Math.round(v * 100)}%` }) as CSSProperties;

/** 参考项目（本项目的协议分析与整体思路来源，AGPL-3.0 同源） */
const UPSTREAM_URL = 'https://github.com/zfdang/hongguo-open-player';

/**
 * 设置页：左侧索引 + 右侧设置内容区。
 * 分组：播放器（连播/进度/倍速）、弹幕（与播放器控制栏同源偏好）、应用（自启动）、关于。
 */
export function SettingsPage() {
  const settings = useSettings();
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const [active, setActive] = useState<SectionKey>('player');
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
    void api.app.getLoginItem().then(setOpenAtLogin);
    void api.getAuthState().then(setAuthState);
    void api.app.getVersion().then(setAppVersion).catch(() => setAppVersion('0.1.0'));
  }, []);

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

          {active === 'about' ? (
            <div className="settings-group">
              <h3>关于</h3>
              <div className="setting-row">
                <div>应用</div>
                <div style={{ color: 'var(--text-tertiary)' }}>红果短剧桌面版 v{appVersion}</div>
              </div>
              <div className="setting-row">
                <div>定位</div>
                <div style={{ color: 'var(--text-tertiary)', maxWidth: 560 }}>
                  红果短剧（hongguoduanju.com）的第三方桌面客户端：浏览 / 分类 / 榜单 / 搜索 /
                  智能推荐、独立沉浸式播放器与弹幕，收藏与观看进度本地持久化。
                </div>
              </div>
              <div className="setting-row">
                <div>开源协议</div>
                <div style={{ color: 'var(--text-tertiary)' }}>
                  AGPL-3.0（与参考项目一致）
                </div>
              </div>
              <div className="setting-row" style={{ alignItems: 'flex-start' }}>
                <div style={{ maxWidth: 560 }}>
                  致谢
                  <div className="hint" style={{ lineHeight: 1.7 }}>
                    本项目的接口协议分析与实现思路参考了开源项目{' '}
                    <a
                      href={UPSTREAM_URL}
                      onClick={(e) => {
                        e.preventDefault();
                        void api.app.openExternal(UPSTREAM_URL);
                      }}
                      style={{ color: 'var(--accent, #ff4d6a)' }}
                    >
                      zfdang/hongguo-open-player
                    </a>
                    ，感谢原作者的出色工作。
                  </div>
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
