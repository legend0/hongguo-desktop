import { useParams, Link } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAsync } from '../hooks/useAsync';
import { api } from '../api';
import { useFavorites, useHistory } from '../stores';
import { Cover } from '../components/Cover';
import { ErrorTip, Loading } from '../components/Feedback';
import { toast } from '../components/Toast';
import { DramaCardView } from '../components/DramaCard';
import { HRow } from '../components/HRow';
import {
  IconPlay,
  IconHeart,
  IconFire,
  IconStar,
  IconClock,
  IconChevronRight,
  IconChevronLeft,
  IconChart,
} from '../components/Icons';
import { rankHref } from '../routes';
import { fetchRelatedSeasons } from '../lib/season';
import type { DramaCard, DramaDetail } from '../types';

/** 指标数值格式化：9116 → "9116万"，1.2万 → "1.2亿" */
function fmtMetric(v: number | undefined): string {
  if (v === undefined) return '';
  if (v >= 10000) return `${(v / 10000).toFixed(1)}亿`;
  if (v >= 1) return `${v % 1 === 0 ? v : v.toFixed(1)}万`;
  return String(v);
}

/** 热评时间：ISO 串 → "09-30" */
function fmtDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 详情页：大背景图 + hero 信息 + 选集 + 热评 + 相关推荐 */
export function DetailPage() {
  const { id = '' } = useParams();
  const { data, loading, error, reload } = useAsync(() => api.getDetail(id), [id]);
  const favorites = useFavorites();
  const history = useHistory();
  const [descOpen, setDescOpen] = useState(false);
  const [descOverflow, setDescOverflow] = useState(false);
  const descRef = useRef<HTMLParagraphElement>(null);
  /** 选集激活 tab 下标（每 50 集一组；null = 自动定位到上次观看的组） */
  const [epTab, setEpTab] = useState<number | null>(null);
  /** 演员条：横向滚动引用与两侧可滑状态 */
  const castStripRef = useRef<HTMLDivElement>(null);
  const [castCanL, setCastCanL] = useState(false);
  const [castCanR, setCastCanR] = useState(false);
  /** 背景图 portal 容器（.hero-layer，铺满右侧整列含顶部控制栏） */
  const [heroLayer, setHeroLayer] = useState<HTMLElement | null>(null);
  /** 同系列各季（含当前季，季数升序；null = 未加载完成或不适用） */
  const [seasons, setSeasons] = useState<DramaCard[] | null>(null);
  /** 分季请求竞态计数：快速切换剧目时丢弃过期结果 */
  const seasonsReqRef = useRef(0);
  useEffect(() => {
    setSeasons(null);
    if (!data) return;
    const req = ++seasonsReqRef.current;
    fetchRelatedSeasons(data)
      .then((list) => {
        if (seasonsReqRef.current === req) setSeasons(list);
      })
      .catch(() => {
        if (seasonsReqRef.current === req) setSeasons([data]);
      });
    return () => {
      seasonsReqRef.current += 1; // 卸载/切剧时作废在途请求
    };
  }, [data]);
  useEffect(() => {
    setHeroLayer(document.getElementById('hero-layer'));
  }, []);

  /** 测量演员条两侧是否还有内容（决定左右箭头是否显示） */
  const measureCast = () => {
    const el = castStripRef.current;
    if (!el) return;
    setCastCanL(el.scrollLeft > 2);
    setCastCanR(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  };
  useEffect(() => {
    measureCast();
    const el = castStripRef.current;
    if (!el) return;
    const onScroll = () => measureCast();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(measureCast);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [data]);

  // 切换剧目时收起简介、选集 tab 回到自动定位、回到顶部
  useEffect(() => {
    setDescOpen(false);
    setEpTab(null);
    document.querySelector('.app-main')?.scrollTo({ top: 0 });
  }, [id]);

  // 简介超 3 行截断才显示"展开"按钮（同样仅在折叠态测量）
  useEffect(() => {
    const el = descRef.current;
    if (el && !descOpen) setDescOverflow(el.scrollHeight > el.clientHeight + 4);
  });

  if (loading) return <Loading />;
  if (error) return <ErrorTip message={error} onRetry={reload} />;
  if (!data) return null;

  const isFav = favorites.items[id] !== undefined;
  const lastWatch = history.entries.find((e) => e.dramaId === id);

  type EpisodeItem = NonNullable<typeof data>['episodes'][number];
  /**
   * 可播判定：站点给到播放路径即为可播（第 1 集是根路径 /player/{id}）。
   * 注意不能用 locked 判定 —— 站点把"未列进可播清单"的集补成 locked，
   * 但这只是"未开放"的推断，不是可靠的锁标记（见 docs 里 302 说明）。
   */
  const isPlayable = (ep: EpisodeItem) => !!ep.playPath || !!ep.id;
  /** 打开一集：不可播的集给出提示；可播集在独立播放器窗口打开 */
  const openEpisodeBy = (ep: EpisodeItem) => {
    if (!isPlayable(ep)) {
      toast(`第 ${ep.index} 集暂未开放，请到「黑果短剧」App 观看`);
      return;
    }
    // 第 1 集可能无 itemId（站点根路径 /player/{seriesId}），窗口内路由兼容无 itemId
    void api.win.openPlayer(data.id, ep.id || '');
  };
  const onPlay = () => {
    // 优先续播上次看到且可播的集，否则第一集
    const resumeEp = data.episodes.find((e) => isPlayable(e) && e.id === lastWatch?.episodeId);
    const target = resumeEp ?? data.episodes.find((e) => isPlayable(e));
    if (target) openEpisodeBy(target);
  };
  const onFav = () => {
    favorites.toggle({
      id: data.id,
      title: data.title,
      coverUrl: data.coverUrl,
      totalEpisodes: data.totalEpisodes,
      tags: data.tags,
    });
    toast(isFav ? '已取消收藏' : '已加入收藏');
  };

  // 选集分组：每 50 集一组，987 集也不会堆成一长条
  const GROUP = 50;
  const groups: EpisodeItem[][] = [];
  for (let i = 0; i < data.episodes.length; i += GROUP) {
    groups.push(data.episodes.slice(i, i + GROUP));
  }

  const recs = [...data.recommendations, ...data.hotRecommendations].filter(
    (r, i, arr) => r.id && arr.findIndex((x) => x.id === r.id) === i,
  );

  const heroTags = [...new Set([...data.category, ...data.tags].filter((t) => t !== data.title))];

  /** 选集激活 tab：用户未手动切换时，默认定位到上次观看的集所在组 */
  const defaultTab = lastWatch
    ? Math.min(groups.length - 1, Math.max(0, Math.floor((lastWatch.episodeIndex - 1) / GROUP)))
    : 0;
  const activeTab = epTab ?? defaultTab;
  /** 已完播分集（播放进度 ≥90% 记录，来自播放器写入的观看历史） */
  const finishedSet = new Set(lastWatch?.finishedEpIds ?? []);

  return (
    <div className="page page-pad detail-page">
      {/* ===== 大背景图（与首页同一套方案：portal 到 .hero-layer，铺满右侧整列含顶部控制栏，自上而下渐隐 + 模糊） ===== */}
      {heroLayer
        ? createPortal(
            <div className="dt-hero-bg" aria-hidden="true">
              <img src={data.backgroundImage || data.coverUrl} alt="" draggable={false} referrerPolicy="no-referrer" />
            </div>,
            heroLayer,
          )
        : null}

      {/* ===== Hero 信息区 ===== */}
      <header className="dt-hero">
        <div className="dt-cover">
          <Cover src={data.coverUrl} alt={data.title} className="dt-cover-img" />
        </div>

        <div className="dt-info">
          <div className="dt-title-row">
            <h1>{data.title}</h1>
            {data.rankInfo ? (
              <Link className="dt-rank" to={rankHref(data.rankInfo.path) ?? '#'}>
                <IconChart size={13} />
                {data.rankInfo.label}
                <b>{data.rankInfo.rank}</b>
              </Link>
            ) : null}
          </div>

          {/* 指标区：热度 / 评分 / 点赞 / 收藏 */}
          <div className="dt-metrics">
            {data.heatValue !== undefined ? (
              <span className="dt-metric heat">
                <IconFire size={15} />
                <b>{fmtMetric(data.heatValue)}</b>
                <i>热度</i>
              </span>
            ) : null}
            {data.ratingValue !== undefined ? (
              <span className="dt-metric score">
                <IconStar size={15} />
                <b>{data.rating}</b>
                <i>评分</i>
              </span>
            ) : null}
            {data.likeValue !== undefined ? (
              <span className="dt-metric like">
                <IconHeart size={15} />
                <b>{fmtMetric(data.likeValue)}</b>
                <i>点赞</i>
              </span>
            ) : null}
            {data.favoriteValue !== undefined ? (
              <span className="dt-metric fav">
                <IconStar size={15} />
                <b>{fmtMetric(data.favoriteValue)}</b>
                <i>收藏</i>
              </span>
            ) : null}
          </div>

          {/* 基本信息行 */}
          <div className="dt-meta">
            {data.totalEpisodes ? <span>共 {data.totalEpisodes} 集</span> : null}
            {data.status === 'completed' ? (
              <span className="dt-status done">已完结</span>
            ) : data.status === 'updating' ? (
              <span className="dt-status">更新中</span>
            ) : null}
            {data.orientation === 'horizontal' ? <span>横屏</span> : null}
            {data.accessibleEpisodeCount ? <span>可播 {data.accessibleEpisodeCount} 集</span> : null}
          </div>

          {heroTags.length ? (
            <div className="dt-tags">
              {heroTags.map((t, i) => (
                <span key={t} className={`dt-tag c${i % 6}`}>
                  {t}
                </span>
              ))}
            </div>
          ) : null}

          {data.description ? (
            <div className="dt-desc-block">
              <p
                ref={descRef}
                className={`dt-desc${descOpen ? ' open' : ''}`}
                onClick={() => descOverflow && setDescOpen(!descOpen)}
              >
                {data.description}
              </p>
              {/* 展开按钮放在截断区外：截断会隐藏内部元素，按钮在外才能始终可点 */}
              {descOverflow ? (
                <button className="dt-desc-toggle" onClick={() => setDescOpen(!descOpen)}>
                  {descOpen ? '收起' : '展开'}
                  <IconChevronRight size={12} className={descOpen ? 'up' : ''} />
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="dt-actions">
            <button className="btn primary" onClick={onPlay}>
              <IconPlay size={15} />
              {lastWatch ? `继续看第 ${lastWatch.episodeIndex} 集` : '立即播放'}
            </button>
            <button className={`btn ${isFav ? 'fav-active' : 'ghost'}`} onClick={onFav}>
              <IconHeart size={15} filled={isFav} />
              {isFav ? '已收藏' : '收藏'}
            </button>
          </div>
        </div>
      </header>

      {/* ===== 演员表：独立横条，位于选集区上方（不在选集分区内） ===== */}
      {data.actors.length ? (
        <div className="dt-cast-band">
          <div className="dt-cast-strip-wrap">
            <div className="dt-cast-strip" ref={castStripRef}>
              {data.actors.map((a) => {
                const face = (
                  <>
                    <div className="dt-cast-face">
                      {a.avatarUrl ? (
                        <img src={a.avatarUrl} alt={a.name} referrerPolicy="no-referrer" />
                      ) : (
                        <span>{a.name.slice(0, 1)}</span>
                      )}
                    </div>
                    <div className="dt-cast-name">{a.name}</div>
                    {a.role ? <div className="dt-cast-role">{a.role}</div> : null}
                  </>
                );
                // App 端演员 id（纯数字）可跳转剧星榜演员主页
                return /^\d+$/.test(a.id) ? (
                  <Link key={a.id || a.name} to={`/actor/${a.id}`} className="dt-cast-item">
                    {face}
                  </Link>
                ) : (
                  <div key={a.id || a.name} className="dt-cast-item">{face}</div>
                );
              })}
            </div>
            <button
              className={`dt-cast-arrow left${castCanL ? ' show' : ''}`}
              aria-label="向左滑动演员"
              onClick={() => castStripRef.current?.scrollBy({ left: -320, behavior: 'smooth' })}
            >
              <IconChevronLeft size={16} />
            </button>
            <button
              className={`dt-cast-arrow right${castCanR ? ' show' : ''}`}
              aria-label="向右滑动演员"
              onClick={() => castStripRef.current?.scrollBy({ left: 320, behavior: 'smooth' })}
            >
              <IconChevronRight size={16} />
            </button>
          </div>
        </div>
      ) : null}

      {/* ===== 选集 ===== */}
      <section className="dt-section">
        <div className="section-head">
          <h2>选集</h2>
          <span className="more">共 {data.episodes.length} 集</span>
        </div>

        {/* 分组 tab：每组 50 集；单组时不显示 tab，默认定位到上次观看的组 */}
        {groups.length > 1 ? (
          <div className="dt-ep-tabs" role="tablist">
            {groups.map((g, gi) => (
              <button
                key={gi}
                role="tab"
                aria-selected={gi === activeTab}
                className={`dt-ep-tab${gi === activeTab ? ' on' : ''}`}
                onClick={() => setEpTab(gi)}
              >
                第 {g[0].index} – {g[g.length - 1].index} 集
              </button>
            ))}
          </div>
        ) : null}

        <div className="ep-grid">
          {(groups[activeTab] ?? []).map((ep) => (
            <button
              key={ep.index}
              className={`ep-cell${lastWatch?.episodeIndex === ep.index ? ' current' : ''}${
                ep.id && finishedSet.has(ep.id) ? ' watched' : ''
              }`}
              onClick={() => openEpisodeBy(ep)}
              title={isPlayable(ep) ? ep.title : `第 ${ep.index} 集（暂未开放）`}
            >
              {ep.index}
            </button>
          ))}
        </div>
      </section>

      {/* ===== 分季：同系列各季（无标题，UI 同底部推荐；当前季置灰不可点） ===== */}
      {seasons && seasons.length > 1 ? (
        <section className="dt-section">
          <HRow dep={seasons.length}>
            {seasons.map((s) => (
              <div className="hrow-item" key={s.id}>
                <DramaCardView drama={s} disabled={s.id === data.id} />
              </div>
            ))}
          </HRow>
        </section>
      ) : null}

      {/* ===== 热评：横向拖动轨道（与推荐同款交互） ===== */}
      {data.reviews.length ? (
        <section className="dt-section">
          <div className="section-head">
            <h2>热评</h2>
            {data.reviewTotal ? <span className="more">{data.reviewTotal} 条</span> : null}
          </div>
          <HRow dep={data.reviews.length}>
            {data.reviews.map((r, i) => (
              <div className="hrow-item dt-review-item" key={i}>
                <article className="dt-review">
                  <div className="dt-review-head">
                    {r.authorAvatarUrl ? (
                      <img className="dt-review-avatar" src={r.authorAvatarUrl} alt={r.author} referrerPolicy="no-referrer" />
                    ) : (
                      <span className="dt-review-avatar fallback">{r.author.slice(0, 1)}</span>
                    )}
                    <div className="dt-review-meta">
                      <div className="dt-review-author">{r.author}</div>
                      {r.publishedAt ? (
                        <div className="dt-review-time">
                          <IconClock size={11} />
                          {fmtDate(r.publishedAt)}
                        </div>
                      ) : null}
                    </div>
                    {r.rating !== undefined ? (
                      <span className="dt-review-score">
                        <IconStar size={12} />
                        {r.rating}
                      </span>
                    ) : null}
                  </div>
                  <p className="dt-review-text">{r.content}</p>
                  {r.likes !== undefined ? (
                    <div className="dt-review-likes">
                      <IconHeart size={12} />
                      {r.likes}
                    </div>
                  ) : null}
                </article>
              </div>
            ))}
          </HRow>
        </section>
      ) : null}

      {/* ===== 相关推荐 ===== */}
      {recs.length ? (
        <section className="dt-section">
          <div className="section-head">
            <h2>相关短剧</h2>
          </div>
          <HRow dep={recs.length}>
            {recs.map((r) => (
              <div className="hrow-item" key={r.id}>
                <DramaCardView drama={r} />
              </div>
            ))}
          </HRow>
        </section>
      ) : null}
    </div>
  );
}
