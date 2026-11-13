import { Link } from 'react-router-dom';
import type { DramaCard } from '../types';
import { Cover } from './Cover';
import { IconHeart } from './Icons';

interface DramaCardViewProps {
  drama: DramaCard;
  /** 收藏标记 */
  favMark?: boolean;
  /** 禁用态（如详情页分季模块中的"当前季"）：置灰展示、不可点击跳转 */
  disabled?: boolean;
}

/** "第X季"匹配（标题或标签内） */
const SEASON_RE = /第\s*[0-9一二两三四五六七八九十百]+\s*季/;

/**
 * 判断标签是否为"第X季"类季标签。
 * @param tag 标签文案
 * @returns 是季标签返回 true
 */
function isSeasonTag(tag: string): boolean {
  return SEASON_RE.test(tag);
}

/**
 * 从标题/标签中提取"第X季"文案。
 * @param title 剧名
 * @param tags 标签列表
 * @returns 如 "第二季"；无季信息返回 null
 */
function seasonOf(title: string, tags: string[]): string | null {
  for (const t of tags) {
    const m = SEASON_RE.exec(t);
    if (m) return m[0];
  }
  const m = SEASON_RE.exec(title);
  return m ? m[0] : null;
}

/** 分类 tag 配色档位数（与 .card-cat.c0-.c5 对应） */
const CAT_COLORS = 6;

/**
 * 分类 tag 稳定配色：同名分类永远同色。
 * @param tag 分类文案
 * @returns 配色档位下标 0..5
 */
function catColorIndex(tag: string): number {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return h % CAT_COLORS;
}

/**
 * 海报卡片：hover 上浮 + 辉光描边（视觉规范 §3.4）。
 * 封面角标布局：第几季（左上）/ 分类彩色 tag（右上）/ 运营角标（左下）/ 集数（右下）；
 * 封面下方只显示剧名（两行，超出省略）。
 */
export function DramaCardView({ drama, favMark, disabled }: DramaCardViewProps) {
  const season = seasonOf(drama.title, drama.tags);
  // 分类 tag 跳过"第X季"类季标签，避免与左上季角标重复显示
  const category = drama.tags.find((t) => !isSeasonTag(t));
  const body = (
    <>
      <div className="cover">
        <Cover src={drama.coverUrl} alt={drama.title} />
        {season ? <span className="badge season">{season}</span> : null}
        {category ? <span className={`card-cat c${catColorIndex(category)}`}>{category}</span> : null}
        {favMark ? (
          <span className="fav-mark">
            <IconHeart size={14} filled color="#ff4d6d" />
          </span>
        ) : null}
        {drama.recText ? <span className="badge rec">{drama.recText}</span> : null}
        {drama.totalEpisodes ? <span className="badge eps">共 {drama.totalEpisodes} 集</span> : null}
      </div>
      <div className="t">{drama.title}</div>
    </>
  );
  // 禁用态：结构与普通卡片一致但渲染为 div（无跳转），置灰样式见 .card.disabled
  if (disabled) {
    return (
      <div className="card disabled" title="当前观看的这一季">
        {body}
      </div>
    );
  }
  return (
    <Link className="card" to={`/drama/${drama.id}`}>
      {body}
    </Link>
  );
}
