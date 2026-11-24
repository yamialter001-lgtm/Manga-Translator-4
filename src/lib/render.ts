import type { Box, Page, Region, RegionStyle, Stroke } from '../types';
import type { Settings } from './settings';
import { eraseWindow, fillWindow } from './erase-client';
import { detectText, type Key, type Rect } from './erase-core';
import { ensureFont, fontStack } from './fonts';

export type { Key, Rect, TextMask } from './erase-core';
export { detectText, fillMasked } from './erase-core';

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export const toRect = (b: Box, W: number, H: number): Rect => ({
  x0: (b[1] / 1000) * W,
  y0: (b[0] / 1000) * H,
  x1: (b[3] / 1000) * W,
  y1: (b[2] / 1000) * H,
});

export function resolveStyle(r: Region, s: Settings): RegionStyle {
  const kindStroke = r.kind === 'sfx' || r.kind === 'sign' ? 10 : 0;
  const base: RegionStyle = {
    font: s.font,
    sizePct: 0,
    color: s.textColor,
    stroke: s.strokeColor,
    strokePct: s.disableStroke ? 0 : s.strokePct > 0 ? s.strokePct : kindStroke,
    bold: false,
    align: s.align,
    lineHeight: s.lineHeight,
  };
  return { ...base, ...r.style };
}

/* ================================================================== */
/* ลบข้อความ: ตรวจตัวอักษร/เติมพื้นหลัง คำนวณใน Web Worker (ดู erase-core.ts)  */
/* ================================================================== */

/** ลบข้อความในกรอบ: auto = ตรวจ mask ตัวอักษรแล้วเติมเฉพาะพิกเซลนั้น, สี = เทสีทั้งกรอบ, none = ไม่ลบ */
async function eraseRect(ctx: CanvasRenderingContext2D, W: number, H: number, r: Rect, fill: string, s: Settings) {
  if (fill === 'none') return;
  const x0 = Math.max(0, Math.floor(r.x0));
  const y0 = Math.max(0, Math.floor(r.y0));
  const x1 = Math.min(W, Math.ceil(r.x1));
  const y1 = Math.min(H, Math.ceil(r.y1));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 2 || h < 2) return;
  if (fill !== 'auto') {
    ctx.fillStyle = fill;
    ctx.fillRect(x0, y0, w, h);
    return;
  }
  const ring = clamp(Math.round(Math.min(w, h) * 0.5), 10, 60);
  const wx0 = Math.max(0, x0 - ring);
  const wy0 = Math.max(0, y0 - ring);
  const wx1 = Math.min(W, x1 + ring);
  const wy1 = Math.min(H, y1 + ring);
  const img = ctx.getImageData(wx0, wy0, wx1 - wx0, wy1 - wy0);
  const changed = await eraseWindow(img, { x0: x0 - wx0, y0: y0 - wy0, x1: x1 - wx0, y1: y1 - wy0 }, s.maskThreshold, s.eraseGrow);
  if (changed) ctx.putImageData(img, wx0, wy0);
}

/** แปรงลบที่ผู้ใช้ระบายเอง */
async function eraseStroke(ctx: CanvasRenderingContext2D, W: number, H: number, st: Stroke) {
  if (st.pts.length < 2) return;
  const size = Math.max(3, (st.size / 1000) * W);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < st.pts.length; i += 2) {
    const x = (st.pts[i] / 1000) * W;
    const y = (st.pts[i + 1] / 1000) * H;
    pts.push([x, y]);
    minx = Math.min(minx, x); maxx = Math.max(maxx, x);
    miny = Math.min(miny, y); maxy = Math.max(maxy, y);
  }
  const pad = Math.ceil(size / 2 + 14);
  const wx0 = Math.max(0, Math.floor(minx - pad));
  const wy0 = Math.max(0, Math.floor(miny - pad));
  const wx1 = Math.min(W, Math.ceil(maxx + pad));
  const wy1 = Math.min(H, Math.ceil(maxy + pad));
  const ww = wx1 - wx0;
  const wh = wy1 - wy0;
  if (ww < 2 || wh < 2) return;
  const mc = document.createElement('canvas');
  mc.width = ww;
  mc.height = wh;
  const m = mc.getContext('2d', { willReadFrequently: true })!;
  m.strokeStyle = '#fff';
  m.fillStyle = '#fff';
  m.lineWidth = size;
  m.lineCap = 'round';
  m.lineJoin = 'round';
  m.beginPath();
  if (pts.length === 1) m.arc(pts[0][0] - wx0, pts[0][1] - wy0, size / 2, 0, Math.PI * 2);
  else {
    m.moveTo(pts[0][0] - wx0, pts[0][1] - wy0);
    for (const p of pts.slice(1)) m.lineTo(p[0] - wx0, p[1] - wy0);
  }
  pts.length === 1 ? m.fill() : m.stroke();
  const md = m.getImageData(0, 0, ww, wh).data;
  const mask = new Uint8Array(ww * wh);
  for (let i = 0; i < mask.length; i++) mask[i] = md[i * 4 + 3] > 70 ? 1 : 0;
  mc.width = mc.height = 0;
  const img = ctx.getImageData(wx0, wy0, ww, wh);
  await fillWindow(img, mask);
  ctx.putImageData(img, wx0, wy0);
}

/** วิเคราะห์สีตัวอักษรเดิมในกรอบ → ใช้เป็นสีข้อความไทยและเลือกสีขอบ */
export function analyzeText(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  r: Rect,
  s: Settings,
): { color: string; stroke: string; strokePct: number } | null {
  const x0 = Math.max(0, Math.floor(r.x0));
  const y0 = Math.max(0, Math.floor(r.y0));
  const x1 = Math.min(W, Math.ceil(r.x1));
  const y1 = Math.min(H, Math.ceil(r.y1));
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  const ring = clamp(Math.round(Math.min(x1 - x0, y1 - y0) * 0.5), 10, 60);
  const wx0 = Math.max(0, x0 - ring);
  const wy0 = Math.max(0, y0 - ring);
  const wx1 = Math.min(W, x1 + ring);
  const wy1 = Math.min(H, y1 + ring);
  const img = ctx.getImageData(wx0, wy0, wx1 - wx0, wy1 - wy0);
  const res = detectText(img, { x0: x0 - wx0, y0: y0 - wy0, x1: x1 - wx0, y1: y1 - wy0 }, s.maskThreshold, 0);
  if (res.count < 12 || !res.keys.length) return null;
  const sat = (k: Key) => (Math.max(k.r, k.g, k.b) - Math.min(k.r, k.g, k.b)) / 255;
  const lum = (k: Key) => (0.299 * k.r + 0.587 * k.g + 0.114 * k.b) / 255;
  const hex = (k: Key) => '#' + [k.r, k.g, k.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  let fill = res.keys[0];
  let outline: Key | null = res.keys[1] ?? null;
  // เนื้อตัวอักษรมักเป็นสีสด ส่วนขอบมักเป็นขาว/ดำ
  if (outline && sat(fill) < 0.25 && sat(outline) >= 0.35) [fill, outline] = [outline, fill];
  const stroke = outline ? hex(outline) : lum(fill) > 0.6 ? '#1b1b1b' : '#ffffff';
  return { color: hex(fill), stroke, strokePct: outline || !res.flat ? 14 : 0 };
}

/* ================================================================== */
/* จัดวางข้อความไทย                                                    */
/* ================================================================== */

const seg: { segment(s: string): Iterable<{ segment: string }> } | null = (() => {
  try {
    const S = (Intl as unknown as { Segmenter?: new (l: string, o: object) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
    return S ? new S('th', { granularity: 'word' }) : null;
  } catch {
    return null;
  }
})();

const tokens = (s: string): string[] => {
  if (seg) return Array.from(seg.segment(s), (x) => x.segment);
  return s.split(/(\s+)/).filter(Boolean);
};

const isMark = (c: string) => /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/.test(c);

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  const m = (s: string) => ctx.measureText(s).width;
  for (const para of text.split('\n')) {
    let cur = '';
    for (const t of tokens(para)) {
      if (!cur) cur = t.trimStart();
      else if (m((cur + t).trimEnd()) <= maxW) cur += t;
      else {
        out.push(cur.trimEnd());
        cur = t.trimStart();
      }
      while (cur.length > 1 && m(cur) > maxW) {
        let k = cur.length - 1;
        while (k > 1 && m(cur.slice(0, k)) > maxW) k--;
        while (k > 1 && isMark(cur[k])) k--;
        out.push(cur.slice(0, k));
        cur = cur.slice(k);
      }
    }
    out.push(cur.trimEnd());
  }
  return out;
}

function layout(ctx: CanvasRenderingContext2D, text: string, w: number, h: number, st: RegionStyle, W: number, minPx: number, maxPct: number) {
  const setFont = (s: number) => {
    ctx.font = `${st.bold ? 700 : 400} ${s}px ${fontStack(st.font)}`;
  };
  if (st.sizePct > 0) {
    const size = (st.sizePct / 100) * W;
    setFont(size);
    return { size, lines: wrapText(ctx, text, w) };
  }
  const maxPx = Math.max(minPx, (maxPct / 100) * W);
  let lo = Math.round(minPx);
  let hi = Math.round(maxPx);
  setFont(lo);
  let best = { size: lo, lines: wrapText(ctx, text, w) };
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    setFont(mid);
    const lines = wrapText(ctx, text, w);
    if (lines.length * mid * st.lineHeight <= h) {
      best = { size: mid, lines };
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

export function drawRegionText(ctx: CanvasRenderingContext2D, r: Region, W: number, H: number, s: Settings, others: Rect[] = []) {
  if (r.hidden || !r.text.trim()) return;
  const st = resolveStyle(r, s);
  const a = toRect(r.area, W, H);
  // ข้อความแนวตั้งเดิมมักได้กรอบแคบและสูง → ขยายความกว้างให้ข้อความไทย (แนวนอน) อ่านได้ โดยไม่ทับกรอบข้างเคียง
  if (r.widen && a.y1 - a.y0 > (a.x1 - a.x0) * 1.3) {
    const bw0 = a.x1 - a.x0;
    const bh0 = a.y1 - a.y0;
    const target = Math.max(bw0, Math.min(bh0 * 0.55, W * 0.13));
    const cx = (a.x0 + a.x1) / 2;
    let lo = clamp(cx - target / 2, 0, W);
    let hi = clamp(cx + target / 2, 0, W);
    for (const o of others) {
      const ov = Math.min(a.y1, o.y1) - Math.max(a.y0, o.y0);
      if (ov < Math.min(bh0, o.y1 - o.y0) * 0.2) continue;
      if ((o.x0 + o.x1) / 2 < cx) lo = Math.max(lo, Math.min(o.x1 + 4, a.x0));
      else hi = Math.min(hi, Math.max(o.x0 - 4, a.x1));
    }
    a.x0 = lo;
    a.x1 = hi;
  }
  const inset = r.kind === 'speech' || r.kind === 'thought' ? 0.11 : 0.02;
  const bw = a.x1 - a.x0;
  const bh = a.y1 - a.y0;
  const x0 = a.x0 + bw * inset;
  const y0 = a.y0 + bh * inset;
  const w = bw * (1 - 2 * inset);
  const h = bh * (1 - 2 * inset);
  if (w < 4 || h < 4) return;
  const minPx = Math.max(8, (s.minFontPct / 100) * W);
  const { size, lines } = layout(ctx, r.text, w, h, st, W, minPx, s.maxFontPct);
  const lh = size * st.lineHeight;
  const total = lines.length * lh;
  const top = y0 + (h - total) / 2;
  ctx.save();
  ctx.font = `${st.bold ? 700 : 400} ${size}px ${fontStack(st.font)}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = st.align;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  const x = st.align === 'center' ? x0 + w / 2 : st.align === 'left' ? x0 : x0 + w;
  lines.forEach((ln, i) => {
    const y = top + (i + 0.5) * lh;
    if (st.strokePct > 0) {
      ctx.lineWidth = (size * st.strokePct) / 100;
      ctx.strokeStyle = st.stroke;
      ctx.strokeText(ln, x, y);
    }
    ctx.fillStyle = st.color;
    ctx.fillText(ln, x, y);
  });
  ctx.restore();
}

/* ================================================================== */
/* ตัวเรนเดอร์หน้า: ภาพต้นฉบับ → ลบข้อความ (แคช/ต่อยอดทีละขั้น) → วางข้อความไทย */
/* ================================================================== */

interface Op {
  key: string;
  run: (ctx: CanvasRenderingContext2D) => Promise<void>;
}
interface Snap {
  keys: string[];
  bmp: ImageBitmap;
}

const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);
const isPrefix = (p: string[], full: string[]) => p.length <= full.length && p.every((k, i) => k === full[i]);

/**
 * หลักการ: การลบข้อความแต่ละกรอบ/แต่ละเส้นแปรงคือ "ขั้นตอน" (Op) ที่มี key ของตัวเอง
 *  - เก็บภาพที่ลบแล้วไว้เป็น snapshot (ImageBitmap) พร้อมรายการ key ที่ใช้
 *  - ถ้ารายการ key ใหม่ต่อจากของเดิม (เช่น เพิ่มเส้นแปรง) → ทำเฉพาะขั้นตอนที่เพิ่ม
 *  - ถ้าไม่ต่างเลย (เช่น สลับดูต้นฉบับ/คำแปล, แก้คำแปล) → ไม่ต้องลบใหม่
 *  - ย้อนกลับ 1 ขั้น (Undo เส้นแปรง) ใช้ snapshot ก่อนหน้าได้ทันที
 * งานคำนวณหนักทำใน Web Worker จึงไม่ทำให้หน้าจอค้าง
 */
export class PageRenderer {
  private canvas: HTMLCanvasElement | null = null; // ผืนงานที่ใช้ลบ (CPU, อ่านพิกเซลบ่อย)
  private canvasKeys: string[] = [];
  private snaps: Snap[] = []; // ใหม่สุดอยู่ก่อน (เก็บสูงสุด 2)
  private token = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private painted = false;
  private dead = false;

  constructor(
    public bmp: ImageBitmap,
    public W: number,
    public H: number,
  ) {}

  private buildOps(active: Region[], strokes: Stroke[], s: Settings): Op[] {
    const { W, H } = this;
    const ops: Op[] = [];
    for (const r of active) {
      if (r.fill === 'none') continue;
      const fill = r.fill;
      for (const b of r.parts && r.parts.length ? r.parts : [r.erase]) {
        ops.push({
          key: `r|${b[0]},${b[1]},${b[2]},${b[3]}|${fill}|${s.eraseGrow}|${s.maskThreshold}`,
          run: (ctx) => {
            const e = toRect(b, W, H);
            const pad = Math.round(Math.min(e.x1 - e.x0, e.y1 - e.y0) * 0.04 + 3);
            return eraseRect(ctx, W, H, { x0: e.x0 - pad, y0: e.y0 - pad, x1: e.x1 + pad, y1: e.y1 + pad }, fill, s);
          },
        });
      }
    }
    for (const st of strokes) ops.push({ key: `s|${st.size}|${st.pts.join(',')}`, run: (ctx) => eraseStroke(ctx, W, H, st) });
    return ops;
  }

  private resetCanvas(from: ImageBitmap, keys: string[]) {
    const { W, H } = this;
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(from, 0, 0, W, H);
    this.canvasKeys = keys.slice();
  }

  /** ทำให้ภาพที่ลบแล้วตรงกับ ops — คืนภาพฐานสำหรับวางข้อความ หรือ null ถ้ามีคำสั่งใหม่แทรกเข้ามา */
  private async sync(ops: Op[], want: string[], my: number): Promise<ImageBitmap | null> {
    if (!want.length) return this.bmp;
    const hit = this.snaps.find((s) => sameKeys(s.keys, want));
    if (hit) return hit.bmp;

    // เลือกจุดเริ่มที่ยาวที่สุดที่ยังต่อยอดได้
    let startLen = 0;
    let from: Snap | 'canvas' | null = null;
    if (this.canvas && isPrefix(this.canvasKeys, want)) {
      startLen = this.canvasKeys.length;
      from = 'canvas';
    }
    for (const sn of this.snaps) {
      if (isPrefix(sn.keys, want) && sn.keys.length > startLen) {
        startLen = sn.keys.length;
        from = sn;
      }
    }
    if (from === 'canvas') {
      /* ใช้ผืนงานเดิมต่อ */
    } else if (from) this.resetCanvas(from.bmp, from.keys);
    else this.resetCanvas(this.bmp, []);

    const ctx = this.canvas!.getContext('2d', { willReadFrequently: true })!;
    for (let i = this.canvasKeys.length; i < ops.length; i++) {
      if (this.dead || my !== this.token) return null;
      await ops[i].run(ctx);
      this.canvasKeys.push(ops[i].key);
    }
    if (this.dead || my !== this.token) return null;
    const bmp = await createImageBitmap(this.canvas!);
    if (this.dead) {
      bmp.close();
      return null;
    }
    this.snaps.unshift({ keys: want.slice(), bmp });
    this.pruneSnaps();
    return bmp;
  }

  /** วาดลง target — คืน true เมื่อเสร็จและเป็นคำสั่งล่าสุด, false ถ้าถูกแทนที่/ผิดพลาด */
  render(target: HTMLCanvasElement, regions: Region[], brush: Stroke[], s: Settings, showText: boolean): Promise<boolean> {
    const my = ++this.token;
    const p = this.chain.then(() => this.run(my, target, regions, brush, s, showText));
    const safe = p.catch((e) => {
      console.error('render failed', e);
      return false;
    });
    this.chain = safe;
    return safe;
  }

  private async run(my: number, target: HTMLCanvasElement, regions: Region[], brush: Stroke[], s: Settings, showText: boolean): Promise<boolean> {
    if (this.dead || my !== this.token) return false;
    const { W, H } = this;
    if (target.width !== W || target.height !== H) {
      target.width = W;
      target.height = H;
      this.painted = false;
    }
    const ctx = target.getContext('2d')!;
    const paint = (src: ImageBitmap) => {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(src, 0, 0, W, H);
    };
    if (!showText) {
      paint(this.bmp); // ดูต้นฉบับ: วาดภาพเดิมทันที ไม่ต้องลบอะไร
      this.painted = true;
      return true;
    }
    const active = regions.filter((r) => r.text.trim() && !r.hidden);
    const ops = this.buildOps(active, brush, s);
    const want = ops.map((o) => o.key);
    if (!this.painted && want.length) {
      paint(this.bmp); // ระหว่างรอลบข้อความครั้งแรก ให้เห็นภาพหน้าก่อน
      this.painted = true;
    }
    const base = await this.sync(ops, want, my);
    if (!base) return false;
    await Promise.all(
      active.map((r) => {
        const st = resolveStyle(r, s);
        return ensureFont(st.font, st.bold, r.text);
      }),
    );
    if (this.dead || my !== this.token) return false;
    paint(base);
    const rects = active.map((r) => toRect(r.area, W, H));
    active.forEach((r, i) => drawRegionText(ctx, r, W, H, s, rects.filter((_, j) => j !== i)));
    this.painted = true;
    return true;
  }

  /** เตรียมภาพที่ลบแล้วไว้ล่วงหน้า (ไม่วาดลงจอ) ใช้กับหน้าข้างเคียง */
  prepare(regions: Region[], brush: Stroke[], s: Settings): Promise<boolean> {
    const my = ++this.token;
    const p = this.chain.then(async () => {
      if (this.dead || my !== this.token) return false;
      const active = regions.filter((r) => r.text.trim() && !r.hidden);
      const ops = this.buildOps(active, brush, s);
      const base = await this.sync(ops, ops.map((o) => o.key), my);
      if (my === this.token) this.trimNow();
      return !!base;
    });
    const safe = p.catch(() => false);
    this.chain = safe;
    return safe;
  }

  /** เก็บ snapshot ใหม่สุด 2 ชุด + ชุดล่าสุดที่ยังไม่มีเส้นแปรง (ไว้ย้อนเส้นแปรงได้เร็วโดยไม่ต้องลบข้อความใหม่ทั้งหน้า) */
  private pruneSnaps() {
    const base = this.snaps.find((sn) => !sn.keys.some((k) => k.charCodeAt(0) === 115)); // 's' = แปรง
    this.snaps = this.snaps.filter((sn, i) => {
      if (i < 2 || sn === base) return true;
      sn.bmp.close();
      return false;
    });
  }

  private trimNow() {
    if (this.canvas) {
      this.canvas.width = this.canvas.height = 0;
      this.canvas = null;
      this.canvasKeys = [];
    }
    while (this.snaps.length > 1) this.snaps.pop()!.bmp.close();
  }

  /** คืนหน่วยความจำของผืนงาน (เก็บเฉพาะภาพต้นฉบับ + snapshot ล่าสุด) */
  trim() {
    this.chain = this.chain.then(() => this.trimNow()).catch(() => undefined);
  }

  dispose() {
    this.dead = true;
    this.chain = this.chain
      .then(() => {
        this.trimNow();
        for (const s of this.snaps) s.bmp.close();
        this.snaps = [];
        this.bmp.close?.();
      })
      .catch(() => undefined);
  }
}

/** เรนเดอร์ภาพสุดท้ายเป็น Blob (ใช้ตอน export) */
export async function renderToBlob(
  src: Blob,
  page: Pick<Page, 'regions' | 'brush'>,
  s: Settings,
  showText: boolean,
  type = 'image/jpeg',
  q = 0.92,
): Promise<Blob> {
  const bmp = await createImageBitmap(src);
  const r = new PageRenderer(bmp, bmp.width, bmp.height);
  const c = document.createElement('canvas');
  try {
    if (!(await r.render(c, page.regions, page.brush ?? [], s, showText))) throw new Error('เรนเดอร์ภาพไม่สำเร็จ');
    return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('สร้างภาพไม่สำเร็จ'))), type, q));
  } finally {
    r.dispose();
    c.width = c.height = 0;
  }
}
