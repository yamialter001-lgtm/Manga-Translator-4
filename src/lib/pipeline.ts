import type { Box, OcrBlock, Page, Project, Region } from '../types';
import { db } from './db';
import { translateWithGemini, type OcrRegion } from './gemini';
import { Native, isNative } from './native';
import { analyzeText, toRect } from './render';
import type { Settings } from './settings';
import { blobToBase64, canvasToBlob, clamp, uid } from './util';

/** ย่อภาพ + แปลงเป็น JPEG base64 สำหรับส่ง OCR / Gemini */
export async function prepareImage(blob: Blob, maxSide: number, quality: number) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const out = await canvasToBlob(c, 'image/jpeg', quality);
  c.width = c.height = 0;
  return { b64: await blobToBase64(out), mime: 'image/jpeg', w, h };
}

const validBox = (a: number[] | undefined): Box | null => {
  if (!a || a.length !== 4 || a.some((n) => !Number.isFinite(n))) return null;
  const [y0, x0, y1, x1] = a.map((n) => clamp(Math.round(n), 0, 1000));
  if (y1 - y0 < 5 || x1 - x0 < 5) return null;
  return [y0, x0, y1, x1];
};

const unionBox = (bs: Box[]): Box => [
  Math.min(...bs.map((b) => b[0])),
  Math.min(...bs.map((b) => b[1])),
  Math.max(...bs.map((b) => b[2])),
  Math.max(...bs.map((b) => b[3])),
];
const areaOf = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const touches = (a: Box, b: Box, gap: number) => !(a[2] + gap < b[0] || b[2] + gap < a[0] || a[3] + gap < b[1] || b[3] + gap < a[1]);

/** รวมกรอบที่ชิดกัน (ไม่รวมกรอบที่อยู่ห่างกัน เพื่อไม่ให้ลบพื้นที่ภาพระหว่างกลาง) */
function mergeBoxes(boxes: Box[], gap: number): Box[] {
  const list = boxes.map((b) => [...b] as Box);
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (touches(list[i], list[j], gap)) {
          list[i] = unionBox([list[i], list[j]]);
          list.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return list;
}

async function runOcr(b64: string, w: number, h: number, lang: string): Promise<OcrRegion[]> {
  if (!isNative() || lang === 'auto') return [];
  try {
    const r = await Native.recognize({ image: b64, lang });
    const joiner = lang === 'en' || lang === 'ko' ? ' ' : '';
    const W = r.width || w;
    const H = r.height || h;
    return r.blocks
      .filter((b) => b.text.trim() && b.box.length === 4)
      .map((b, i) => ({
        id: `t${i + 1}`,
        text: b.text.split('\n').join(joiner),
        box: [
          clamp(Math.round((b.box[1] / H) * 1000), 0, 1000),
          clamp(Math.round((b.box[0] / W) * 1000), 0, 1000),
          clamp(Math.round((b.box[3] / H) * 1000), 0, 1000),
          clamp(Math.round((b.box[2] / W) * 1000), 0, 1000),
        ] as Box,
      }));
  } catch {
    return []; // OCR ใช้ไม่ได้ → ให้ Gemini อ่านจากภาพเอง
  }
}

function previousContext(pages: Page[], page: Page, n: number) {
  const prev = pages.filter((p) => p.index < page.index && p.regions.length).sort((a, b) => b.index - a.index);
  const lines: { source: string; thai: string }[] = [];
  for (const p of prev.slice(0, Math.max(0, n)).reverse()) {
    for (const r of p.regions) if (r.text.trim()) lines.push({ source: r.source, thai: r.text });
  }
  return { lines: lines.slice(-14), summary: prev[0]?.summary || '' };
}

export async function translatePage(
  project: Project,
  page: Page,
  s: Settings,
  allPages: Page[],
  signal?: AbortSignal,
): Promise<{ regions: Region[]; summary: string; model: string; ocrCount: number; ocr: OcrBlock[] }> {
  const blob = await db.getBlob(page.id);
  if (!blob) throw new Error('ไม่พบไฟล์ภาพของหน้านี้');
  const img = await prepareImage(blob, s.maxImageSide, s.jpegQuality);

  const ocr = s.useOcr ? await runOcr(img.b64, img.w, img.h, project.sourceLang) : [];
  if (!s.sendImage && !ocr.length) throw new Error('โหมดไม่ส่งภาพต้องใช้ OCR — OCR ไม่พบข้อความ (หรือใช้ไม่ได้บนอุปกรณ์นี้)');

  const ctx = s.contextSharing ? previousContext(allPages, page, s.contextPages) : { lines: [], summary: '' };
  const input = {
    project,
    settings: s,
    pageNo: page.index + 1,
    pageTotal: allPages.length,
    imageB64: s.sendImage ? img.b64 : undefined,
    mime: img.mime,
    ocr,
    prevSummary: ctx.summary,
    prevLines: ctx.lines,
  };
  let res = await translateWithGemini(input, signal);

  // ตรวจว่า OCR บล็อกไหนยังไม่ถูกนับ → ถามซ้ำหนึ่งครั้ง (กันข้อความที่ถูกรวม/ตกหล่น)
  if (ocr.length) {
    const covered = new Set<string>([...res.ignored, ...res.regions.flatMap((r) => r.ocr_ids)]);
    const missed = ocr.filter((o) => !covered.has(o.id) && o.text.replace(/\s/g, '').length >= 2);
    if (missed.length) {
      const list = missed.slice(0, 12).map((o) => `${o.id} "${o.text.slice(0, 30)}"`).join('; ');
      const note = `Your previous answer did not account for these OCR blocks: ${list}. Return the complete JSON again: give each of them its own region (or list it in ignored_ocr_ids if it is not dialogue). Do not merge separate text blocks.`;
      try {
        const res2 = await translateWithGemini({ ...input, extra: note }, signal);
        if (res2.regions.length >= res.regions.length) res = res2;
      } catch (e) {
        if (signal?.aborted) throw e;
      }
    }
  }

  const byId = new Map(ocr.map((o) => [o.id, o]));
  const fill = s.bubbleFill === 'white' ? '#ffffff' : s.bubbleFill === 'none' ? 'none' : 'auto';
  const regions: Region[] = [];
  for (const r of res.regions) {
    if (!r.translation.trim()) continue;
    if (s.bubblesOnly && r.kind === 'sfx') continue;
    const own = r.ocr_ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!.box);
    const gem = validBox(r.box_2d);
    const bub = validBox(r.bubble_box_2d);

    // กรอบลบ: ใช้กรอบ OCR (แม่น) แยกเป็นก้อน ๆ + กรอบจาก Gemini ถ้าไม่เกินขอบเขตสมเหตุสมผล
    let parts: Box[] = own.length ? mergeBoxes(own, 12) : [];
    if (gem) {
      const ownArea = parts.reduce((a, b) => a + areaOf(b), 0);
      if (!parts.length) parts = [gem];
      else if (areaOf(gem) <= 3 * Math.max(ownArea, 1)) {
        const k = parts.findIndex((p) => touches(p, gem, 12));
        if (k >= 0) parts[k] = unionBox([parts[k], gem]);
        else parts.push(gem);
      }
    }
    if (!parts.length) parts = [bub ?? ([400, 400, 600, 600] as Box)];
    const largest = parts.reduce((a, b) => (areaOf(b) > areaOf(a) ? b : a));
    const area: Box = bub ? unionBox([bub, largest]) : largest;
    regions.push({
      id: uid(),
      kind: r.kind,
      source: r.source_text,
      text: r.translation.trim(),
      erase: unionBox(parts),
      parts: parts.length > 1 ? parts : undefined,
      area,
      widen: !bub || areaOf(bub) < 1.3 * areaOf(largest),
      fill,
      hidden: false,
      style: {},
    });
  }

  // สีตัวอักษรเดิม → ใช้กับข้อความไทย (สีเนื้อ + สีขอบ)
  if (s.autoColor && regions.length) {
    try {
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const cx = c.getContext('2d', { willReadFrequently: true })!;
      cx.drawImage(bmp, 0, 0);
      for (const reg of regions) {
        const box = reg.parts?.length ? reg.parts.reduce((a, b) => (areaOf(b) > areaOf(a) ? b : a)) : reg.erase;
        const a = analyzeText(cx, c.width, c.height, toRect(box, c.width, c.height), s);
        if (a) reg.style = { ...reg.style, color: a.color, stroke: a.stroke, strokePct: a.strokePct };
      }
      bmp.close?.();
      c.width = c.height = 0;
    } catch {
      /* วิเคราะห์สีไม่ได้ → ใช้สีเริ่มต้น */
    }
  }
  return { regions, summary: res.summary, model: res.model, ocrCount: ocr.length, ocr };
}
