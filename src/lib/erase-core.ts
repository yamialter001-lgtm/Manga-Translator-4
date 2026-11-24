/**
 * ส่วนคำนวณล้วนๆ (ไม่แตะ DOM) ของการตรวจตัวอักษรและเติมพื้นหลัง
 * ใช้ได้ทั้งใน Web Worker (erase.worker.ts) และบน main thread (สำรอง)
 */

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** รูปแบบเดียวกับ ImageData (ใช้เฉพาะ width/height/data) */
export interface Img {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/* ================================================================== */
/* ตรวจพิกเซลตัวอักษร (mask) + เติมพื้นหลังเฉพาะพิกเซลเหล่านั้น          */
/*  - เทียบแต่ละพิกเซลกับสีพื้นหลังเฉลี่ยรอบข้าง (2 รอบ รอบหลังตัดพิกเซล    */
/*    ตัวอักษรออกจากค่าเฉลี่ย) แล้วขยายขอบเล็กน้อยให้คลุมขอบ/เงาตัวอักษร   */
/*  - เติมโดยไล่สีจากพิกเซลข้างเคียงที่ไม่ใช่ตัวอักษร (ไม่แตะส่วนอื่นของภาพ) */
/* ================================================================== */

interface Integral {
  r: Float64Array;
  g: Float64Array;
  b: Float64Array;
  n: Float64Array;
}

function integral(d: Uint8ClampedArray, w: number, h: number, skip?: Uint8Array): Integral {
  const W1 = w + 1;
  const size = W1 * (h + 1);
  const R = new Float64Array(size);
  const G = new Float64Array(size);
  const B = new Float64Array(size);
  const N = new Float64Array(size);
  for (let y = 0; y < h; y++) {
    let rr = 0, gg = 0, bb = 0, nn = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!skip || !skip[i]) {
        rr += d[i * 4];
        gg += d[i * 4 + 1];
        bb += d[i * 4 + 2];
        nn += 1;
      }
      const k = (y + 1) * W1 + (x + 1);
      R[k] = R[k - W1] + rr;
      G[k] = G[k - W1] + gg;
      B[k] = B[k - W1] + bb;
      N[k] = N[k - W1] + nn;
    }
  }
  return { r: R, g: G, b: B, n: N };
}

const boxSum = (t: Float64Array, W1: number, x0: number, y0: number, x1: number, y1: number) =>
  t[y1 * W1 + x1] - t[y0 * W1 + x1] - t[y1 * W1 + x0] + t[y0 * W1 + x0];

function dilate(m: Uint8Array, w: number, h: number, rad: number): Uint8Array {
  if (rad <= 0) return m.slice();
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - rad);
      const b = Math.min(w - 1, x + rad);
      for (let xx = a; xx <= b; xx++) {
        if (m[y * w + xx]) {
          tmp[y * w + x] = 1;
          break;
        }
      }
    }
  }
  for (let y = 0; y < h; y++) {
    const a = Math.max(0, y - rad);
    const b = Math.min(h - 1, y + rad);
    for (let x = 0; x < w; x++) {
      for (let yy = a; yy <= b; yy++) {
        if (tmp[yy * w + x]) {
          out[y * w + x] = 1;
          break;
        }
      }
    }
  }
  return out;
}

export interface Key {
  r: number;
  g: number;
  b: number;
  n: number; // จำนวนพิกเซลที่ใกล้สีนี้
}

export interface TextMask {
  raw: Uint8Array; // พิกเซลตัวอักษรจริง (ก่อนขยาย)
  mask: Uint8Array; // หลังขยายขอบ
  keys: Key[]; // สีตัวอักษร/ขอบที่ตรวจพบ (เรียงตามจำนวน)
  flat: boolean; // พื้นหลังเรียบหรือไม่
  count: number;
}

const BINS = 16;
const binOf = (r: number, g: number, b: number) => ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);

/**
 * หาสีตัวอักษรโดยเทียบฮิสโตแกรมสี "ในกรอบ" กับ "วงแหวนรอบกรอบ":
 * สีที่มีมากในกรอบแต่แทบไม่มีรอบนอก = สีตัวอักษร/ขอบตัวอักษร แล้วทำ mask จากสีเหล่านั้น
 * ถ้าไม่พบสีเด่น (ตัวอักษรไล่สี) จะใช้วิธีเทียบความต่างจากพื้นหลังเฉลี่ยแทน
 * inner = พื้นที่ค้นหาในพิกัดของ img
 */
export function detectText(img: Img, inner: Rect, T: number, grow: number): TextMask {
  const { width: w, height: h, data: d } = img;
  const ix0 = clamp(Math.floor(inner.x0), 0, w);
  const iy0 = clamp(Math.floor(inner.y0), 0, h);
  const ix1 = clamp(Math.ceil(inner.x1), 0, w);
  const iy1 = clamp(Math.ceil(inner.y1), 0, h);
  const m = Math.min(ix1 - ix0, iy1 - iy0);
  const raw = new Uint8Array(w * h);

  // --- ฮิสโตแกรมในกรอบ / วงแหวน
  const nb = BINS * BINS * BINS;
  const hin = new Float32Array(nb);
  const hring = new Float32Array(nb);
  const sum = new Float64Array(nb * 3);
  let nin = 0;
  let nring = 0;
  for (let y = 0; y < h; y++) {
    const rowIn = y >= iy0 && y < iy1;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const k = binOf(d[i], d[i + 1], d[i + 2]);
      if (rowIn && x >= ix0 && x < ix1) {
        hin[k]++;
        sum[k * 3] += d[i];
        sum[k * 3 + 1] += d[i + 1];
        sum[k * 3 + 2] += d[i + 2];
        nin++;
      } else {
        hring[k]++;
        nring++;
      }
    }
  }
  const near = (hst: Float32Array, k: number) => {
    const r0 = k >> 8, g0 = (k >> 4) & 15, b0 = k & 15;
    let t = 0;
    for (let dr = -1; dr <= 1; dr++)
      for (let dg = -1; dg <= 1; dg++)
        for (let db = -1; db <= 1; db++) {
          const r = r0 + dr, g = g0 + dg, b = b0 + db;
          if (r < 0 || g < 0 || b < 0 || r >= BINS || g >= BINS || b >= BINS) continue;
          t += hst[(r << 8) | (g << 4) | b];
        }
    return t;
  };
  const cand: { k: number; n: number }[] = [];
  for (let k = 0; k < nb; k++) {
    if (hin[k] / Math.max(1, nin) < 0.01) continue;
    const exc = near(hin, k) / Math.max(1, nin) - (1.6 * near(hring, k)) / Math.max(1, nring);
    if (exc > 0.02) cand.push({ k, n: hin[k] });
  }
  cand.sort((a, b) => b.n - a.n);
  const keys: Key[] = [];
  for (const c of cand) {
    const col: [number, number, number] = [sum[c.k * 3] / c.n, sum[c.k * 3 + 1] / c.n, sum[c.k * 3 + 2] / c.n];
    if (keys.every((q) => Math.hypot(q.r - col[0], q.g - col[1], q.b - col[2]) > 56) && keys.length < 3)
      keys.push({ r: col[0], g: col[1], b: col[2], n: 0 });
  }

  let count = 0;
  if (keys.length) {
    const tk = T * 1.8;
    for (let y = iy0; y < iy1; y++) {
      for (let x = ix0; x < ix1; x++) {
        const i = y * w + x;
        let best = -1;
        let bd = tk;
        for (let q = 0; q < keys.length; q++) {
          const dd = Math.hypot(d[i * 4] - keys[q].r, d[i * 4 + 1] - keys[q].g, d[i * 4 + 2] - keys[q].b);
          if (dd < bd) { bd = dd; best = q; }
        }
        if (best >= 0) {
          raw[i] = 1;
          keys[best].n++;
          count++;
        }
      }
    }
    keys.sort((a, b) => b.n - a.n);
  } else {
    // สำรอง: ความต่างจากพื้นหลังเฉลี่ยรอบข้าง (2 รอบ)
    const r = clamp(Math.round(m * 0.3), 5, 30);
    const W1 = w + 1;
    const pass = (skip?: Uint8Array) => {
      const I = integral(d, w, h, skip);
      const out = new Uint8Array(w * h);
      for (let y = iy0; y < iy1; y++) {
        const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
        for (let x = ix0; x < ix1; x++) {
          const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
          const n = boxSum(I.n, W1, x0, y0, x1, y1);
          if (n < 1) continue;
          const i = y * w + x;
          const dr = d[i * 4] - boxSum(I.r, W1, x0, y0, x1, y1) / n;
          const dg = d[i * 4 + 1] - boxSum(I.g, W1, x0, y0, x1, y1) / n;
          const db = d[i * 4 + 2] - boxSum(I.b, W1, x0, y0, x1, y1) / n;
          if (Math.sqrt(dr * dr + dg * dg + db * db) > T * 1.3) out[i] = 1;
        }
      }
      return out;
    };
    const o1 = pass();
    const o2 = pass(dilate(o1, w, h, 1));
    for (let i = 0; i < o2.length; i++)
      if (o2[i]) {
        raw[i] = 1;
        count++;
      }
  }

  // พื้นหลังเรียบ? (วัดความต่างระหว่างพิกเซลข้างเคียงนอกตัวอักษร)
  let g = 0;
  let gn = 0;
  for (let y = iy0; y < iy1 - 1; y += 2) {
    for (let x = ix0; x < ix1 - 1; x += 2) {
      const i = y * w + x;
      if (raw[i] || raw[i + 1] || raw[i + w]) continue;
      g += (Math.abs(d[i * 4] - d[(i + 1) * 4]) + Math.abs(d[i * 4 + 1] - d[(i + 1) * 4 + 1]) + Math.abs(d[i * 4 + 2] - d[(i + 1) * 4 + 2]) +
        Math.abs(d[i * 4] - d[(i + w) * 4]) + Math.abs(d[i * 4 + 1] - d[(i + w) * 4 + 1]) + Math.abs(d[i * 4 + 2] - d[(i + w) * 4 + 2])) / 6;
      gn++;
    }
  }
  const dd = clamp(Math.round((0.03 * m + 2) * grow), 1, 9);
  return { raw, mask: dilate(raw, w, h, dd), keys, flat: gn ? g / gn < 3 : true, count };
}

/** เติมพิกเซลใน mask: เริ่มจากไล่สีจากขอบทีละชั้น แล้วทำให้เรียบแบบ Laplace (ไม่เกิดรอยข้าวหลามตัด) */
export function fillMasked(img: Img, mask: Uint8Array) {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const F = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    F[i * 3] = d[i * 4];
    F[i * 3 + 1] = d[i * 4 + 1];
    F[i * 3 + 2] = d[i * 4 + 2];
  }
  const known = new Uint8Array(n);
  const list: number[] = [];
  for (let i = 0; i < n; i++) {
    if (mask[i]) list.push(i);
    else known[i] = 1;
  }
  if (!list.length) return;
  let unknown = list.slice();
  let layers = 0;
  while (unknown.length && layers < 4000) {
    layers++;
    const upd: number[] = [];
    const vals: number[] = [];
    const next: number[] = [];
    for (const k of unknown) {
      const x = k % w;
      const y = (k / w) | 0;
      let c = 0, r = 0, g = 0, b = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((!dx && !dy) || nx < 0 || nx >= w) continue;
          const nk = ny * w + nx;
          if (!known[nk]) continue;
          r += F[nk * 3]; g += F[nk * 3 + 1]; b += F[nk * 3 + 2];
          c++;
        }
      }
      if (c) {
        upd.push(k);
        vals.push(r / c, g / c, b / c);
      } else next.push(k);
    }
    if (!upd.length) break;
    for (let j = 0; j < upd.length; j++) {
      const k = upd[j];
      F[k * 3] = vals[j * 3];
      F[k * 3 + 1] = vals[j * 3 + 1];
      F[k * 3 + 2] = vals[j * 3 + 2];
      known[k] = 1;
    }
    unknown = next;
  }
  // Laplace relaxation: ค่าที่เติมเป็นค่าเฉลี่ยของ 4 ข้างเคียง → ต่อเนื่องและเรียบ
  const iters = clamp(layers * 4, 24, 160);
  for (let it = 0; it < iters; it++) {
    const rev = it & 1;
    for (let q = 0; q < list.length; q++) {
      const k = list[rev ? list.length - 1 - q : q];
      const x = k % w;
      const y = (k / w) | 0;
      const l = x > 0 ? k - 1 : k;
      const r = x < w - 1 ? k + 1 : k;
      const u = y > 0 ? k - w : k;
      const dn = y < h - 1 ? k + w : k;
      for (let c = 0; c < 3; c++) F[k * 3 + c] = (F[l * 3 + c] + F[r * 3 + c] + F[u * 3 + c] + F[dn * 3 + c]) / 4;
    }
  }
  for (const k of list) {
    d[k * 4] = F[k * 3];
    d[k * 4 + 1] = F[k * 3 + 1];
    d[k * 4 + 2] = F[k * 3 + 2];
    d[k * 4 + 3] = 255;
  }
}

