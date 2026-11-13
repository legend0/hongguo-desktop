import { useNavigate } from 'react-router-dom';
import { useFavorites } from '../stores';
import { DramaCardView } from '../components/DramaCard';
import { EmptyState } from '../components/Feedback';
import { IconHeart } from '../components/Icons';

/** 我的收藏：本地持久化网格 */
export function FavoritesPage() {
  const favorites = useFavorites();
  const navigate = useNavigate();
  const list = Object.values(favorites.items);

  if (list.length === 0) {
    return (
      <EmptyState
        icon={<IconHeart size={40} />}
        text="还没有收藏，去首页看看吧"
        sub="在短剧详情页点击「收藏」即可添加"
      >
        <button className="btn primary" onClick={() => navigate('/')}>
          去首页逛逛
        </button>
      </EmptyState>
    );
  }

  return (
    <div className="page page-pad">
      <div className="section-head">
        <h2>我的收藏</h2>
        <button className="btn danger" onClick={() => favorites.clear()}>
          清空收藏
        </button>
      </div>
      <div className="grid">
        {list.map((d) => (
          <DramaCardView key={d.id} drama={d} favMark />
        ))}
      </div>
    </div>
  );
}
