import { useNavigate } from 'react-router-dom';
import type { DramaCard, RankItem } from '../types';
import { Cover } from './Cover';
import { toast } from './Toast';
import { IconPlay } from './Icons';

interface MediaListProps {
  items: (DramaCard | RankItem)[];
  /** 显示序号（榜单排名 / 搜索序号） */
  numbered?: boolean;
  /** 前三名使用品牌渐变序号（仅榜单） */
  topRankStyle?: boolean;
}

/**
 * 榜单式媒体列表（榜单页 / 搜索结果页共用，参照站点 UI）：
 * 封面 + 标题 + 元信息（集数 / 热度 / 评分 / 分类），整行可点进详情。
 */
export function MediaList({ items, numbered, topRankStyle }: MediaListProps) {
  const navigate = useNavigate();

  const open = (item: DramaCard) => {
    if (item.kind === 'comic') {
      toast('漫画为图文内容，暂不支持播放');
      return;
    }
    navigate(`/drama/${item.id}`);
  };

  return (
    <div className="media-list">
      {items.map((item, i) => {
        const rank = (item as RankItem).rank;
        const heat = (item as RankItem).heatText;
        const score = (item as RankItem).score;
        const num = numbered ? (rank ?? i + 1) : i + 1;
        const hot = topRankStyle && num <= 3;
        return (
          <div
            key={item.id}
            className="ml-row"
            style={{ animationDelay: `${Math.min(i * 0.03, 0.4)}s` }}
            onClick={() => open(item)}
          >
            {numbered ? (
              <span className={`ml-num${hot ? ' hot' : ''}`}>{num}</span>
            ) : (
              <span className="ml-idx">{i + 1}</span>
            )}
            <div className="ml-cover">
              <Cover src={item.coverUrl} alt={item.title} />
              <span className="ml-play">
                <IconPlay size={18} />
              </span>
            </div>
            <div className="ml-info">
              <div className="ml-title">{item.title}</div>
              <div className="ml-meta">
                {item.totalEpisodes ? <span>共 {item.totalEpisodes} 集</span> : null}
                {heat ? <span className="hl">{heat}</span> : null}
                {score ? <span className="hl">评分 {score}</span> : null}
                {item.tags.slice(0, 3).map((t) => (
                  <span key={t} className="ml-tag">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
