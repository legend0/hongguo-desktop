import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Cover } from '../components/Cover';
import { IconChevronRight } from '../components/Icons';
import { ListShell } from '../components/ListShell';
import { usePagedList } from '../hooks/usePagedList';
import type { ActorCard } from '../types';

/** 性别筛选（App 端演员协议 gender 参数；'' = 全部） */
const GENDERS: { key: string; label: string }[] = [
  { key: '', label: '全部' },
  { key: 'female', label: '女演员' },
  { key: 'male', label: '男演员' },
];

/** 前三名徽章的奖牌 emoji（demo 同款） */
const MEDALS = ['🥇', '🥈', '🥉'];

/**
 * 剧星榜：App 端演员协议的演员热度榜单，
 * 头部固定（标题 + 性别筛选），列表独立滚动、触底自动加载下一页。
 */
export function ActorsPage() {
  const [gender, setGender] = useState('');
  /** 榜单统计日期（上游协议 rank_date，随分页响应透传，取一次即可） */
  const [rankDate, setRankDate] = useState('');
  const { items, loading, loadingMore, error, hasMore, loadMore, reload } = usePagedList<ActorCard>(
    (page) =>
      api.getActorRanking(page, gender || undefined).then((r) => {
        setRankDate(r.rankDate || '');
        return { items: r.items, hasMore: r.hasMore };
      }),
    gender,
  );

  return (
    <ListShell
      head={
        <div className="section-head">
          <h2>剧星榜</h2>
          <div className="actors-head-right">
            {rankDate ? <span className="actors-date">数据时间：{rankDate}</span> : null}
            <div className="chips">
              {GENDERS.map((g) => (
                <button
                  key={g.key}
                  className={`chip${gender === g.key ? ' on' : ''}`}
                  onClick={() => setGender(g.key)}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      }
      loading={loading}
      loadingMore={loadingMore}
      hasMore={hasMore}
      error={error}
      onRetry={reload}
      onLoadMore={loadMore}
      empty={!loading && !error && items.length === 0 ? <div className="center-tip">暂无上榜演员</div> : undefined}
    >
      <div className="grid actors-grid">
        {items.map((a) => {
          const change = a.rankChange;
          return (
            <Link
              key={a.id}
              to={`/actor/${a.id}`}
              className="actor-card"
              title={a.intro || a.name}
              /* 携带榜单人气/名次，供演员主页 hero 徽章展示（详情协议无此数据） */
              state={{ score: a.score, rank: a.rank, subTitles: a.subTitles }}
            >
              <div className="actor-card-head">
                {a.rank ? (
                  <span className={`actor-rank-badge${a.rank <= 3 ? ` top${a.rank}` : ''}`}>
                    {a.rank <= 3 ? `${MEDALS[a.rank - 1]} ` : ''}TOP {a.rank}
                  </span>
                ) : (
                  <span />
                )}
                {change ? (
                  <span
                    className={`actor-rank-change ${change.type === 1 ? 'up' : change.type === 2 ? 'down' : 'flat'}`}
                    title={change.type === 1 ? `较上期上升 ${change.num} 位` : change.type === 2 ? `较上期下降 ${change.num} 位` : '与上期持平'}
                  >
                    {change.type === 1 ? `▲${change.num}` : change.type === 2 ? `▼${change.num}` : '—'}
                  </span>
                ) : null}
              </div>
              <Cover src={a.avatarUrl || ''} alt={a.name} className="actor-ava" />
              <div className="actor-name">{a.name}</div>
              <div className="actor-score-tag">🔥 {a.score || '人气热推'}</div>
              {a.subTitles?.length ? (
                <div className="actor-tags">
                  {a.subTitles.slice(0, 2).map((s) => (
                    <span key={s} className="chip">
                      {s}
                    </span>
                  ))}
                </div>
              ) : null}
              {a.intro ? <div className="actor-intro">{a.intro}</div> : null}
              <span className="actor-more">
                主页与作品 <IconChevronRight size={11} />
              </span>
            </Link>
          );
        })}
      </div>
    </ListShell>
  );
}
