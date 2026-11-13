import Hls from 'hls.js';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import type { DanmakuItem } from '../api';
import { useHistory } from '../stores';
import { ErrorTip, Loading } from '../components/Feedback';
import { toast } from '../components/Toast';
import Danmaku, { type DanmakuComment } from '../lib/danmaku.dom.js';
import { renderDanmakuText } from '../lib/danmakuEmoji';
import {
  IconFullscreen, IconPause, IconPlay, IconPrevEp, IconNextEp, IconVolume, IconWarning,
  IconEpList,
} from '../components/Icons';
import type { Episode } from '../types';
import { DM_ROW_HEIGHT, DM_ROW_OPTIONS, DM_SPEEDS, readDanmakuPrefs, writeDanmakuPrefs } from '../danmakuPrefs';
import type { DanmakuPrefs } from '../danmakuPrefs';

const RATE_OPTIONS = [1, 1.25, 1.5, 2, 0.75];
const LS_VOLUME = 'hg-player-volume';
const LS_RATE = 'hg-player-rate';
/** 付费集"免费通道配额耗尽"的友好提示 + 30s 冷却（避免连点打满接口） */
const LOCKED_QUOTA_MSG = '该集为付费内容，当前免费通道暂时繁忙，请稍后再试';
const LOCKED_QUOTA_COOLDOWN_SEC = 30;
/** 即将进入下一集的提前提示秒数（剩余播放时间 ≤ 该值时显示提示条） */
const NEXT_TIP_SECONDS = 3;

/** 自定义滑动条填充比例（CSS 变量 --fill，配合 .hg-range 渐变轨道） */
const fillStyle = (v: number): CSSProperties =>
  ({ '--fill': `${Math.round(v * 100)}%` }) as CSSProperties;

/** 按点赞数分档配色（全剧统一档位：500 起最高热度色） */
function danmakuColorOf(item: DanmakuItem): string {
  const likes = typeof item.likes === 'number' && item.likes > 0 ? item.likes : 0;
  if (likes >= 500) return '#ff7777';
  if (likes >= 100) return '#ffad72';
  if (likes >= 20) return '#ffd87a';
  if (likes >= 1) return '#a8dcff';
  return '#ffffff';
}

/** 根据文本长度与点赞角标预估弹幕渲染像素宽度（字号 20px） */
function estimateDanmakuWidth(text: string, likes = 0): number {
  let width = 12; // 基础边距
  for (let i = 0; i < String(text ?? '').length; i++) {
    const code = String(text ?? '').charCodeAt(i);
    // ASCII 半角约 10px，全角/中文约 20px
    width += code >= 0x20 && code <= 0x7e ? 10 : 20;
  }
  if (likes > 0) width += 6 + ('+' + likes).length * 8;
  return width;
}

/** 同轨道相邻弹幕不发生碰撞（间距 ≥ 8px）所需的最小时间差（秒） */
function calculateRequiredGap(wPrev: number, wNext: number, screenWidth: number, duration: number): number {
  const gapPrev = (duration * (wPrev + 8)) / (screenWidth + wPrev);
  const gapNext = (duration * (wNext + 8)) / (screenWidth + wNext);
  return Math.max(gapPrev, gapNext);
}

/**
 * 基于"真实物理时空长度 + 多轨道连续调度"的高赞优先优选算法：
 * 依次把弹幕排入轨道；全部轨道处于阻挡期时，高赞弹幕可淘汰正在阻挡它的低赞/0 赞弹幕。
 * 关闭高赞优先时按时间序原样返回。
 */
function prioritizeDanmakuItems(
  items: DanmakuItem[],
  options: { rows?: number; speed?: string; screenWidth?: number; likesPriority?: boolean } = {},
): DanmakuItem[] {
  if (!Array.isArray(items) || !items.length) return [];
  if (options.likesPriority === false) return [...items];

  const rows = Math.max(1, Number(options.rows) || 3);
  const screenWidth = Math.max(320, Number(options.screenWidth) || 800);
  const duration = DM_SPEEDS[(options.speed ?? 'medium') as keyof typeof DM_SPEEDS] || 16;

  const candidates = items.map((item, index) => {
    const likes = typeof item.likes === 'number' && item.likes > 0 ? item.likes : 0;
    return { raw: item, time: Number(item.time) || 0, likes, width: estimateDanmakuWidth(item.text, likes), index };
  });

  // 严格按时间先后排序；同时间点按点赞数降序
  candidates.sort((a, b) => (a.time !== b.time ? a.time - b.time : b.likes !== a.likes ? b.likes - a.likes : a.index - b.index));

  const tracks: { items: typeof candidates }[] = Array.from({ length: rows }, () => ({ items: [] }));

  for (const c of candidates) {
    // 1. 找无碰撞冲突的空闲轨道（取剩余余量最大的）
    let freeTrackIndex = -1;
    let minGapToLast = Infinity;
    for (let k = 0; k < rows; k++) {
      const trackItems = tracks[k].items;
      if (!trackItems.length) {
        freeTrackIndex = k;
        break;
      }
      const prev = trackItems[trackItems.length - 1];
      const reqGap = calculateRequiredGap(prev.width, c.width, screenWidth, duration);
      if (c.time >= prev.time + reqGap) {
        const gap = c.time - (prev.time + reqGap);
        if (gap < minGapToLast) {
          minGapToLast = gap;
          freeTrackIndex = k;
        }
      }
    }
    if (freeTrackIndex !== -1) {
      tracks[freeTrackIndex].items.push(c);
      continue;
    }
    // 2. 全轨道阻挡：更高赞的弹幕可淘汰正在阻挡它的低赞弹幕
    if (c.likes > 0) {
      let bestReplaceTrack = -1;
      let minIncumbentLikes = c.likes; // 必须严格低于 c 的点赞数
      let maxRemainingBlock = -Infinity;
      for (let k = 0; k < rows; k++) {
        const trackItems = tracks[k].items;
        const incumbent = trackItems[trackItems.length - 1];
        if (incumbent.likes >= c.likes) continue;
        // 剔除现有弹幕后，与该轨道倒数第二条不得冲突
        let canReplace = true;
        if (trackItems.length >= 2) {
          const prevBefore = trackItems[trackItems.length - 2];
          if (c.time < prevBefore.time + calculateRequiredGap(prevBefore.width, c.width, screenWidth, duration)) {
            canReplace = false;
          }
        }
        if (canReplace) {
          const remainingBlock = incumbent.time + calculateRequiredGap(incumbent.width, c.width, screenWidth, duration) - c.time;
          // 优选原则：先淘汰点赞最低的；同赞数淘汰阻挡时间最长的
          if (incumbent.likes < minIncumbentLikes || (incumbent.likes === minIncumbentLikes && remainingBlock > maxRemainingBlock)) {
            minIncumbentLikes = incumbent.likes;
            maxRemainingBlock = remainingBlock;
            bestReplaceTrack = k;
          }
        }
      }
      if (bestReplaceTrack !== -1) {
        tracks[bestReplaceTrack].items.pop();
        tracks[bestReplaceTrack].items.push(c);
      }
    }
  }

  // 收集所有成功上轨的弹幕并恢复严格时间序
  const result: DanmakuItem[] = [];
  for (const track of tracks) for (const entry of track.items) result.push(entry.raw);
  result.sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));
  return result;
}

/** 识别主进程透传的"付费集配额耗尽"错误（跨 IPC 用 code 或 message 前缀双重兜底） */
function isLockedQuotaError(e: unknown): boolean {
  if (!e) return false;
  const m = e as { code?: unknown; message?: unknown };
  return m.code === 'LOCKED_QUOTA_EXHAUSTED' || String(m.message ?? '').includes('[HG:LOCKED_QUOTA]');
}

function fmt(sec: number): string {
  if (!Number.isFinite(sec)) return '00:00';
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * 播放器窗口页：独立无边框窗口的全屏沉浸式播放器。
 * - 顶部栏（可拖拽移动窗口）：剧名 · 第 N 集 + 关闭按钮，显隐跟随控制栏
 * - 底部控制栏：播放/进度/上下集/倍速/音量/全屏 + 「选集」展开面板
 * - 选集面板：分组网格，当前集高亮，点击即切集
 */
export function PlayerPage() {
  const { seriesId = '', itemId = '' } = useParams();
  const navigate = useNavigate();
  const history = useHistory();

  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const lastSaveRef = useRef(0);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.getDetail>> | null>(null);
  const [detailErr, setDetailErr] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [videoFormat, setVideoFormat] = useState<'mp4' | 'm3u8' | 'unknown'>('unknown');
  const [playErr, setPlayErr] = useState('');
  const [resolving, setResolving] = useState(true);
  // 付费集配额耗尽冷却：剩余秒数（>0 时禁用"重试"，避免连点打满接口）
  const [cooldownLeft, setCooldownLeft] = useState(0);
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [buffered, setBuffered] = useState(0);
  // 音量持久化值校验：非法/越界回退 1（防止 localStorage 被改坏后 video 无法出声）
  const [volume, setVolume] = useState(() => {
    const v = Number(localStorage.getItem(LS_VOLUME));
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1;
  });
  const [muted, setMuted] = useState(false);
  // 倍速档位持久化读回：LS_RATE 只存索引，越界/非法回退原速（与写入端 cycleRate 对应）
  const [rateIdx, setRateIdx] = useState(() => {
    const idx = Number(localStorage.getItem(LS_RATE));
    return Number.isInteger(idx) && idx >= 0 && idx < RATE_OPTIONS.length ? idx : 0;
  });
  const [showControls, setShowControls] = useState(true);
  const [isFull, setIsFull] = useState(false);
  /** 选集面板展开态（控制栏内的展开控件） */
  const [epOpen, setEpOpen] = useState(false);
  /** 即将进入下一集提示（剩余播放时间 ≤3s 时显示） */
  const [nextTip, setNextTip] = useState(false);

  // ===== 弹幕状态（vendor Danmaku 2.0.10 MIT，media 引擎跟随视频时间轴） =====
  const [dmPrefs, setDmPrefs] = useState<DanmakuPrefs>(() => readDanmakuPrefs());
  const [dmItems, setDmItems] = useState<DanmakuItem[]>([]);
  const [dmStatus, setDmStatus] = useState('');
  const [dmOpen, setDmOpen] = useState(false);
  const dmLayerRef = useRef<HTMLDivElement>(null);
  const dmEngineRef = useRef<Danmaku | null>(null);
  const dmResizeRef = useRef<ResizeObserver | null>(null);
  /** 请求代次：切集/刷新后丢弃过期响应 */
  const dmReqRef = useRef(0);
  /** 已加载的弹幕键（seriesId:vid），避免同集重复请求 */
  const dmKeyRef = useRef('');
  /**
   * 弹幕数据权威源（当前集键 + 列表）。引擎创建一律从这里读数据，不走渲染闭包：
   * 修复自动切集竞态——切集 effect 排队的 startDanmaku 宏任务可能带着"渲染闭包里的旧集
   * dmItems"抢先创建引擎（后续数据链断裂时旧弹幕引擎永久存活，表现为自动切集后仍显示
   * 上一集弹幕）。改为发起请求时同步清空 ref 数据，任何时序下新引擎只能拿到当前集数据或空数据。
   */
  const dmDataRef = useRef<{ key: string; items: DanmakuItem[] }>({ key: '', items: [] });

  // ===== 详情（随剧加载一次） =====
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setDetailErr('');
    api
      .getDetail(seriesId)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setDetailErr(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [seriesId]);

  const episodes: Episode[] = detail?.episodes ?? [];
  const curEpIdx = episodes.findIndex((e) => e.id === itemId);
  const curEp = curEpIdx >= 0 ? episodes[curEpIdx] : null;
  const prevEp = curEpIdx > 0 ? episodes[curEpIdx - 1] : null;
  const nextEp = curEpIdx >= 0 && curEpIdx < episodes.length - 1 ? episodes[curEpIdx + 1] : null;

  // 选集分组（每 50 集一组，与详情页一致）
  const GROUP = 50;
  const epGroups: Episode[][] = [];
  for (let i = 0; i < episodes.length; i += GROUP) epGroups.push(episodes.slice(i, i + GROUP));

  // ===== 外部切集指令：主窗口在播放器窗口已存在时再次点播 → 主进程转发 player:open =====
  useEffect(() => {
    return api.win.onPlayerOpen((p) => {
      if (!p?.seriesId) return;
      navigate(p.itemId ? `/player/${p.seriesId}/${p.itemId}` : `/player/${p.seriesId}`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===== 视频直链（随集切换；force 跳过主进程缓存重取） =====
  const retryRef = useRef(0);
  // 下一集 id 用 ref 传递：若作为 resolveVideo 依赖，详情加载后会重跑取址 effect 多发 net:play（任务 24 回归）
  const nextVidRef = useRef('');
  nextVidRef.current = nextEp?.id || '';

  /** 启动 30s 冷却倒计时（付费集免费通道繁忙时） */
  const startCooldown = useCallback(() => {
    setCooldownLeft(LOCKED_QUOTA_COOLDOWN_SEC);
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    cooldownTimerRef.current = setInterval(() => {
      setCooldownLeft((s) => {
        if (s <= 1) {
          if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
          cooldownTimerRef.current = null;
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }, []);

  // 卸载时清理冷却定时器
  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    };
  }, []);

  const resolveVideo = useCallback(
    (force = false) => {
      setResolving(true);
      setPlayErr('');
      setVideoUrl('');
      setCur(0);
      setDur(0);
      setBuffered(0);
      return api
        .getPlayInfo(seriesId, itemId, force, nextVidRef.current)
        .then((info) => {
          if (!info.videoUrl) throw new Error('未取到视频地址，请稍后重试');
          setVideoUrl(info.videoUrl);
          setVideoFormat(info.format);
          // 起播成功：清除冷却
          if (cooldownTimerRef.current) {
            clearInterval(cooldownTimerRef.current);
            cooldownTimerRef.current = null;
          }
          setCooldownLeft(0);
        })
        .catch((e) => {
          if (isLockedQuotaError(e)) {
            // 付费集免费通道繁忙：友好文案 + 30s 冷却
            setPlayErr(LOCKED_QUOTA_MSG);
            startCooldown();
          } else {
            setPlayErr(String((e as Error)?.message ?? e));
          }
        })
        .finally(() => setResolving(false));
    },
    [seriesId, itemId, startCooldown],
  );

  useEffect(() => {
    retryRef.current = 0;
    // 切集瞬间立即释放旧媒体源（黑屏过渡）：
    // ① 起播 effect 会因 itemId 变化先跑，此时 videoUrl 还是旧集且旧视频 readyState≥1，
    //    ended 状态下 v.play() 会按规范把播放位置重置回顶部 → "回到当前集顶部重播"；
    // ② 新 src 替换瞬间媒体重置会闪现旧集开头帧。清空后 readyState 归 0，
    //    起播只能等新集 loadedmetadata，两个问题一并消除。
    hlsRef.current?.destroy();
    hlsRef.current = null;
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
    void resolveVideo(false);
  }, [resolveVideo]);

  // ===== 视频加载失败：强制重取直链再试（签名 URL 约 40 分钟过期） =====
  const handleVideoError = useCallback(() => {
    if (retryRef.current < 2) {
      retryRef.current += 1;
      setTimeout(() => void resolveVideo(true), 400);
    } else {
      setPlayErr((prev) => prev || '视频加载失败，请点击重试');
    }
  }, [resolveVideo]);

  // ===== 挂载视频源（hls.js / 原生） =====
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoUrl) return;
    setBuffering(true);
    hlsRef.current?.destroy();
    hlsRef.current = null;

    if (videoFormat === 'm3u8' && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, maxBufferLength: 30 });
      hlsRef.current = hls;
      hls.loadSource(videoUrl);
      hls.attachMedia(v);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) handleVideoError();
      });
    } else {
      v.src = videoUrl;
    }
    v.volume = volume;
    v.playbackRate = RATE_OPTIONS[rateIdx];

    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl, videoFormat]);

  // ===== 起播 + 恢复上次进度 =====
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoUrl) return;
    const saved = history.entries.find((e) => e.dramaId === seriesId && e.episodeId === itemId);
    const onMeta = () => {
      setDur(v.duration || 0);
      // 沉浸式：窗口高度固定，宽度跟随视频宽高比
      if (v.videoWidth && v.videoHeight) {
        void api.win.fitToVideo(v.videoWidth / v.videoHeight);
      }
      if (saved && saved.positionSec > 5 && saved.positionSec < (v.duration || Infinity) - 5) {
        v.currentTime = saved.positionSec;
      }
      void v.play().catch(() => setPlaying(false));
    };
    if (v.readyState >= 1) onMeta();
    else v.addEventListener('loadedmetadata', onMeta, { once: true });
    return () => v.removeEventListener('loadedmetadata', onMeta);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl, seriesId, itemId]);

  // ===== 进度持久化（5s 节流 + 卸载强制写） =====
  const saveProgress = useCallback(
    (force = false) => {
      const v = videoRef.current;
      if (!v || !detail || !curEp || !v.duration) return;
      const now = Date.now();
      if (!force && now - lastSaveRef.current < 5000) return;
      lastSaveRef.current = now;
      // 完播判定：当前集进度 ≥90% 记入 finishedEpIds（详情页选集"已完播"指示数据源）
      const finished = v.duration > 0 && v.currentTime / v.duration >= 0.9;
      const finishedEpIds = new Set(history.find(detail.id)?.finishedEpIds ?? []);
      if (finished && curEp.id) finishedEpIds.add(curEp.id);
      history.upsert({
        dramaId: detail.id,
        title: detail.title,
        coverUrl: detail.coverUrl,
        episodeIndex: curEp.index,
        episodeId: curEp.id ?? '',
        positionSec: Math.floor(v.currentTime),
        durationSec: Math.floor(v.duration),
        finishedEpIds: Array.from(finishedEpIds),
        totalEpisodes: detail.totalEpisodes || detail.episodes.length,
        updatedAt: now,
      });
    },
    [detail, curEp, history],
  );

  // 定时持久化：仅挂载时建立一次定时器，通过 ref 取最新 saveProgress，
  // 避免 store 更新 → saveProgress 重建 → effect 重跑 → cleanup 又写 store 的死循环
  const saveProgressRef = useRef(saveProgress);
  useEffect(() => {
    saveProgressRef.current = saveProgress;
  });

  useEffect(() => {
    const t = setInterval(() => saveProgressRef.current(), 5000);
    return () => {
      clearInterval(t);
      saveProgressRef.current(true);
    };
  }, []);

  // 窗口直接关闭时 React 卸载 cleanup 不保证执行（close() 直接销毁窗口），
  // 监听 pagehide/beforeunload 强制补写，避免丢失最近 5s 内的播放进度
  useEffect(() => {
    const flush = () => saveProgressRef.current(true);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, []);

  // ===== 切集（窗口内路由切换；选集面板收起） =====
  const goEpisode = useCallback(
    (ep: Episode) => {
      // 仅"无 vid 的锁定集"不可切换；有 vid 的付费集（方案 A 解锁）可跳播放
      if (!ep.id && ep.locked) return;
      saveProgress(true);
      setEpOpen(false);
      // 第 1 集无 itemId，走根路径 /player/{seriesId}
      navigate(ep.id ? `/player/${seriesId}/${ep.id}` : `/player/${seriesId}`);
    },
    [navigate, seriesId, saveProgress],
  );

  // ===== 控制行为 =====
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  }, []);

  const seekBy = useCallback((sec: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.min(Math.max(0, v.currentTime + sec), v.duration);
  }, []);

  const changeVolume = useCallback((val: number) => {
    const clamped = Math.min(Math.max(0, val), 1);
    setVolume(clamped);
    setMuted(clamped === 0);
    localStorage.setItem(LS_VOLUME, String(clamped));
    const v = videoRef.current;
    if (v) {
      v.volume = clamped;
      v.muted = clamped === 0;
    }
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const next = !v.muted && v.volume > 0;
    v.muted = next;
    setMuted(next);
  }, []);

  const cycleRate = useCallback(() => {
    const next = (rateIdx + 1) % RATE_OPTIONS.length;
    setRateIdx(next);
    localStorage.setItem(LS_RATE, String(next));
    const v = videoRef.current;
    if (v) v.playbackRate = RATE_OPTIONS[next];
  }, [rateIdx]);

  // ===== 弹幕逻辑（跟随视频时间轴；偏好持久化到 localStorage） =====

  /** 合并更新弹幕偏好并写回本地存储 */
  const updateDmPrefs = useCallback((patch: Partial<DanmakuPrefs>) => {
    setDmPrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        writeDanmakuPrefs(next);
      } catch {
        /* 存储失败时仅会话内生效 */
      }
      return next;
    });
  }, []);

  /** 弹幕滚动速度（px/s）：屏幕宽度 / 档位系数 */
  const dmSpeedForWidth = (width: number) => Math.max(1, width / (DM_SPEEDS[dmPrefs.speed] || 16));

  /** 销毁引擎与尺寸监听（切集/重建前调用） */
  const stopDanmaku = () => {
    dmResizeRef.current?.disconnect();
    dmResizeRef.current = null;
    dmEngineRef.current?.destroy();
    dmEngineRef.current = null;
  };

  /** 构建 media 引擎：高赞优选排序 + 自定义渲染（配色/点赞角标），随容器尺寸自适应速度 */
  const startDanmaku = () => {
    // 调试日志（DevTools Console，Verbose 级可见）：异常前置条件 warn，正常流程 debug
    if (dmEngineRef.current || !dmPrefs.enabled || !videoRef.current || !dmLayerRef.current) {
      if (!dmEngineRef.current) {
        console.warn('[Danmaku] 引擎无法创建（异常前置条件）', {
          开关开启: dmPrefs.enabled,
          video就绪: !!videoRef.current,
          弹幕层就绪: !!dmLayerRef.current,
        });
      }
      return;
    }
    const layer = dmLayerRef.current;
    // 数据权威源（ref）：不读渲染闭包的 dmItems，杜绝切集瞬间的旧集数据竞态
    const dataSource = dmDataRef.current;
    const prioritized = prioritizeDanmakuItems(dataSource.items, {
      rows: dmPrefs.rows,
      speed: dmPrefs.speed,
      screenWidth: layer.offsetWidth || 800,
      likesPriority: dmPrefs.likesPriority,
    });
    console.debug('[Danmaku] 引擎创建', {
      数据键: dataSource.key,
      原始条数: dataSource.items.length,
      分配轨道后: prioritized.length,
      弹幕层尺寸: `${layer.offsetWidth}x${layer.offsetHeight}`,
      速度: dmSpeedForWidth(layer.offsetWidth),
      视频: videoRef.current.paused ? `暂停@${videoRef.current.currentTime.toFixed(1)}s` : `播放@${videoRef.current.currentTime.toFixed(1)}s`,
      前三条: prioritized.slice(0, 3).map((i) => `${i.time}s ${i.text}`),
    });
    const comments: DanmakuComment[] = prioritized.map((item) => ({
      time: Number(item.time) || 0,
      render: () => {
        const text = document.createElement('span');
        text.className = 'danmaku-item';
        text.style.color = danmakuColorOf(item);
        text.textContent = renderDanmakuText(item.text);
        if (Number(item.likes) > 0) {
          const likes = document.createElement('sup');
          likes.className = 'danmaku-likes';
          likes.textContent = '+' + item.likes;
          text.appendChild(likes);
        }
        return text;
      },
    }));
    dmEngineRef.current = new Danmaku({ container: layer, media: videoRef.current, comments, speed: dmSpeedForWidth(layer.offsetWidth) });
    const resize = () => {
      const engine = dmEngineRef.current;
      if (!engine || !layer.offsetWidth || !layer.offsetHeight) return;
      engine.speed = dmSpeedForWidth(layer.offsetWidth);
      engine.resize();
    };
    if (typeof ResizeObserver !== 'undefined') {
      dmResizeRef.current = new ResizeObserver(resize);
      dmResizeRef.current.observe(layer);
    }
  };

  /** 重建引擎：先销毁再等一层渲染（等弹幕层重新挂载/尺寸生效） */
  const refreshDanmaku = () => {
    stopDanmaku();
    setTimeout(startDanmaku, 0);
  };

  /**
   * 拉取当前集弹幕（force=true 绕过失败缓存重试）。
   * 数据始终加载、与开关无关（开关仅控制显隐）：保证关→开开关时无需重新请求即可立即显示。
   */
  const loadDanmaku = (force = false) => {
    const vid = itemId || '';
    const key = `${seriesId}:${vid}`;
    if (!vid || (!force && key === dmKeyRef.current)) {
      if (!vid) {
        console.warn('[Danmaku] 拉取跳过（异常前置条件）', { 有vid: !!vid });
      }
      return;
    }
    dmKeyRef.current = key;
    const req = ++dmReqRef.current;
    // 同步清空数据权威源（新集无数据），保证切集瞬间抢跑的 startDanmaku 宏任务
    // 拿到的是空数据而非渲染闭包里的旧集弹幕；state 的清空用于驱动渲染链刷新
    dmDataRef.current = { key, items: [] };
    setDmItems([]);
    refreshDanmaku();
    setDmStatus('弹幕加载中');
    console.debug('[Danmaku] 请求弹幕', { seriesId, vid, force });
    api
      .getDanmaku(seriesId, vid, force)
      .then((data) => {
        if (req !== dmReqRef.current) return;
        const items = Array.isArray(data.items) ? data.items : [];
        console.debug('[Danmaku] 响应', {
          success: data.success,
          条数: items.length,
          notice: data.notice,
          error: data.error,
          首条: items[0] ? { text: items[0].text, time: items[0].time, likes: items[0].likes } : null,
          末条时间: items.length ? items[items.length - 1].time : null,
        });
        dmDataRef.current = { key, items };
        setDmItems(items);
        refreshDanmaku();
        setDmStatus(data.notice || (data.success ? `弹幕 ${items.length} 条` : '弹幕加载失败'));
      })
      .catch((e) => {
        console.error('[Danmaku] 请求异常', e);
        // 失败保持权威源为空数据（发起时已清），引擎即便存在也只是空转，不会残留旧集弹幕
        if (req === dmReqRef.current) setDmStatus('弹幕加载失败');
      });
  };

  // 切剧/切集：重置并重新加载弹幕。数据始终加载、与开关无关（开关仅控制显隐），
  // 避免开关关闭时进入播放器完全不拉取、"开开关/切集后才发现没弹幕"的时序错位
  useEffect(() => {
    dmKeyRef.current = '';
    stopDanmaku();
    if (itemId) loadDanmaku(false);
    return () => stopDanmaku();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesId, itemId]);

  // 弹幕列表更新：重建引擎（以最新列表与偏好渲染）
  useEffect(() => {
    refreshDanmaku();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dmItems]);

  // 弹幕偏好变更：开关只控制显隐（关=停引擎隐藏，开=用已有数据立即重建，无需重新请求）；
  // 行数/速度/高赞优先变更时重建引擎以应用新偏好（关闭状态下重建被 startDanmaku 守卫自然拦截，无害）
  useEffect(() => {
    if (dmPrefs.enabled) {
      refreshDanmaku();
    } else {
      stopDanmaku();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dmPrefs.enabled, dmPrefs.rows, dmPrefs.speed, dmPrefs.likesPriority]);

  // 弹幕设置面板：点击面板外关闭
  useEffect(() => {
    if (!dmOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.('.pc-danmaku')) setDmOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [dmOpen]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void boxRef.current?.requestFullscreen();
  }, []);

  // ===== 关闭防误触：连续点击两次才关窗（2.5s 无操作重置，类似移动端"再按一次退出"） =====
  const [closeArmed, setCloseArmed] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCloseClick = useCallback(() => {
    if (closeArmed) {
      void api.win.close();
      return;
    }
    setCloseArmed(true);
    toast('再点一次关闭播放器');
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => setCloseArmed(false), 2500);
  }, [closeArmed]);
  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    },
    [],
  );

  // ===== 控制条自动隐藏（顶部栏 / 底部栏 / 光标一体显隐） =====
  const pokeControls = useCallback(() => {
    setShowControls(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (!videoRef.current?.paused) setShowControls(false);
    }, 2600);
  }, []);

  useEffect(
    () => () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    },
    [],
  );

  // ===== 键盘快捷键 =====
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          seekBy(-5);
          break;
        case 'ArrowRight':
          seekBy(5);
          break;
        case 'ArrowUp':
          e.preventDefault();
          changeVolume(volume + 0.1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          changeVolume(volume - 0.1);
          break;
        case 'f':
        case 'F':
          toggleFullscreen();
          break;
        case 'Escape':
          if (dmOpen) setDmOpen(false);
          else if (epOpen) setEpOpen(false);
          break;
      }
      pokeControls();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekBy, changeVolume, toggleFullscreen, pokeControls, volume, epOpen, dmOpen]);

  useEffect(() => {
    const onFs = () => setIsFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // ===== video 事件（JSX 里绑定的小工具） =====
  const onTime = () => {
    const v = videoRef.current;
    if (!v) return;
    setCur(v.currentTime);
    if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
    // 即将进入下一集提示：剩余 ≤3s 且有下一集时显示（切集后新视频 currentTime 从 0 起，自然复位）
    const remain = Number.isFinite(v.duration) ? v.duration - v.currentTime : Infinity;
    setNextTip(Boolean(nextEp) && remain > 0 && remain <= NEXT_TIP_SECONDS);
  };

  // 进度条拖拽
  const barRef = useRef<HTMLDivElement>(null);
  const seekToEvent = (clientX: number) => {
    const bar = barRef.current;
    const v = videoRef.current;
    if (!bar || !v || !Number.isFinite(v.duration)) return;
    const rect = bar.getBoundingClientRect();
    v.currentTime = ((clientX - rect.left) / rect.width) * v.duration;
  };
  const [scrubbing, setScrubbing] = useState(false);
  useEffect(() => {
    if (!scrubbing) return;
    const move = (e: PointerEvent) => seekToEvent(e.clientX);
    const up = () => setScrubbing(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubbing]);

  // ===== 渲染 =====
  if (detailErr) return <ErrorTip message={detailErr} onRetry={() => window.location.reload()} />;
  if (!detail) return <Loading />;

  const playedPct = dur ? (cur / dur) * 100 : 0;
  const bufferedPct = dur ? (Math.min(buffered, dur) / dur) * 100 : 0;
  const chromeOn = showControls || !playing;

  return (
    <div
      ref={boxRef}
      className={`player-page${chromeOn ? ' show' : ' hide-cursor'}`}
      onMouseMove={pokeControls}
      onMouseLeave={() => playing && setShowControls(false)}
    >
      {/* ===== 顶部栏：标题 + 关闭（可拖拽移动窗口；显隐跟随控制栏） ===== */}
      <header className="pw-top">
        <div className="pw-top-title">
          <span className="pw-drama">{detail.title}</span>
          {curEp ? <span className="pw-ep">第 {curEp.index} 集</span> : null}
        </div>
        <span className="pw-flex" />
        <button
          className={`pw-btn${closeArmed ? ' armed' : ''}`}
          onClick={onCloseClick}
          aria-label="关闭播放器"
          title={closeArmed ? '再点一次关闭' : '关闭'}
        >
          ✕
        </button>
      </header>

      {/* ===== 视频层 ===== */}
      <video
        ref={videoRef}
        playsInline
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
        onPlay={() => setPlaying(true)}
        onPause={() => {
          setPlaying(false);
          saveProgress(true);
        }}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => {
          setBuffering(false);
          retryRef.current = 0; // 起播成功，重置重试计数
        }}
        onCanPlay={() => setBuffering(false)}
        onError={handleVideoError}
        onTimeUpdate={onTime}
        onDurationChange={() => setDur(videoRef.current?.duration || 0)}
        onEnded={() => {
          saveProgress(true);
          if (nextEp) goEpisode(nextEp);
        }}
      />

      {/* ===== 弹幕层：跟随视频时间轴滚动（数据始终加载；开关仅控制显隐，z 低于控制栏，pointer-events 关闭） ===== */}
      <div
        ref={dmLayerRef}
        className="danmaku-layer"
        style={{
          opacity: dmPrefs.opacity,
          height: dmPrefs.rows * DM_ROW_HEIGHT,
          display: dmPrefs.enabled ? undefined : 'none',
        }}
        aria-hidden="true"
      />

      {/* 遮罩层 */}
      {resolving || (buffering && !playErr) ? (
        <div className="player-mask">
          <div className="player-spinner" />
          <p>{resolving ? '正在解析视频地址…' : '加载中…'}</p>
        </div>
      ) : null}
      {playErr ? (
        <div className="player-mask">
          <IconWarning size={28} />
          <p>{playErr}</p>
          <button
            className="btn ghost"
            disabled={cooldownLeft > 0}
            onClick={() => {
              if (cooldownLeft > 0) return;
              retryRef.current = 0;
              void resolveVideo(true);
            }}
          >
            {cooldownLeft > 0 ? `免费通道繁忙，${cooldownLeft}s 后可重试` : '重试'}
          </button>
        </div>
      ) : null}
      {!playing && !resolving && !buffering && !playErr ? (
        <button className="player-bigplay" onClick={togglePlay} aria-label="播放">
          <IconPlay size={30} />
        </button>
      ) : null}

      {/* ===== 下一集预告提示：剩余 ≤3s 且有下一集时显示（播完自动切集） ===== */}
      {nextTip && nextEp ? (
        <div className="next-ep-tip" key={nextEp.id || nextEp.index} role="status">
          即将播放：第 {nextEp.index} 集
        </div>
      ) : null}

      {/* ===== 选集面板：右侧竖直抽屉（最高层级，自带关闭按钮） ===== */}
      {epOpen ? (
        <div className="pw-eps" onClick={(e) => e.stopPropagation()}>
          <div className="pw-eps-head">
            <h4>选集</h4>
            <span>共 {episodes.length} 集{detail.status === 'completed' ? ' · 已完结' : ''}</span>
            <button className="pw-btn" onClick={() => setEpOpen(false)} aria-label="关闭选集列表" title="关闭">
              ✕
            </button>
          </div>
          <div className="pw-eps-scroll">
            {epGroups.map((g, gi) => (
              <div key={gi} className="pw-eps-group">
                {epGroups.length > 1 ? (
                  <div className="pw-eps-group-title">
                    第 {g[0].index} – {g[g.length - 1].index} 集
                  </div>
                ) : null}
                <div className="pw-eps-list">
                  {g.map((ep) => (
                    <button
                      key={ep.index}
                      className={`pw-ep-row${ep.id === itemId ? ' current' : ''}${!ep.id && ep.locked ? ' locked' : ''}`}
                      onClick={() => goEpisode(ep)}
                      disabled={!ep.id && !!ep.locked}
                      title={
                        ep.locked && ep.id
                          ? `第 ${ep.index} 集（付费集，可尝试播放）`
                          : ep.locked
                            ? `第 ${ep.index} 集（暂未开放）`
                            : `第 ${ep.index} 集`
                      }
                    >
                      <span className="idx">{ep.index}</span>
                      <span className="t">{ep.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* ===== 底部控制栏 ===== */}
      <div className="player-controls" onClick={(e) => e.stopPropagation()}>
        <div
          ref={barRef}
          className="pc-progress"
          onPointerDown={(e) => {
            setScrubbing(true);
            seekToEvent(e.clientX);
          }}
        >
          <div className="pc-progress-buffer" style={{ width: `${bufferedPct}%` }} />
          <div className="pc-progress-played" style={{ width: `${playedPct}%` }}>
            <span className="pc-progress-dot" />
          </div>
        </div>
        <div className="pc-row">
          <button className="pc-btn" onClick={togglePlay} aria-label="播放/暂停">
            {playing ? <IconPause size={19} /> : <IconPlay size={19} />}
          </button>
          <button
            className="pc-btn"
            disabled={!prevEp}
            onClick={() => prevEp && goEpisode(prevEp)}
            aria-label="上一集"
            title={prevEp ? `第 ${prevEp.index} 集` : '没有上一集'}
          >
            <IconPrevEp size={17} />
          </button>
          <button
            className="pc-btn"
            disabled={!nextEp}
            onClick={() => nextEp && goEpisode(nextEp)}
            aria-label="下一集"
            title={nextEp ? `第 ${nextEp.index} 集` : '没有下一集'}
          >
            <IconNextEp size={17} />
          </button>
          <span className="pc-time">
            {fmt(cur)} <em>/</em> {fmt(dur)}
          </span>
          <span className="pc-flex" />
          {/* 弹幕开关 + 显示设置面板 */}
          <div className="pc-danmaku">
            <button
              className={`pc-btn pc-dm-btn${dmPrefs.enabled ? ' on' : ''}`}
              onClick={() => setDmOpen(!dmOpen)}
              title="弹幕设置"
              aria-label="弹幕设置"
              aria-expanded={dmOpen}
            >
              弹幕
            </button>
            {dmOpen ? (
              <div className="dm-panel">
                <div className="dm-panel-header">
                  <strong>弹幕设置</strong>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={dmPrefs.enabled}
                    aria-label="弹幕开关"
                    className={`dm-toggle${dmPrefs.enabled ? ' on' : ''}`}
                    onClick={() => updateDmPrefs({ enabled: !dmPrefs.enabled })}
                  >
                    <span className="dm-toggle-knob" />
                  </button>
                </div>
                <div className="dm-panel-row">
                  <span>显示行数</span>
                  <div className="dm-options">
                    {DM_ROW_OPTIONS.map((n) => (
                      <button
                        key={n}
                        className={dmPrefs.rows === n ? 'active' : ''}
                        onClick={() => updateDmPrefs({ rows: n })}
                      >
                        {n} 行
                      </button>
                    ))}
                  </div>
                </div>
                <div className="dm-panel-row">
                  <span>滚动速度</span>
                  <div className="dm-options">
                    {(['fast', 'medium', 'slow'] as const).map((v) => (
                      <button
                        key={v}
                        className={dmPrefs.speed === v ? 'active' : ''}
                        onClick={() => updateDmPrefs({ speed: v })}
                      >
                        {{ fast: '快', medium: '中', slow: '慢' }[v]}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="dm-panel-row">
                  <span>不透明度</span>
                  <input
                    type="range"
                    className="hg-range"
                    style={fillStyle(dmPrefs.opacity)}
                    min={0.1}
                    max={1}
                    step={0.1}
                    value={dmPrefs.opacity}
                    onChange={(e) => updateDmPrefs({ opacity: Number(e.target.value) })}
                    aria-label="弹幕不透明度"
                  />
                  <span>{Math.round(dmPrefs.opacity * 100)}%</span>
                </label>
                <div className="dm-panel-row">
                  <span>高赞优先</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={dmPrefs.likesPriority}
                    className={`dm-toggle${dmPrefs.likesPriority ? ' on' : ''}`}
                    onClick={() => updateDmPrefs({ likesPriority: !dmPrefs.likesPriority })}
                    title="同屏冲突或弹幕密集时优先保留高赞弹幕，舍弃低赞/0 赞弹幕"
                  >
                    <span className="dm-toggle-knob" />
                  </button>
                </div>
                {dmStatus ? (
                  <div className="dm-status">
                    {dmStatus}
                    {dmStatus.includes('失败') ? <button onClick={() => loadDanmaku(true)}>重试</button> : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <button
            className={`pc-btn pc-eps-toggle${epOpen ? ' on' : ''}`}
            onClick={() => setEpOpen(!epOpen)}
            title={epOpen ? '收起选集列表' : '展开选集列表'}
            aria-label="选集列表"
          >
            <IconEpList size={17} />
          </button>
          <button className="pc-btn pc-rate" onClick={cycleRate} title="播放倍速">
            {RATE_OPTIONS[rateIdx]}x
          </button>
          <div className="pc-volume">
            <button className="pc-btn" onClick={toggleMute} aria-label="静音">
              <IconVolume size={18} muted={muted || volume === 0} />
            </button>
            <input
              type="range"
              className="hg-range"
              style={fillStyle(muted ? 0 : volume)}
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => changeVolume(Number(e.target.value))}
              aria-label="音量"
            />
          </div>
          <button className="pc-btn" onClick={toggleFullscreen} aria-label="全屏">
            <IconFullscreen size={18} on={isFull} />
          </button>
        </div>
      </div>

      {/* ===== 迷你进度条：控制栏隐藏时底部 2px 常驻细条（纯展示，鼠标移动即唤起控制栏） ===== */}
      {!chromeOn && dur > 0 ? (
        <div className="mini-progress" aria-hidden="true">
          <div className="mini-progress-buffer" style={{ width: `${bufferedPct}%` }} />
          <div className="mini-progress-played" style={{ width: `${playedPct}%` }} />
        </div>
      ) : null}
    </div>
  );
}
