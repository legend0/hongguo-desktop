import { Link, useLocation, useParams } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Cover } from '../components/Cover';
import { DramaCardView } from '../components/DramaCard';
import { IconFire, IconChevronLeft, IconChevronRight } from '../components/Icons';
import { ErrorTip, Loading } from '../components/Feedback';
import { usePagedList } from '../hooks/usePagedList';
import { useAsync } from '../hooks/useAsync';
import type { ActorCard, ActorWorksPage, DramaCard } from '../types';

/** 演员主页：头像/简介（App 端演员协议）+ 相关演员 + 作品网格（分页）。 */
export function ActorDetailPage() {
  const { actorId = '' } = useParams();
  // 列表页跳转携带的人气/名次（详情协议不返回这两项，有则展示）
  const nav = useLocation().state as { score?: string; rank?: number; subTitles?: string[] } | null;
  const { data, loading, error, reload } = useAsync(
    () => api.getActorDetail(actorId),
    [actorId],
  );
  const works = usePagedList<DramaCard, { total: number }>(
    (page) =>
      api.getActorWorks(actorId, page).then((r) => ({
        items: r.items,
        meta: { total: r.total },
        hasMore: r.hasMore,
      })),
    actorId,
  );
  /** 合作演员横向滑动条：滚动引用与两侧可滑状态（同影视详情页演员条） */
  const castStripRef = useRef<HTMLDivElement>(null);
  const [castCanL, setCastCanL] = useState(false);
  const [castCanR, setCastCanR] = useState(false);

  /** 测量滑动条两侧是否还有内容（决定左右箭头是否显示） */
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

  if (!actorId) return <div className="center-tip">无效的演员编号</div>;
  if (loading) return <Loading />;
  if (error) return <ErrorTip message={error} onRetry={reload} />;

  const related: ActorCard[] = data?.related ?? [];
  const total = works.meta?.total;

  return (
    <div className="page page-pad actor-detail">
      <div className="actor-hero">
        <Cover src={data?.avatarUrl || ''} alt={data?.name || ''} className="actor-hero-ava" />
        <div className="actor-hero-info">
          <div className="actor-hero-name-row">
            <h2>{data?.name || '未知演员'}</h2>
            {nav?.rank ? <span className="actor-rank-pill">剧星榜 TOP {nav.rank}</span> : null}
            {nav?.score ? (
              <span className="actor-score-pill">
                <IconFire size={12} />
                {nav.score}
              </span>
            ) : null}
          </div>
          {nav?.subTitles?.length ? (
            <div className="actor-hero-chips">
              {nav.subTitles.slice(0, 3).map((s) => (
                <span key={s} className="chip">
                  {s}
                </span>
              ))}
            </div>
          ) : null}
          {data?.intro ? <p className="actor-hero-intro">{data.intro}</p> : null}
        </div>
      </div>

      {related.length > 0 ? (
        <>
          <div className="section-head">
            <h2>合作演员</h2>
            <span className="more">{related.length} 人</span>
          </div>
          <div className="dt-cast-band actor-cast-band">
            <div className="dt-cast-strip-wrap">
              <div className="dt-cast-strip" ref={castStripRef}>
                {related.map((r) => (
                  <Link key={r.id} to={`/actor/${r.id}`} className="dt-cast-item" title={r.intro || r.name}>
                    <div className="dt-cast-face">
                      {r.avatarUrl ? (
                        <img src={r.avatarUrl} alt={r.name} referrerPolicy="no-referrer" />
                      ) : (
                        <span>{r.name.slice(0, 1)}</span>
                      )}
                    </div>
                    <div className="dt-cast-name">{r.name}</div>
                  </Link>
                ))}
              </div>
              <button
                className={`dt-cast-arrow left${castCanL ? ' show' : ''}`}
                aria-label="向左滑动合作演员"
                onClick={() => castStripRef.current?.scrollBy({ left: -320, behavior: 'smooth' })}
              >
                <IconChevronLeft size={16} />
              </button>
              <button
                className={`dt-cast-arrow right${castCanR ? ' show' : ''}`}
                aria-label="向右滑动合作演员"
                onClick={() => castStripRef.current?.scrollBy({ left: 320, behavior: 'smooth' })}
              >
                <IconChevronRight size={16} />
              </button>
            </div>
          </div>
        </>
      ) : null}

      <div className="section-head">
        <h2>出演作品</h2>
        {total ? <span className="more">共 {total} 部</span> : null}
      </div>
      <div className="grid">
        {works.items.map((d) => (
          <DramaCardView key={d.id} drama={d} />
        ))}
      </div>
      {works.loading ? <Loading /> : null}
      {!works.loading && !works.hasMore && works.items.length === 0 ? (
        <div className="center-tip">暂无收录的作品</div>
      ) : null}
      {works.hasMore ? (
        <div className="center-tip">
          <button className="btn" onClick={works.loadMore} disabled={works.loadingMore}>
            {works.loadingMore ? '加载中…' : '加载更多作品'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
