import type { Box, Page, Project, Region } from '../types';
import { db } from './db';
import { translateWithGemini, type OcrRegion } from './gemini';
import { Native, isNative } from './native';
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
): Promise<{ regions: Region[]; summary: string; model: string; ocrCount: number }> {
  const blob = await db.getBlob(page.id);
  if (!blob) throw new Error('ไม่พบไฟล์ภาพของหน้านี้');
  const img = await prepareImage(blob, s.maxImageSide, s.jpegQuality);

  const ocr = s.useOcr ? await runOcr(img.b64, img.w, img.h, project.sourceLang) : [];
  if (!s.sendImage && !ocr.length) throw new Error('โหมดไม่ส่งภาพต้องใช้ OCR — OCR ไม่พบข้อความ (หรือใช้ไม่ได้บนอุปกรณ์นี้)');

  const ctx = s.contextSharing ? previousContext(allPages, page, s.contextPages) : { lines: [], summary: '' };
  const res = await translateWithGemini(
    {
      project,
      settings: s,
      pageNo: page.index + 1,
      pageTotal: allPages.length,
      imageB64: s.sendImage ? img.b64 : undefined,
      mime: img.mime,
      ocr,
      prevSummary: ctx.summary,
      prevLines: ctx.lines,
    },
    signal,
  );

  const byId = new Map(ocr.map((o) => [o.id, o]));
  const fill = s.bubbleFill === 'white' ? '#ffffff' : s.bubbleFill === 'none' ? 'none' : 'auto';
  const regions: Region[] = [];
  for (const r of res.regions) {
    if (!r.translation.trim()) continue;
    if (s.bubblesOnly && r.kind === 'sfx') continue;
    const ids = r.ocr_ids.filter((id) => byId.has(id));
    const gem = validBox(r.box_2d);
    let erase: Box | null = ids.length ? unionBox(ids.map((id) => byId.get(id)!.box)) : gem;
    if (!erase) erase = validBox(r.bubble_box_2d) ?? [400, 400, 600, 600];
    const bub = validBox(r.bubble_box_2d);
    const area: Box = bub ? unionBox([bub, erase]) : erase;
    regions.push({
      id: uid(),
      kind: r.kind,
      source: r.source_text,
      text: r.translation.trim(),
      erase,
      area,
      fill,
      hidden: false,
      style: {},
    });
  }
  return { regions, summary: res.summary, model: res.model, ocrCount: ocr.length };
}
