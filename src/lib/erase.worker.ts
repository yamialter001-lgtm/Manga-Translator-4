/// Web Worker: ตรวจตัวอักษร + เติมพื้นหลัง (งานหนักที่เคยทำให้จอค้าง) แยกจาก main thread
import { detectText, fillMasked, type Img, type Rect } from './erase-core';

export type EraseRequest =
  | { id: number; kind: 'rect'; w: number; h: number; buf: ArrayBuffer; inner: Rect; T: number; grow: number }
  | { id: number; kind: 'mask'; w: number; h: number; buf: ArrayBuffer; mask: ArrayBuffer };

export interface EraseReply {
  id: number;
  buf: ArrayBuffer;
  changed: boolean;
  error?: string;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<EraseRequest>) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const m = e.data;
  const img: Img = { width: m.w, height: m.h, data: new Uint8ClampedArray(m.buf) };
  try {
    let changed = true;
    if (m.kind === 'rect') {
      const res = detectText(img, m.inner, m.T, m.grow);
      if (res.count) fillMasked(img, res.mask);
      else changed = false;
    } else {
      fillMasked(img, new Uint8Array(m.mask));
    }
    const reply: EraseReply = { id: m.id, buf: img.data.buffer as ArrayBuffer, changed };
    ctx.postMessage(reply, [reply.buf]);
  } catch (err) {
    const reply: EraseReply = { id: m.id, buf: img.data.buffer as ArrayBuffer, changed: false, error: String(err) };
    ctx.postMessage(reply, [reply.buf]);
  }
};
