import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

/** 图标基座：线性风格，继承 currentColor，视觉规范 §2 图标网格 */
function Base({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconHome = (p: IconProps) => (
  <Base {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V21h5v-6h4v6h5V9.5" />
  </Base>
);

export const IconGrid = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
  </Base>
);

export const IconChart = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 20V10" />
    <path d="M10 20V4" />
    <path d="M16 20v-7" />
    <path d="M22 20H2" />
  </Base>
);

export const IconSearch = (p: IconProps) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Base>
);

export const IconHeart = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Base {...p} fill={filled ? 'currentColor' : 'none'}>
    <path d="M12 20.5s-7.5-4.6-9.3-9.2C1.5 8.2 3.4 5 6.7 5c2 0 3.7 1.1 4.6 2.7l.7 1.2.7-1.2C13.6 6.1 15.3 5 17.3 5c3.3 0 5.2 3.2 4 6.3-1.8 4.6-9.3 9.2-9.3 9.2Z" />
  </Base>
);

export const IconClock = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </Base>
);

export const IconGear = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 13.5a7.8 7.8 0 0 0 0-3l2-1.5-2-3.5-2.4 1a7.8 7.8 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.8 7.8 0 0 0 7 6.5l-2.4-1-2 3.5 2 1.5a7.8 7.8 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a7.8 7.8 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.8 7.8 0 0 0 2.6-1.5l2.4 1 2-3.5-2-1.5Z" />
  </Base>
);

export const IconPlay = (p: IconProps) => (
  <Base {...p} fill="currentColor" stroke="none">
    <path d="M8 5.5v13l11-6.5-11-6.5Z" />
  </Base>
);

export const IconChevronRight = (p: IconProps) => (
  <Base {...p}>
    <path d="m9 5 7 7-7 7" />
  </Base>
);

export const IconChevronLeft = (p: IconProps) => (
  <Base {...p}>
    <path d="m15 5-7 7 7 7" />
  </Base>
);

/** 向下箭头（展开/收起指示；up 时旋转 180°） */
export const IconChevronDown = ({ up, ...p }: IconProps & { up?: boolean }) => (
  <Base {...p} style={up ? { transform: 'rotate(180deg)' } : undefined}>
    <path d="m5 9 7 7 7-7" />
  </Base>
);

export const IconBell = (p: IconProps) => (
  <Base {...p}>
    <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
    <path d="M10 19a2 2 0 0 0 4 0" />
  </Base>
);

export const IconTrash = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 7h16" />
    <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    <path d="M6.5 7 7.4 20a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9L17.5 7" />
    <path d="M10 11v6M14 11v6" />
  </Base>
);

export const IconFilm = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2.5" />
    <path d="M7 3v18M17 3v18M3 8.5h4M3 15.5h4M17 8.5h4M17 15.5h4" />
  </Base>
);

export const IconStar = (p: IconProps) => (
  <Base {...p}>
    <path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8L12 3.5Z" />
  </Base>
);

/** 热度（火焰） */
export const IconFire = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3c.6 3.2-1.4 4.6-2.8 6.2-1.3 1.5-1.9 2.9-1.9 4.3a4.7 4.7 0 0 0 9.4 0c0-1.6-.7-2.9-1.6-4-.4 1-1.2 1.6-2 1.6.9-2.6.3-5.7-1.1-8.1Z" />
  </Base>
);

export const IconWarning = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3.5 22 20H2L12 3.5Z" />
    <path d="M12 10v4.5" />
    <path d="M12 17.5v.1" />
  </Base>
);

export const IconMinimize = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 12h14" />
  </Base>
);

export const IconMaximize = (p: IconProps) => (
  <Base {...p}>
    <rect x="5" y="5" width="14" height="14" rx="1.5" />
  </Base>
);

export const IconRestore = (p: IconProps) => (
  <Base {...p}>
    <path d="M8 8V5.5A1.5 1.5 0 0 1 9.5 4H18a2 2 0 0 1 2 2v8.5a1.5 1.5 0 0 1-1.5 1.5H16" />
    <rect x="4" y="8" width="12" height="12" rx="1.5" />
  </Base>
);

export const IconClose = (p: IconProps) => (
  <Base {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Base>
);

export const IconTv = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="7" width="18" height="13" rx="2" />
    <path d="m8 2 4 5 4-5" />
  </Base>
);

export const IconPalette = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 21a9 9 0 1 1 9-9c0 2.5-1.5 3.5-3 3.5h-2a2 2 0 0 0-1.5 3.3c.4.5.5 1.3 0 1.7-.6.4-1.6.5-2.5.5Z" />
    <circle cx="7.5" cy="11.5" r="1" />
    <circle cx="11" cy="7.5" r="1" />
    <circle cx="15.8" cy="9" r="1" />
  </Base>
);

export const IconSparkles = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
    <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z" />
  </Base>
);

export const IconBook = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
  </Base>
);

/* ===== 播放器专用 ===== */

export const IconPause = (p: IconProps) => (
  <Base {...p}>
    <rect x="6" y="4" width="4" height="16" rx="1" />
    <rect x="14" y="4" width="4" height="16" rx="1" />
  </Base>
);

export const IconNextEp = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 5v14l10-7L5 5Z" />
    <path d="M19 5v14" />
  </Base>
);

export const IconPrevEp = (p: IconProps) => (
  <Base {...p}>
    <path d="M19 5v14L9 12l10-7Z" />
    <path d="M5 5v14" />
  </Base>
);

export const IconVolume = ({ muted, ...p }: IconProps & { muted?: boolean }) => (
  <Base {...p}>
    <path d="M4 9v6h4l5 4V5L8 9H4Z" />
    {muted ? (
      <path d="m17 9 4 6M21 9l-4 6" />
    ) : (
      <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
    )}
  </Base>
);

export const IconFullscreen = ({ on, ...p }: IconProps & { on?: boolean }) =>
  on ? (
    <Base {...p}>
      <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" />
    </Base>
  ) : (
    <Base {...p}>
      <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />
    </Base>
  );

/** 选集列表：横线 + 播放三角（播放器控制栏"选集"按钮） */
export const IconEpList = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 6h10M4 12h10M4 18h10" />
    <path d="M17 9.5v5l4-2.5-4-2.5Z" fill="currentColor" stroke="none" />
  </Base>
);
