import { detectText, fillMasked, type Img, type Rect } from './erase-core';
import type { EraseReply, EraseRequest } from './erase.worker';

/**
 * เรียกงานลบตัวอักษรใน Web Worker (ถ้าสร้าง worker ไม่ได้หรือ worker พัง จะคำนวณบน main thread แทน)
 * ส่งสำเนาข้อมูลไปให้ worker เสมอ เพื่อให้ยังมีข้อมูลเดิมไว้ใช้สำรองได้
 */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface Pending {
  resolve: (r: EraseReply) => void;
  fallback: () => EraseReply;
}

let worker: Worker | null | undefined;
let seq = 0;
const pending = new Map<number, Pending>();

function failAll() {
  worker?.terminate();
  worker = null;
  const list = [...pending.values()];
  pending.clear();
  for (const p of list) p.resolve(p.fallback());
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    const w = new Worker(new URL('./erase.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<EraseReply>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.resolve(p.fallback());
      else p.resolve(e.data);
    };
    w.onerror = () => failAll();
    w.onmessageerror = () => failAll();
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

function call(req: DistributiveOmit<EraseRequest, 'id'>, transfer: Transferable[], fallback: () => EraseReply): Promise<EraseReply> {
  const w = getWorker();
  if (!w) return Promise.resolve(fallback());
  const id = ++seq;
  return new Promise<EraseReply>((resolve) => {
    pending.set(id, { resolve, fallback });
    try {
      w.postMessage({ ...req, id }, transfer);
    } catch {
      pending.delete(id);
      resolve(fallback());
    }
  });
}

/** ตรวจตัวอักษรในกรอบแล้วเติมพื้นหลังลงใน img (แก้ img.data ตรงๆ) — คืน true ถ้ามีการเปลี่ยนภาพ */
export async function eraseWindow(img: Img, inner: Rect, T: number, grow: number): Promise<boolean> {
  const copy = img.data.slice();
  const fallback = (): EraseReply => {
    const res = detectText(img, inner, T, grow);
    if (res.count) fillMasked(img, res.mask);
    return { id: 0, buf: img.data.buffer as ArrayBuffer, changed: res.count > 0 };
  };
  const r = await call({ kind: 'rect', w: img.width, h: img.height, buf: copy.buffer as ArrayBuffer, inner, T, grow }, [copy.buffer as ArrayBuffer], fallback);
  if (r.changed && r.buf !== img.data.buffer) img.data.set(new Uint8ClampedArray(r.buf));
  return r.changed;
}

/** เติมพื้นหลังเฉพาะพิกเซลใน mask ลงใน img (แก้ img.data ตรงๆ) */
export async function fillWindow(img: Img, mask: Uint8Array): Promise<void> {
  const copy = img.data.slice();
  const mcopy = mask.slice();
  const fallback = (): EraseReply => {
    fillMasked(img, mask);
    return { id: 0, buf: img.data.buffer as ArrayBuffer, changed: true };
  };
  const r = await call(
    { kind: 'mask', w: img.width, h: img.height, buf: copy.buffer as ArrayBuffer, mask: mcopy.buffer as ArrayBuffer },
    [copy.buffer as ArrayBuffer, mcopy.buffer as ArrayBuffer],
    fallback,
  );
  if (r.changed && r.buf !== img.data.buffer) img.data.set(new Uint8ClampedArray(r.buf));
}
