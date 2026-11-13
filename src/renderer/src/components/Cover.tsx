import { useState } from 'react';

interface CoverProps {
  src: string;
  alt: string;
  className?: string;
}

/** 海报封面：shimmer 占位 + 加载淡入 + 失败回退首字 */
export function Cover({ src, alt, className }: CoverProps) {
  const [state, setState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const valid = !!src;

  return (
    <div className={`cover-img${className ? ` ${className}` : ''}${state !== 'loaded' ? ' shimmer' : ''}`}>
      {valid && state !== 'error' ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          /* 字节系图床（byteimg/fqnovelpic）会拒绝带 Referer 的请求，必须匿名引用 */
          referrerPolicy="no-referrer"
          className={state === 'loaded' ? 'loaded' : undefined}
          onLoad={() => setState('loaded')}
          onError={() => setState('error')}
          draggable={false}
        />
      ) : (
        <div className="fallback">{alt.slice(0, 1)}</div>
      )}
    </div>
  );
}
