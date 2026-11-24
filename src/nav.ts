import { useEffect, useRef } from 'react';

export const go = (path: string) => {
  location.hash = path;
};
export const replace = (path: string) => {
  location.replace('#' + path);
};
export const back = () => history.back();

/** หน้าแม่ของ route ปัจจุบัน (null = หน้าแรก) */
export function parentPath(hash = location.hash): string | null {
  const p = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (p[0] === 'p' && p[1] && p[2] === 'e' && p[3]) return `/p/${p[1]}`;
  if (p[0] === 'p' || p[0] === 'settings') return '/';
  return null;
}

/** ย้อนขึ้นหน้าแม่ (ตัวแก้ไข → โปรเจกต์ → หน้าแรก) — คืน false ถ้าอยู่หน้าแรกอยู่แล้ว */
export function goUp(): boolean {
  const up = parentPath();
  if (up === null) return false;
  replace(up);
  return true;
}

/* ---------- ปุ่มย้อนกลับของโทรศัพท์ ---------- */
type BackHandler = () => boolean;
const handlers: BackHandler[] = [];

/** เรียกตัวจัดการจากตัวที่ลงทะเบียนล่าสุด (อยู่บนสุด) ก่อน — คืน true เมื่อมีตัวใดจัดการแล้ว */
export function runBackHandlers(): boolean {
  for (let i = handlers.length - 1; i >= 0; i--) if (handlers[i]()) return true;
  return false;
}

/**
 * ลงทะเบียนตัวจัดการปุ่มย้อนกลับ (คืน true = จัดการแล้ว ไม่ต้องย้อนหน้า)
 * ตัวที่ติดตั้งทีหลังจะถูกเรียกก่อน (เช่น หน้าต่างป๊อปอัปอยู่เหนือหน้าจอ)
 */
export function useBackHandler(fn: BackHandler) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h: BackHandler = () => ref.current();
    handlers.push(h);
    return () => {
      const i = handlers.lastIndexOf(h);
      if (i >= 0) handlers.splice(i, 1);
    };
  }, []);
}
