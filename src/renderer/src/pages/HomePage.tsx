import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useAsync } from '../hooks/useAsync';
import { api } from '../api';
import { useHistory } from '../stores';
import { fetchRecommendations } from '../recommend';
import { HRow } from '../components/HRow';
import { DramaCardView } from '../components/DramaCard';
import { Cover } from '../components/Cover';
import { ErrorTip, Loading } from '../components/Feedback';
import { IconPlay, IconChevronRight, IconTrash, IconClock } from '../components/Icons';
import { toast } from '../components/Toast';
import type { DramaCard, HomeSection } from '../types';

const BANNER_INTERVAL = 5000;

/**
 * Banner 轮播：取每个分区的高分（首位）项。
 * 图片通过 portal 渲染到 `.hero-layer`（右侧整列，含顶部控制栏），
 * 自上而下渐隐；这里只保留文案、渐变遮罩与指示器。
 */
function Banner({ slides }: { slides: { item: DramaCard; section: string }[] }) {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [layer, setLayer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setLayer(document.getElementById('hero-layer'));
  }, []);

  useEffect(() => {
    if (paused || slides.length <= 1) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % slides.length), BANNER_INTERVAL);
    return () => clearInterval(t);
  }, [paused, slides.length]);

  if (slides.length === 0) return null;

  return (
    <>
      {layer
        ? createPortal(
            <div className="hero-bg" aria-hidden="true">
              {slides.map(({ item }, i) => (
                <div key={item.id} className={`hero-slide${i === idx ? ' on' : ''}`}>
                  {item.coverUrl ? (
                    <img
                      src={item.coverUrl}
                      alt=""
                      loading={i === 0 ? 'eager' : 'lazy'}
                      draggable={false}
                    />
                  ) : null}
                </div>
              ))}
              <div className="hero-scrim" />
            </div>,
            layer,
          )
        : null}

      <div className="banner" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
        {slides.map(({ item, section }, i) => (
          <Link
            key={item.id}
            className={`banner-slide${i === idx ? ' on' : ''}`}
            to={`/drama/${item.id}`}
            aria-hidden={i !== idx}
            tabIndex={i === idx ? 0 : -1}
          >
            <div className="banner-info">
              <span className="banner-chip">{section}</span>
              <h2>{item.title}</h2>
              <div className="banner-meta">
                {item.tags.slice(0, 3).join(' / ')}
                {item.totalEpisodes ? ` · 共 ${item.totalEpisodes} 集` : ''}
              </div>
              <span className="banner-play">
                <IconPlay size={14} />
                立即观看
              </span>
            </div>
          </Link>
        ))}
        <div className="banner-dots">
          {slides.map((_, i) => (
            <button
              key={i}
              className={i === idx ? 'on' : ''}
              title={`切换到第 ${i + 1} 个推荐`}
              onClick={() => setIdx(i)}
            />
          ))}
        </div>
      </div>
    </>
  );
}

/** 观看历史横版卡（16:9 封面 + 集数角标 + 进度条 + 悬停播放浮层） */
function HistoryCard({
  entry,
  onRemove,
}: {
  entry: {
    dramaId: string;
    title: string;
    coverUrl: string;
    episodeIndex: number;
    totalEpisodes?: number;
  };
  onRemove: () => void;
}) {
  const progress =
    entry.totalEpisodes && entry.totalEpisodes > 0
      ? Math.min(100, Math.round((entry.episodeIndex / entry.totalEpisodes) * 100))
      : undefined;

  return (
    <Link className="hcard" to={`/drama/${entry.dramaId}`}>
      <div className="hcard-cover">
        <Cover src={entry.coverUrl} alt={entry.title} />
        <div className="hcard-shade" />
        <span className="hcard-ep">看到第 {entry.episodeIndex} 集</span>
        <span className="hcard-play">
          <IconPlay size={22} />
        </span>
        <button
          className="hcard-del"
          title="删除该记录"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
        >
          <IconTrash size={14} />
        </button>
        {progress !== undefined ? (
          <div className="hcard-progress">
            <i style={{ width: `${progress}%` }} />
          </div>
        ) : null}
      </div>
      <div className="hcard-t">{entry.title}</div>
    </Link>
  );
}

/**
 * 首页：Banner 轮播（各分类高分项）+ 观看历史 + 分类横向轨道（可拖拽滑动）。
 * 数据源：首页 SSR 分区（热播短剧/真人剧/漫剧/AI剧）。
 */
export function HomePage() {
  const { data, loading, error, reload } = useAsync(() => api.getHome(), []);
  const recs = useAsync(() => fetchRecommendations(12), []);
  const history = useHistory();

  if (loading) return <Loading />;
  if (error) return <ErrorTip message={error} onRetry={reload} />;

  const sections: HomeSection[] = data ?? [];
  if (sections.length === 0) {
    return <div className="center-tip">暂无数据，站点可能已改版</div>;
  }

  // Banner：推荐 2 + 热播 2（推荐来自画像 feed；未就绪/失败时退回原「各分区头部」形态）
  const hotSection = sections.find((s) => s.name === '热播短剧') ?? sections[0];
  const recCards: DramaCard[] = (recs.data ?? []).map((c) => ({
    id: c.id,
    title: c.title,
    coverUrl: c.coverUrl,
    totalEpisodes: c.totalEpisodes ?? null,
    tags: c.tags,
    kind: c.kind,
  }));
  const seen = new Set<string>();
  const slides: { item: DramaCard; section: string }[] = [];
  for (const item of recCards.slice(0, 2)) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      slides.push({ item, section: '为你推荐' });
    }
  }
  for (const item of (hotSection?.items ?? []).slice(0, 2)) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      slides.push({ item, section: hotSection?.name ?? '热播' });
    }
  }
  for (const s of sections) {
    if (slides.length >= 4) break;
    const item = s.items[0];
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      slides.push({ item, section: s.name });
    }
  }

  // 猜你喜欢：推荐 feed 其余项，与 banner 及下方各分类轨道统一去重——
  // 推荐候选与 SSR 分区同源（分类接口），不去重会出现同一部剧在「猜你喜欢」和分类轨道重复展示
  const shownIds = new Set<string>([
    ...slides.map((s) => s.item.id),
    ...sections.flatMap((s) => s.items.map((d) => d.id)),
  ]);
  const likeItems = recCards.filter((d) => !shownIds.has(d.id)).slice(0, 10);

  return (
    <div className="page home">
      <Banner slides={slides} />

      <div className="home-body">
        {history.entries.length > 0 ? (
        <>
          <div className="section-head">
            <h2>
              <IconClock size={16} className="sec-icon" />
              观看历史
            </h2>
            <button
              className="link-btn"
              onClick={() => {
                history.clear();
                toast('已清空观看历史');
              }}
            >
              <IconTrash size={13} />
              全部清空
            </button>
          </div>
          <HRow dep={history.entries.length}>
            {history.entries.slice(0, 12).map((e) => (
              <HistoryCard
                key={e.dramaId}
                entry={e}
                onRemove={() => {
                  history.remove(e.dramaId);
                  toast('已删除该记录');
                }}
              />
            ))}
          </HRow>
        </>
      ) : null}

      {likeItems.length > 0 ? (
        <div>
          <div className="section-head">
            <h2>猜你喜欢</h2>
          </div>
          <HRow dep={likeItems.length}>
            {likeItems.map((d) => (
              <div className="hrow-item" key={d.id}>
                <DramaCardView drama={d} />
              </div>
            ))}
          </HRow>
        </div>
      ) : null}

      {sections.map((s) => {
        // 「查看更多」指向站内路由（/rank/hot-drama、/category/real-drama 等）
        const moreHref = s.moreUrl;
        return (
        <div key={s.name}>
          <div className="section-head">
            <h2>{s.name}</h2>
            {moreHref ? (
              <Link className="more" to={moreHref}>
                查看更多
                <IconChevronRight size={13} />
              </Link>
            ) : null}
          </div>
          <HRow dep={s.items.length}>
            {s.items.map((d) => (
              <div className="hrow-item" key={d.id}>
                <DramaCardView drama={d} />
              </div>
            ))}
          </HRow>
        </div>
        );
      })}
      </div>
    </div>
  );
}
