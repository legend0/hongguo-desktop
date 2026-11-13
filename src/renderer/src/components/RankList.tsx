import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cover } from './Cover';
import { IconChevronRight, IconHeart, IconPlay, IconStar } from './Icons';
import { CATEGORY_MAINS } from '../types';
import type { RankItem } from '../types';

/** 数值 → "9116万"/"1.2亿" 文案 */
function fmtMetric(v?: number): string {
  if (v === undefined) return '-';
  if (v >= 10000) return `${(v / 10000).toFixed(v % 10000 === 0 ? 0 : 1)}亿`;
  return `${Math.round(v)}万`;
}

/** 标签文案 → 分类页 key（仅主分类可跳转） */
function categoryPathOf(tag: string): string | null {
  return CATEGORY_MAINS.find((c) => c.label === tag)?.key ?? null;
}

/** tag 配色档位数（与 .rk-tag.c0-.c5 对应，详情页 dt-tag 同套色板） */
const TAG_COLORS = 6;

/**
 * tag 稳定配色：同名标签永远同色。
 * @param tag 标签文案
 * @returns 配色档位下标 0..5
 */
function tagColorIndex(tag: string): number {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return h % TAG_COLORS;
}

/** 单条榜单行（简介展开态独立管理） */
function RankRow({ item }: { item: RankItem }) {
  const navigate = useNavigate();
  const rank = item.rank ?? 0;
  const top = rank > 0 && rank <= 3;
  const [descOpen, setDescOpen] = useState(false);

  return (
    <div className={`rk-item${top ? ' top' : ''}`} onClick={() => navigate(`/drama/${item.id}`)}>
      {/* 排名徽章：前三名金银铜；搜索结果无排名时不渲染 */}
      {rank > 0 ? (
        <span className={`rk-badge${rank === 1 ? ' gold' : rank === 2 ? ' silver' : rank === 3 ? ' bronze' : ''}`}>
          {rank}
        </span>
      ) : null}

      <div className="rk-cover">
        <Cover src={item.coverUrl} alt={item.title} />
        <span className="rk-play">
          <IconPlay size={22} />
        </span>
        {item.episodeCount ? <span className="rk-eps">{item.episodeCount} 集</span> : null}
      </div>

      <div className="rk-body">
        <div className="rk-title-row">
          <h3 className="rk-title">{item.title}</h3>
          {item.scoreValue !== undefined ? (
            <span className="rk-score">
              <IconStar size={13} />
              {item.scoreValue.toFixed(1)}
            </span>
          ) : null}
        </div>

        {item.categories?.length ? (
          <div className="rk-tags">
            {item.categories.map((t) => {
              const path = categoryPathOf(t);
              return (
                <span
                  key={t}
                  className={`rk-tag c${tagColorIndex(t)}`}
                  onClick={(e) => {
                    if (!path) return;
                    e.stopPropagation();
                    navigate(`/category/${path}`);
                  }}
                >
                  {t}
                </span>
              );
            })}
          </div>
        ) : null}

        {item.description ? (
          <>
            <p className={`rk-desc${descOpen ? ' open' : ''}`} onClick={() => setDescOpen(!descOpen)}>
              {item.description}
            </p>
            {/* 展开按钮放在截断区外：截断会隐藏内部元素，按钮在外才能始终可点 */}
            <button className="rk-desc-toggle" onClick={() => setDescOpen(!descOpen)}>
              {descOpen ? '收起' : '展开'}
              <IconChevronRight size={12} className={descOpen ? 'up' : ''} />
            </button>
          </>
        ) : null}

        {item.favoriteValue !== undefined ? (
          <div className="rk-metrics">
            <span className="rk-metric fav">
              <IconHeart size={13} />
              {fmtMetric(item.favoriteValue)}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 榜单行式列表：排名徽章 + 封面 + 标题/评分/标签/简介（前三名高亮）。
 * @param props.items 榜单条目
 */
export function RankList({ items }: { items: RankItem[] }) {
  return (
    <div className="rank-list">
      {items.map((item) => (
        <RankRow key={item.id} item={item} />
      ))}
    </div>
  );
}
