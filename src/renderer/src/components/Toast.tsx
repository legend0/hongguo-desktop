import { useEffect, useState } from 'react';

let counter = 0;
const EVT = 'hongguo:toast';

/** 全局轻提示：toast('内容') */
export function toast(message: string): void {
  window.dispatchEvent(new CustomEvent(EVT, { detail: { id: ++counter, message } }));
}

export function ToastHost() {
  const [items, setItems] = useState<{ id: number; message: string }[]>([]);

  useEffect(() => {
    const onToast = (e: Event): void => {
      const { id, message } = (e as CustomEvent).detail as { id: number; message: string };
      setItems((s) => [...s, { id, message }]);
      setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), 2400);
    };
    window.addEventListener(EVT, onToast);
    return () => window.removeEventListener(EVT, onToast);
  }, []);

  return (
    <>
      {items.map((it) => (
        <div key={it.id} className="toast">
          {it.message}
        </div>
      ))}
    </>
  );
}
