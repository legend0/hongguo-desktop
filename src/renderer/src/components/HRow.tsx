import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { IconChevronLeft, IconChevronRight } from './Icons';

interface HRowProps {
  children: ReactNode;
  /** 依赖变化（如条目数量）后重新测量边缘状态 */
  dep?: unknown;
}

/** 超过该位移才判定为拖拽（否则视为点击，不进入拖拽态） */
const DRAG_THRESHOLD = 5;
/** 拖拽结束后的一小段时间内忽略起点卡片的 click，避免"松手即跳转" */
const CLICK_SUPPRESS_MS = 200;

/**
 * 横向滚动轨道：
 * - 鼠标按住左右拖拽；只有位移超过阈值才进入拖拽态，点击卡片不会被吞掉
 * - 边缘用 mask 做真实的渐变透明（内容淡出，不遮挡背景），
 *   该方向还有内容时才渲染对应边缘控件
 * - 隐藏横向滚动条
 */
export function HRow({ children, dep }: HRowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [canL, setCanL] = useState(false);
  const [canR, setCanR] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    startLeft: 0,
    /** 按下时命中的卡片，拖拽结束后只吞掉它的误点击 */
    startCard: null as HTMLElement | null,
  });
  /** 拖拽刚结束时的时间戳，用于吞掉紧随其后的 click */
  const suppressUntil = useRef(0);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // 容差取 2px：吸附/子像素可能让起始位置落在 1~2px 而非精确 0
    setCanL(el.scrollLeft > 2);
    setCanR(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    const onScroll = () => measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // 图片懒加载后内容宽度会变，ResizeObserver 监听行本身收不到，
    // 这里监听行内元素尺寸变化，保证边缘控件状态跟着更新
    const items = [...el.querySelectorAll('.hrow-item, .hcard, .card')];
    items.forEach((it) => ro.observe(it));
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [measure, dep]);

  // 拖拽全程监听 window：鼠标移出轨道后仍能继续拖动并正确收尾
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = drag.current;
      if (!d.active) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved) {
        if (Math.abs(dx) < DRAG_THRESHOLD) return;
        // 纵向位移更大时视为页面滚动，不抢手势
        if (Math.abs(dx) <= Math.abs(dy)) {
          d.active = false;
          return;
        }
        d.moved = true;
        setDragging(true);
        // 必须同步关闭吸附：CSS 类 .dragging 要等 React 下一次渲染才生效，
        // 浏览器会在那之前把 scrollLeft 重新吸回去，导致拖拽"拽不动"。
        // 这里直接写内联样式，绕开渲染延迟。
        const el0 = ref.current;
        if (el0) el0.style.scrollSnapType = 'none';
      }
      const el = ref.current;
      if (el) el.scrollLeft = d.startLeft - dx;
    };
    const onUp = () => {
      const d = drag.current;
      if (!d.active && !d.moved) return;
      if (d.moved) suppressUntil.current = performance.now() + CLICK_SUPPRESS_MS;
      d.active = false;
      d.moved = false;
      setDragging(false);
      // 恢复吸附（清掉内联样式，交回 CSS .hrow 的 scroll-snap-type）。
      // 先钉住拖拽终点的 scrollLeft，再清样式，避免吸附把它拽回原位。
      const el = ref.current;
      if (el) {
        const end = el.scrollLeft;
        el.scrollLeft = end;
        el.style.scrollSnapType = '';
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
    };
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el || e.button !== 0) return;
    // 记录按下时命中的卡片：拖拽结束后只需要吞掉"这一张"的误点击，
    // 其余卡片立刻可点，避免用户拖完想点某张卡却要干等。
    const card = (e.target as HTMLElement | null)?.closest('.card, .hcard');
    drag.current = {
      active: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: el.scrollLeft,
      startCard: (card as HTMLElement | null) ?? null,
    };
  };

  // 拖拽刚结束时吞掉起点卡片的那一次 click（用时间戳，不依赖"下一次 click 来复位"）
  const onClickCapture = (e: React.MouseEvent) => {
    if (performance.now() >= suppressUntil.current) return;
    const card = (e.target as HTMLElement | null)?.closest('.card, .hcard');
    if (card && card !== drag.current.startCard) return; // 别的卡片，放行
    e.preventDefault();
    e.stopPropagation();
  };

  const nudge = (dir: -1 | 1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  const fadeCls = `${canL ? ' fade-l' : ''}${canR ? ' fade-r' : ''}`;

  return (
    <div className="hrow-wrap">
      <div
        ref={ref}
        className={`hrow${fadeCls}${dragging ? ' dragging' : ''}`}
        onMouseDown={onMouseDown}
        onClickCapture={onClickCapture}
      >
        {children}
      </div>

      {canL ? (
        <button className="hr-edge left" title="向左滚动" aria-label="向左滚动" onClick={() => nudge(-1)}>
          <IconChevronLeft size={18} />
        </button>
      ) : null}
      {canR ? (
        <button className="hr-edge right" title="向右滚动" aria-label="向右滚动" onClick={() => nudge(1)}>
          <IconChevronRight size={18} />
        </button>
      ) : null}
    </div>
  );
}
