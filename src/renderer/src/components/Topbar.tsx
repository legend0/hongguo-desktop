import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { settingsStore, useSettings, type ThemeMode } from '../stores';
import { nextThemeMode } from '../hooks/useTheme';
import { useSearchHistory } from '../stores';
import { requestClose } from './CloseConfirmModal';
import type { SearchSuggestion } from '../types';
import {
  IconSearch,
  IconPlay,
  IconChevronRight,
  IconChevronLeft,
  IconGear,
  IconMoon,
  IconSun,
  IconMonitor,
  IconMinimize,
  IconMaximize,
  IconRestore,
  IconClose,
} from './Icons';

const DEBOUNCE_MS = 250;
const MAX_SUGGESTIONS = 8;

const THEME_LABEL: Record<ThemeMode, string> = { dark: '暗色', light: '亮色', system: '跟随系统' };

/**
 * 右侧顶部控制栏：
 * [返回] [搜索框（Ctrl+K 聚焦 / 聚焦展开 / 键盘上下选择）] …… [设置] | [窗口控制]
 * 整条为窗口拖拽区，交互元素 no-drag。
 * 控件尺寸统一：图标按钮 32×32 / 8px 圆角，输入框 34px 高 / --radius-control 圆角。
 */
export function Topbar() {
  const { theme } = useSettings();
  const [kw, setKw] = useState('');
  const [open, setOpen] = useState(false);
  const [sugs, setSugs] = useState<SearchSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  const [maximized, setMaximized] = useState(false);
  /** 搜索输入框是否处于聚焦态（聚焦期间点击外部仅退出聚焦，不触发目标动作） */
  const [searchFocused, setSearchFocused] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const searchHistory = useSearchHistory();
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);

  /** HashRouter 首次进入的 location.key 为 'default'，此时没有可返回的历史 */
  const canGoBack = location.key !== 'default';
  const kwTrim = kw.trim();
  /** 有关键词 → 联想面板；无关键词聚焦 → 搜索历史面板 */
  const showPanel = open && (kwTrim.length > 0 || searchHistory.items.length > 0);
  const showHistory = open && kwTrim.length === 0;

  useEffect(() => {
    void window.hongguo.win.isMaximized().then(setMaximized);
    return window.hongguo.win.onMaximizedChanged(setMaximized);
  }, []);

  // 进入搜索结果页时把关键词回填到搜索框，顶部与页面内容保持一致
  useEffect(() => {
    if (location.pathname !== '/search') return;
    setKw(new URLSearchParams(location.search).get('keyword') ?? '');
  }, [location.pathname, location.search]);

  // Ctrl/Cmd + K 聚焦搜索框
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 防抖联想
  useEffect(() => {
    const q = kw.trim();
    setActive(-1);
    if (!q) {
      setSugs([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(async () => {
      const seq = ++seqRef.current;
      try {
        const list = await api.searchSuggest(q);
        if (seq === seqRef.current) setSugs(list.slice(0, MAX_SUGGESTIONS));
      } catch {
        if (seq === seqRef.current) setSugs([]);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [kw]);

  // 点击外部关闭
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // 搜索聚焦期间，点击框外任意位置的动作一律只"退出聚焦"：
  // 在 document capture 阶段吞掉 mousedown/click（stopPropagation 使 React 委托与元素监听
  // 均收不到事件，导航/按钮/卡片不会被误触发），随后手动失焦。
  useEffect(() => {
    if (!searchFocused) return;
    const swallowOutside = (e: MouseEvent) => {
      if (boxRef.current?.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      inputRef.current?.blur();
    };
    document.addEventListener('mousedown', swallowOutside, true);
    document.addEventListener('click', swallowOutside, true);
    return () => {
      document.removeEventListener('mousedown', swallowOutside, true);
      document.removeEventListener('click', swallowOutside, true);
    };
  }, [searchFocused]);

  const goSearch = useCallback(
    (q: string) => {
      const key = q.trim();
      if (!key) return;
      searchHistory.add(key); // 记入搜索历史（去重置顶，本地持久化）
      setOpen(false);
      inputRef.current?.blur();
      navigate(`/search?keyword=${encodeURIComponent(key)}`);
    },
    [navigate, searchHistory],
  );

  const pick = (s: SearchSuggestion) => {
    setOpen(false);
    inputRef.current?.blur();
    if (s.kind === 'drama') navigate(`/drama/${s.keyword}`);
    else goSearch(s.keyword);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const picked = active >= 0 ? sugs[active] : undefined;
    if (picked) pick(picked);
    else goSearch(kw);
  };

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (kw) {
        setKw('');
        setSugs([]);
      } else {
        setOpen(false);
        inputRef.current?.blur();
      }
      return;
    }
    if (!showPanel || sugs.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % sugs.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i <= 0 ? sugs.length - 1 : i - 1));
    }
  };

  const clear = () => {
    setKw('');
    setSugs([]);
    setActive(-1);
    inputRef.current?.focus();
  };

  return (
    <div className="topbar">
      <button
        className="tb-icon"
        title="返回"
        aria-label="返回"
        disabled={!canGoBack}
        onClick={() => navigate(-1)}
      >
        <IconChevronLeft size={17} />
      </button>

      <div className="search-box" ref={boxRef}>
        <form className="search" onSubmit={onSubmit} role="search">
          <IconSearch size={15} />
          <input
            ref={inputRef}
            value={kw}
            onChange={(e) => {
              setKw(e.target.value);
              setOpen(true);
            }}
            onFocus={() => {
              setOpen(true);
              setSearchFocused(true);
            }}
            onBlur={() => setSearchFocused(false)}
            onKeyDown={onInputKeyDown}
            placeholder="搜索短剧、演员、标签"
            aria-label="搜索短剧"
            aria-expanded={showPanel}
            aria-autocomplete="list"
          />
          {kw ? (
            <button type="button" className="search-clear" title="清空" aria-label="清空搜索" onClick={clear}>
              <IconClose size={11} />
            </button>
          ) : (
            <kbd className="search-kbd">Ctrl K</kbd>
          )}
        </form>

        {showPanel && showHistory ? (
          <div className="suggest" role="listbox">
            <div className="sg-history-head">
              <span>搜索历史</span>
              <button className="sg-history-clear" onClick={() => searchHistory.clear()}>
                清空
              </button>
            </div>
            {searchHistory.items.map((h) => (
              <div key={h} className="sg-history-item" role="option" aria-selected={false}>
                <button className="sg-history-main" onClick={() => goSearch(h)}>
                  <IconSearch size={14} />
                  <span className="sg-name">{h}</span>
                </button>
                <button
                  className="sg-history-remove"
                  title="删除该条记录"
                  aria-label={`删除搜索历史 ${h}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    searchHistory.remove(h);
                  }}
                >
                  <IconClose size={11} />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {showPanel && !showHistory ? (
          <div className="suggest" role="listbox">
            {sugs.length === 0 && !loading ? <div className="suggest-empty">未找到相关联想词</div> : null}
            {sugs.map((s, i) => (
              <button
                key={`${s.kind}:${s.keyword}:${i}`}
                className={`suggest-item${s.kind === 'drama' ? '' : ' keyword'}${i === active ? ' active' : ''}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(s)}
                style={{ animationDelay: `${i * 0.02}s` }}
              >
                {s.kind === 'drama' ? (
                  <>
                    <span className="sg-cover">
                      {s.coverUrl ? <img src={s.coverUrl} alt="" loading="lazy" /> : null}
                      <i className="sg-play">
                        <IconPlay size={11} />
                      </i>
                    </span>
                    <span className="sg-body">
                      <span className="sg-name">{s.name}</span>
                      <span className="sg-meta">
                        {s.totalEpisodes ? `共 ${s.totalEpisodes} 集` : ''}
                        {s.heatText ? ` · ${s.heatText}` : ''}
                        {s.categories?.length ? ` · ${s.categories.slice(0, 2).join('/')}` : ''}
                      </span>
                    </span>
                  </>
                ) : (
                  <>
                    <span className="sg-kw-icon">
                      <IconSearch size={14} />
                    </span>
                    <span className="sg-body">
                      <span className="sg-name">{s.name}</span>
                    </span>
                  </>
                )}
                <IconChevronRight size={13} className="sg-arrow" />
              </button>
            ))}
            <button className="suggest-all" onClick={() => goSearch(kw)}>
              查看“{kw.trim()}”的全部结果
              <IconChevronRight size={12} />
            </button>
          </div>
        ) : null}
      </div>

      <div className="topbar-actions">
        <button
          className="tb-icon"
          title={`主题：${THEME_LABEL[theme]}（点击切换）`}
          aria-label={`切换主题，当前 ${THEME_LABEL[theme]}`}
          onClick={() => settingsStore.setState({ theme: nextThemeMode(theme) })}
        >
          {theme === 'dark' ? <IconMoon size={16} /> : theme === 'light' ? <IconSun size={16} /> : <IconMonitor size={16} />}
        </button>
        <button className="tb-icon" title="设置" aria-label="设置" onClick={() => navigate('/settings')}>
          <IconGear size={16} />
        </button>
        <i className="tb-sep" />
        <button
          className="tb-icon"
          title="最小化"
          aria-label="最小化"
          onClick={() => void window.hongguo.win.minimize()}
        >
          <IconMinimize size={14} />
        </button>
        <button
          className="tb-icon"
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原' : '最大化'}
          onClick={() => void window.hongguo.win.toggleMaximize()}
        >
          {maximized ? <IconRestore size={13} /> : <IconMaximize size={13} />}
        </button>
        <button className="tb-icon close" title="关闭" aria-label="关闭" onClick={requestClose}>
          <IconClose size={14} />
        </button>
      </div>
    </div>
  );
}
