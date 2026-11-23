import type { Box, Region, RegionStyle } from '../types';
import type { Settings } from './settings';
import { ensureFont, fontStack } from './fonts';

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

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

/* ------------------------------------------------------------------ */
/* ลบข้อความต้นฉบับ (inpainting แบบเบา)                                */
/* ------------------------------------------------------------------ */

const median = (a: number[]) => {
  const b = a.slice().sort((x, y) => x - y);
  return b[b.length >> 1];
};
const spreadOf = (a: number[], m: number) => Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);

function diffuseFill(ctx: CanvasRenderingContext2D, W: number, H: number, x0: number, y0: number, x1: number, y1: number) {
  const rx0 = Math.max(0, x0 - 1);
  const ry0 = Math.max(0, y0 - 1);
  const rx1 = Math.min(W, x1 + 1);
  const ry1 = Math.min(H, y1 + 1);
  const rw = rx1 - rx0;
  const rh = ry1 - ry0;
  const img = ctx.getImageData(rx0, ry0, rw, rh);
  const d = img.data;
  const known = new Uint8Array(rw * rh).fill(1);
  let unknown: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const k = (y - ry0) * rw + (x - rx0);
      known[k] = 0;
      unknown.push(k);
    }
  }
  let guard = 0;
  while (unknown.length && guard++ < 3000) {
    const upd: number[] = [];
    const vals: number[] = [];
    const next: number[] = [];
    for (const k of unknown) {
      const x = k % rw;
      const y = (k / rw) | 0;
      let n = 0,
        r = 0,
        g = 0,
        b = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
          const nk = ny * rw + nx;
          if (!known[nk]) continue;
          const i = nk * 4;
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
          n++;
        }
      }
      if (n) {
        upd.push(k);
        vals.push(r / n, g / n, b / n);
      } else next.push(k);
    }
    if (!upd.length) break;
    for (let j = 0; j < upd.length; j++) {
      const i = upd[j] * 4;
      d[i] = vals[j * 3];
      d[i + 1] = vals[j * 3 + 1];
      d[i + 2] = vals[j * 3 + 2];
      d[i + 3] = 255;
      known[upd[j]] = 1;
    }
    unknown = next;
  }
  ctx.putImageData(img, rx0, ry0);
}

/** ลบข้อความในสี่เหลี่ยม: auto = เติมสีพื้นหลัง (ถ้าพื้นเรียบ) หรือไล่สีจากขอบ (ถ้าเป็นลายภาพ) */
export function eraseRect(ctx: CanvasRenderingContext2D, W: number, H: number, r: Rect, fill: string) {
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
  const t = 3;
  const sx0 = Math.max(0, x0 - t);
  const sy0 = Math.max(0, y0 - t);
  const sx1 = Math.min(W, x1 + t);
  const sy1 = Math.min(H, y1 + t);
  const iw = sx1 - sx0;
  const d = ctx.getImageData(sx0, sy0, iw, sy1 - sy0).data;
  const R: number[] = [];
  const G: number[] = [];
  const B: number[] = [];
  for (let y = sy0; y < sy1; y++) {
    const rowInside = y >= y0 && y < y1;
    for (let x = sx0; x < sx1; x++) {
      if (rowInside && x >= x0 && x < x1) continue;
      const i = ((y - sy0) * iw + (x - sx0)) * 4;
      R.push(d[i]);
      G.push(d[i + 1]);
      B.push(d[i + 2]);
    }
  }
  if (!R.length) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(x0, y0, w, h);
    return;
  }
  const mr = median(R);
  const mg = median(G);
  const mb = median(B);
  const spread = Math.max(spreadOf(R, mr), spreadOf(G, mg), spreadOf(B, mb));
  if (spread < 24 || w * h > 280000) {
    ctx.fillStyle = `rgb(${mr},${mg},${mb})`;
    ctx.fillRect(x0, y0, w, h);
    return;
  }
  diffuseFill(ctx, W, H, x0, y0, x1, y1);
}

/* ------------------------------------------------------------------ */
/* จัดวางข้อความไทย                                                    */
/* ------------------------------------------------------------------ */

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

export function drawRegionText(ctx: CanvasRenderingContext2D, r: Region, W: number, H: number, s: Settings) {
  if (r.hidden || !r.text.trim()) return;
  const st = resolveStyle(r, s);
  const a = toRect(r.area, W, H);
  const inset = r.kind === 'speech' || r.kind === 'thought' ? 0.11 : 0.02;
  const bw = a.x1 - a.x0;
  const bh = a.y1 - a.y0;
  const x0 = a.x0 + bw * inset;
  const y0 = a.y0 + bh * inset;
  const w = bw * (1 - 2 * inset);
  const h = bh * (1 - 2 * inset);
  if (w < 4 || h < 4) return;
  const { size, lines } = layout(ctx, r.text, w, h, st, W, s.minFontPx, s.maxFontPct);
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

/* ------------------------------------------------------------------ */
/* ตัวเรนเดอร์หน้า: ภาพต้นฉบับ → ลบข้อความ → วางข้อความไทย              */
/* ------------------------------------------------------------------ */

export class PageRenderer {
  private base = document.createElement('canvas');
  private key = '';
  private chain: Promise<void> = Promise.resolve();

  constructor(
    public bmp: ImageBitmap,
    public W: number,
    public H: number,
  ) {
    this.base.width = W;
    this.base.height = H;
  }

  render(target: HTMLCanvasElement, regions: Region[], s: Settings, showText: boolean): Promise<void> {
    this.chain = this.chain.then(() => this.run(target, regions, s, showText)).catch(() => undefined);
    return this.chain;
  }

  private async run(target: HTMLCanvasElement, regions: Region[], s: Settings, showText: boolean) {
    const { W, H } = this;
    const active = showText ? regions.filter((r) => r.text.trim() && !r.hidden) : [];
    const key = JSON.stringify([active.map((r) => [r.erase, r.fill]), s.eraseGrow]);
    if (key !== this.key) {
      const bctx = this.base.getContext('2d', { willReadFrequently: true })!;
      bctx.globalCompositeOperation = 'source-over';
      bctx.drawImage(this.bmp, 0, 0, W, H);
      for (const r of active) {
        const e = toRect(r.erase, W, H);
        const pad = Math.round((Math.min(e.x1 - e.x0, e.y1 - e.y0) * 0.06 + 2) * s.eraseGrow);
        eraseRect(bctx, W, H, { x0: e.x0 - pad, y0: e.y0 - pad, x1: e.x1 + pad, y1: e.y1 + pad }, r.fill);
      }
      this.key = key;
    }
    await Promise.all(
      active.map((r) => {
        const st = resolveStyle(r, s);
        return ensureFont(st.font, st.bold, r.text);
      }),
    );
    if (target.width !== W || target.height !== H) {
      target.width = W;
      target.height = H;
    }
    const ctx = target.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this.base, 0, 0);
    for (const r of active) drawRegionText(ctx, r, W, H, s);
  }

  dispose() {
    this.bmp.close?.();
  }
}

/** เรนเดอร์ภาพสุดท้ายเป็น Blob (ใช้ตอน export) */
export async function renderToBlob(src: Blob, regions: Region[], s: Settings, showText: boolean, type = 'image/jpeg', q = 0.92): Promise<Blob> {
  const bmp = await createImageBitmap(src);
  const r = new PageRenderer(bmp, bmp.width, bmp.height);
  const c = document.createElement('canvas');
  await r.render(c, regions, s, showText);
  const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('สร้างภาพไม่สำเร็จ'))), type, q));
  r.dispose();
  c.width = c.height = 0;
  return blob;
}
