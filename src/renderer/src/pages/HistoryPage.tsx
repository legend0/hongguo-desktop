import { useNavigate } from 'react-router-dom';
import { useHistory } from '../stores';
import { Cover } from '../components/Cover';
import { EmptyState } from '../components/Feedback';
import { IconClock, IconPlay, IconTrash } from '../components/Icons';
import { toast } from '../components/Toast';

/** 播放历史：本地持久化列表（M4 播放后自动写入） */
export function HistoryPage() {
  const history = useHistory();
  const navigate = useNavigate();

  if (history.entries.length === 0) {
    return (
      <EmptyState icon={<IconClock size={40} />} text="暂无播放记录" sub="开始播放后，这里会记录你的观看进度" >
        <button className="btn primary" onClick={() => navigate('/')}>
          去首页逛逛
        </button>
      </EmptyState>
    );
  }

  const fmt = (ts: number) => {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  return (
    <div className="page page-pad">
      <div className="section-head">
        <h2>播放历史</h2>
        <button
          className="btn danger"
          onClick={() => {
            if (confirm('确定清空全部播放历史？')) {
              history.clear();
              toast('已清空播放历史');
            }
          }}
        >
          清空历史
        </button>
      </div>
      <div className="history-list">
        {history.entries.map((e, i) => {
          const progress =
            e.totalEpisodes && e.totalEpisodes > 0
              ? Math.min(100, Math.round((e.episodeIndex / e.totalEpisodes) * 100))
              : undefined;
          return (
            <div key={e.dramaId} className="history-item" style={{ animationDelay: `${i * 0.05}s` }}
              onClick={() => navigate(`/drama/${e.dramaId}`)}>
              <Cover src={e.coverUrl} alt={e.title} className="history-thumb" />
              <span className="history-hover-play">
                <IconPlay size={20} />
              </span>
              <div className="history-info">
                <div className="t">{e.title}</div>
                <div className="s">
                  看到第 {e.episodeIndex} 集
                  {e.totalEpisodes ? <i> / 共 {e.totalEpisodes} 集</i> : null}
                </div>
                {progress !== undefined ? (
                  <div className="history-bar">
                    <i style={{ width: `${progress}%` }} />
                  </div>
                ) : null}
              </div>
              <div className="history-side">
                <div className="history-time">{fmt(e.updatedAt)}</div>
                <button
                  className="history-del"
                  title="删除该记录"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    history.remove(e.dramaId);
                    toast('已删除该记录');
                  }}
                >
                  <IconTrash size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
