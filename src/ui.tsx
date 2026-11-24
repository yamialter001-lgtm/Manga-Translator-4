import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { clamp } from './lib/util';
import { useBackHandler } from './nav';

/* ---------------- ไอคอน ---------------- */
const P: Record<string, ReactNode> = {
  back: <path d="M15 18l-6-6 6-6" />,
  next: <path d="M9 18l6-6-6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M18 6L6 18M6 6l12 12" />,
  check: <path d="M20 6L9 17l-5-5" />,
  trash: <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />,
  undo: <path d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3" />,
  redo: <path d="M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3" />,
  eye: (<><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>),
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  download: <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />,
  search: (<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>),
  more: (<><circle cx="12" cy="5" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="12" cy="19" r="1.2" /></>),
  translate: <path d="M5 8h8M9 4v4M7 8c0 4 3 7 6 8M11 8c0 3-2 6-6 8M13 20l4-9 4 9M14.5 17h5" />,
  image: (<><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></>),
  file: <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5" />,
  sliders: (<><path d="M4 6h8M16 6h4M4 12h2M10 12h10M4 18h10M18 18h2" /><circle cx="14" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="16" cy="18" r="2" /></>),
  book: <path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2zM4 19a2 2 0 002 2h13" />,
  zoom: (<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3M11 8v6M8 11h6" /></>),
  box: <rect x="4" y="5" width="16" height="14" rx="2" strokeDasharray="3 3" />,
  pen: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />,
  chevUp: <path d="M6 15l6-6 6 6" />,
  chevDown: <path d="M6 9l6 6 6-6" />,
  spark: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />,
};

export function Icon({ n, size = 22 }: { n: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[n]}
    </svg>
  );
}

/* ---------------- Toast ---------------- */
interface T {
  id: number;
  msg: string;
  kind: 'info' | 'error';
}
let toasts: T[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function toast(msg: string, kind: 'info' | 'error' = 'info') {
  const t: T = { id: Date.now() + Math.random(), msg, kind };
  toasts = [...toasts, t];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((x) => x !== t);
    emit();
  }, kind === 'error' ? 7000 : 3000);
}

export function ToastHost() {
  const list = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => toasts,
  );
  return (
    <div className="toast-host">
      {list.map((t) => (
        <div key={t.id} className={'toast ' + t.kind}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}

/* ---------------- Modal / Sheet ---------------- */
export function Modal({ title, onClose, children, full }: { title: string; onClose: () => void; children: ReactNode; full?: boolean }) {
  // ปุ่มย้อนกลับของโทรศัพท์ = ปิดหน้าต่างนี้ (หน้าต่างที่เปิดทีหลังอยู่บนสุดจึงถูกปิดก่อน)
  useBackHandler(() => {
    onClose();
    return true;
  });
  return (
    <div className="scrim" onClick={onClose}>
      <div className={'modal' + (full ? ' full' : '')} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="iconbtn" onClick={onClose} aria-label="ปิด">
            <Icon n="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/* ---------------- ฟอร์ม ---------------- */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="lbl">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <span>
        <span className="lbl">{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <i className="sw" />
    </label>
  );
}

export function Num({ value, onChange, min, max, step = 1 }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number }) {
  const [t, setT] = useState(String(value));
  useEffect(() => {
    if (parseFloat(t) !== value) setT(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      type="number"
      inputMode="decimal"
      value={t}
      step={step}
      onChange={(e) => {
        setT(e.target.value);
        const n = parseFloat(e.target.value);
        if (Number.isFinite(n)) onChange(clamp(n, min, max));
      }}
    />
  );
}

export function Range({ label, value, min, max, step, onChange, show }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; show?: (v: number) => string }) {
  return (
    <label className="field">
      <span className="lbl">
        {label}: <b>{show ? show(value) : value}</b>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </label>
  );
}

export function BlobImg({ blob, className, alt = '' }: { blob?: Blob; className?: string; alt?: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!blob) return setUrl('');
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url ? <img src={url} className={className} alt={alt} /> : <div className={className} />;
}
