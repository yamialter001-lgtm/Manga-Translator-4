import type { Box, Kind, Project } from '../types';
import { LANGS } from '../types';
import type { Settings } from './settings';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export type ErrKind = 'key' | 'quota' | 'model' | 'network' | 'server' | 'blocked' | 'parse' | 'bad';

export class GeminiError extends Error {
  constructor(
    msg: string,
    public kind: ErrKind,
    public status = 0,
  ) {
    super(msg);
  }
}

/** ข้อความที่ OCR ในเครื่องอ่านได้ (ส่งให้ Gemini เป็น "OCR Text") */
export interface OcrRegion {
  id: string;
  box: Box;
  text: string;
}

export interface PageInput {
  project: Project;
  settings: Settings;
  pageNo: number;
  pageTotal: number;
  imageB64?: string;
  mime: string;
  ocr: OcrRegion[];
  prevSummary: string;
  prevLines: { source: string; thai: string }[];
  extra?: string;
}

export interface RawRegion {
  ocr_ids: string[];
  source_text: string;
  translation: string;
  kind: Kind;
  box_2d: number[];
  bubble_box_2d: number[];
}

/* ------------------------------------------------------------------ */
/* รูปแบบข้อมูลที่ส่งให้ Gemini                                         */
/*   [1] Original Image   → inlineData                                  */
/*   [2] OCR Text         → <ocr_text> JSON (id, box_2d, text)          */
/*   [3] Context/Glossary → <context_glossary> JSON                     */
/*   [4] Instructions     → <translation_instructions>                  */
/*   ผลลัพธ์: JSON ตาม RESPONSE_SCHEMA (ข้อความแปล + ลำดับ + พิกัดกล่อง) */
/* ------------------------------------------------------------------ */

export const SYSTEM_PROMPT = `You are a professional manga / manhwa / manhua / comic localizer. Translate the dialogue of ONE comic page into natural Thai for a Thai-language release.

You receive, in this order:
1. ORIGINAL IMAGE - the full page. It is the ground truth.
2. OCR TEXT - machine-read text blocks with ids. box_2d is [ymin, xmin, ymax, xmax] normalised to 0-1000 over the whole image. OCR can be wrong, split one bubble into pieces, merge several bubbles, or miss text.
3. CONTEXT / GLOSSARY - story info, characters, glossary and the previous page. Follow it exactly.
4. TRANSLATION INSTRUCTIONS - options for this job.

Rules:
- Output one region per speech bubble, thought bubble, narration box, caption, sign or sound effect. Merge OCR fragments only when they are touching parts of the SAME text block. NEVER merge text blocks that are far apart or differ in colour, size or style (for example small white vertical text and large pink outlined text are different regions). Split blocks that contain several bubbles, and add text OCR missed (ocr_ids = []).
- Large stylised dialogue drawn directly over artwork (visual-novel / CG captions, coloured or outlined text, vertical columns) is dialogue too: translate every readable block.
- Every OCR id must appear in exactly one region's ocr_ids, or in ignored_ocr_ids if it is not translatable text (watermark, page number, logo, random artwork pattern).
- List regions in the reading order given in the instructions.
- source_text: the corrected original text of the region.
- translation: natural, fluent Thai that fits the speaker's personality, gender, relationship and mood. Never translate word-for-word, never add notes, explanations or romanization. Keep it short enough to fit inside the bubble. Use "\\n" only for deliberate line breaks.
- Ignore watermarks, page numbers, scanlator credits and site logos.
- box_2d: tight box that covers ALL of the ORIGINAL text of the region and nothing else (this area will be erased), so one region = one visually contiguous block. bubble_box_2d: the empty inner area of the bubble / caption box where Thai text can be placed (same as box_2d when there is no bubble). Both are integers [ymin, xmin, ymax, xmax] in 0-1000.
- page_summary: one or two short Thai sentences saying what happens on this page (it is reused as context for the next page).
- Reply with JSON only, matching the response schema.`;

export const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    page_summary: { type: 'STRING' },
    ignored_ocr_ids: { type: 'ARRAY', items: { type: 'STRING' } },
    regions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          order: { type: 'INTEGER' },
          ocr_ids: { type: 'ARRAY', items: { type: 'STRING' } },
          kind: { type: 'STRING', enum: ['speech', 'thought', 'narration', 'sfx', 'sign', 'other'] },
          source_text: { type: 'STRING' },
          translation: { type: 'STRING' },
          box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
          bubble_box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
        },
        required: ['order', 'ocr_ids', 'kind', 'source_text', 'translation', 'box_2d', 'bubble_box_2d'],
      },
    },
  },
  required: ['page_summary', 'ignored_ocr_ids', 'regions'],
};

const DIR_TEXT = {
  rtl: 'right-to-left, top-to-bottom (Japanese manga): read panels and bubbles from the top-right to the bottom-left',
  ltr: 'left-to-right, top-to-bottom (Western comic / manhua)',
  ttb: 'top-to-bottom vertical scroll (webtoon / manhwa)',
} as const;

const TONE_TEXT = {
  casual: 'casual, lively everyday Thai as spoken between friends (use particles like นะ, ล่ะ, เหรอ where natural)',
  neutral: 'neutral, natural Thai',
  formal: 'polite, formal Thai (ครับ/ค่ะ style) unless a character is clearly rude',
} as const;

function pickRelevant<T>(items: T[], keys: (t: T) => string[], hay: string, cap: number): T[] {
  if (items.length <= 40 || !hay.trim()) return items.slice(0, cap);
  return items.filter((it) => keys(it).some((k) => k && hay.includes(k))).slice(0, cap);
}

export function buildContext(inp: PageInput) {
  const { project: p, settings: s } = inp;
  const hay = inp.ocr.map((o) => o.text).join('\n');
  const chars = pickRelevant(p.characters, (c) => [c.name, c.thai], hay, 60).filter((c) => c.name || c.thai);
  const gloss = pickRelevant(p.glossary, (g) => [g.src], hay, 120).filter((g) => g.src || g.thai);
  const ctx: Record<string, unknown> = {
    series: { title: p.title, synopsis: p.synopsis || undefined, notes: p.tone || undefined },
    characters: chars.map((c) => ({
      source_name: c.name,
      thai_name: c.thai || undefined,
      gender: c.gender || undefined,
      thai_pronoun_style: c.pronoun || undefined,
      note: c.note || undefined,
    })),
    glossary: gloss.map((g) => ({ source: g.src, thai: g.thai, note: g.note || undefined })),
  };
  if (s.contextSharing) {
    ctx.previous_page_summary = inp.prevSummary || undefined;
    ctx.previous_dialogue = inp.prevLines.length ? inp.prevLines : undefined;
  }
  return ctx;
}

export function buildRequest(inp: PageInput) {
  const { project: p, settings: s } = inp;
  const src = LANGS.find((l) => l.id === p.sourceLang) ?? LANGS[0];

  const ocrPart = inp.ocr.length
    ? JSON.stringify({ ocr_regions: inp.ocr.map((o) => ({ id: o.id, box_2d: o.box, text: o.text })) })
    : 'No OCR available. Read all text directly from the image.';

  const instructions = [
    `Source language: ${src.en}`,
    'Target language: Thai (ภาษาไทย)',
    `Reading order: ${DIR_TEXT[p.direction]}`,
    `Page: ${inp.pageNo} of ${inp.pageTotal}`,
    `Tone: ${TONE_TEXT[s.tone]}`,
    s.keepHonorifics
      ? 'Honorifics: keep -san/-kun/-chan/-sama, hyung/noona/oppa etc. as Thai transliterations (ซัง, คุง, จัง, ซามะ, ฮยอง, นูน่า, ออปป้า).'
      : 'Honorifics: convert honorifics into natural Thai (คุณ, พี่, น้อง, ท่าน ...). Do not transliterate them unless they are part of a nickname.',
    s.bubblesOnly
      ? 'Scope: translate dialogue only (speech, thought, narration, signs that matter). Skip sound effects and decorative background text.'
      : 'Scope: translate dialogue AND sound effects (kind="sfx", keep them short and punchy). Skip unreadable decorative text.',
    `Extra instructions from the user: ${p.customPrompt.trim() || '(none)'}`,
    ...(inp.extra ? [`Correction note: ${inp.extra}`] : []),
  ].join('\n');

  const parts: Record<string, unknown>[] = [];
  if (inp.imageB64) parts.push({ inlineData: { mimeType: inp.mime, data: inp.imageB64 } });
  parts.push({ text: `[1] ORIGINAL IMAGE: ${inp.imageB64 ? 'attached above.' : 'not attached (use OCR text only).'}` });
  parts.push({ text: `[2] OCR TEXT\n<ocr_text>\n${ocrPart}\n</ocr_text>` });
  parts.push({ text: `[3] CONTEXT / GLOSSARY\n<context_glossary>\n${JSON.stringify(buildContext(inp))}\n</context_glossary>` });
  parts.push({ text: `[4] TRANSLATION INSTRUCTIONS\n<translation_instructions>\n${instructions}\n</translation_instructions>` });

  const generationConfig: Record<string, unknown> = {
    temperature: s.temperature,
    maxOutputTokens: s.maxOutputTokens,
    responseMimeType: 'application/json',
    responseSchema: RESPONSE_SCHEMA,
  };
  // Reasoning effort: 'none' = ไม่ส่งค่านี้เลย (ใช้ค่าเริ่มต้นของโมเดล)
  if (s.reasoning === 'low' || s.reasoning === 'medium' || s.reasoning === 'high') {
    generationConfig.thinkingConfig = { thinkingLevel: s.reasoning };
  }
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts }],
    generationConfig,
  };
  if (s.relaxSafety) {
    body.safetySettings = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'].map(
      (category) => ({ category, threshold: 'BLOCK_NONE' }),
    );
  }
  return body;
}

/** แปลงเป็นข้อความอ่านง่าย โดยย่อข้อมูลภาพ base64 */
export function previewRequest(body: Record<string, unknown>): string {
  return JSON.stringify(
    body,
    (k, v) => (k === 'data' && typeof v === 'string' && v.length > 80 ? `<base64 ${v.length} chars>` : v),
    2,
  );
}

let lastPreview = '';
export const getLastPreview = () => lastPreview;

/* ------------------------------------------------------------------ */
/* เรียก API + retry + สลับโมเดลสำรอง                                   */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function classify(status: number, raw: string): GeminiError {
  let msg = raw;
  try {
    msg = JSON.parse(raw).error?.message || raw;
  } catch {
    /* ไม่ใช่ JSON */
  }
  const short = String(msg).slice(0, 300);
  if (status === 401 || status === 403 || (status === 400 && /api key|API_KEY_INVALID|key not valid/i.test(raw)))
    return new GeminiError(`API Key ไม่ถูกต้องหรือไม่มีสิทธิ์: ${short}`, 'key', status);
  if (status === 404) return new GeminiError(`ไม่พบโมเดลนี้: ${short}`, 'model', status);
  if (status === 429) return new GeminiError(`ติด Rate limit / โควต้าเต็ม: ${short}`, 'quota', status);
  if (status >= 500) return new GeminiError(`เซิร์ฟเวอร์ Gemini ขัดข้อง (${status}): ${short}`, 'server', status);
  if (status === 400 && /model/i.test(short) && /(not found|not supported|invalid)/i.test(short))
    return new GeminiError(`โมเดลใช้ไม่ได้: ${short}`, 'model', status);
  return new GeminiError(`คำขอไม่ถูกต้อง (${status}): ${short}`, 'bad', status);
}

async function post(model: string, body: unknown, s: Settings, outer?: AbortSignal): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), s.timeoutSec * 1000);
  const onAbort = () => ctrl.abort();
  outer?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw classify(res.status, raw);
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new GeminiError('ตอบกลับไม่ใช่ JSON', 'parse');
    }
    const block = data.promptFeedback?.blockReason;
    if (block) throw new GeminiError(`Gemini บล็อกภาพนี้ (${block})`, 'blocked');
    const cand = data.candidates?.[0];
    if (!cand) throw new GeminiError('โมเดลไม่ส่งคำตอบกลับมา', 'parse');
    const text = (cand.content?.parts || []).map((p: any) => p.text || '').join('');
    if (!text) {
      if (cand.finishReason === 'SAFETY' || cand.finishReason === 'PROHIBITED_CONTENT')
        throw new GeminiError(`Gemini บล็อกคำตอบ (${cand.finishReason})`, 'blocked');
      throw new GeminiError(`คำตอบว่าง (${cand.finishReason || 'unknown'})`, 'parse');
    }
    return text;
  } catch (e) {
    if (e instanceof GeminiError) throw e;
    if (outer?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (ctrl.signal.aborted) throw new GeminiError('หมดเวลารอ Gemini', 'network');
    throw new GeminiError(`เชื่อมต่อไม่ได้: ${(e as Error).message}`, 'network');
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

function parseResult(text: string): { regions: RawRegion[]; summary: string; ignored: string[] } {
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let j: any;
  try {
    j = JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        j = JSON.parse(t.slice(a, b + 1));
      } catch {
        /* ignore */
      }
    }
  }
  if (!j || !Array.isArray(j.regions)) throw new GeminiError('รูปแบบคำตอบไม่ถูกต้อง (ลองเพิ่ม Max output tokens)', 'parse');
  const regions: RawRegion[] = j.regions
    .map((r: any, i: number) => ({
      order: Number(r.order) || i + 1,
      ocr_ids: Array.isArray(r.ocr_ids) ? r.ocr_ids.map(String) : [],
      source_text: String(r.source_text ?? ''),
      translation: String(r.translation ?? ''),
      kind: (['speech', 'thought', 'narration', 'sfx', 'sign', 'other'].includes(r.kind) ? r.kind : 'speech') as Kind,
      box_2d: Array.isArray(r.box_2d) ? r.box_2d.map(Number) : [],
      bubble_box_2d: Array.isArray(r.bubble_box_2d) ? r.bubble_box_2d.map(Number) : [],
    }))
    .sort((a: any, b: any) => a.order - b.order);
  const ignored: string[] = Array.isArray(j.ignored_ocr_ids) ? j.ignored_ocr_ids.map(String) : [];
  return { regions, summary: String(j.page_summary ?? ''), ignored };
}

export async function translateWithGemini(
  inp: PageInput,
  signal?: AbortSignal,
): Promise<{ regions: RawRegion[]; summary: string; ignored: string[]; model: string }> {
  const s = inp.settings;
  if (!s.apiKey.trim()) throw new GeminiError('ยังไม่ได้ใส่ Gemini API Key (ไปที่ ตั้งค่า)', 'key');
  const body = buildRequest(inp);
  lastPreview = previewRequest(body);
  const models = [s.primaryModel.trim(), s.fallbackModel.trim()].filter((m, i, a) => m && a.indexOf(m) === i);
  let last: GeminiError | null = null;
  for (const model of models) {
    for (let attempt = 0; attempt <= s.retries; attempt++) {
      try {
        const text = await post(model, body, s, signal);
        return { ...parseResult(text), model };
      } catch (e) {
        if (signal?.aborted) throw e;
        const ge = e instanceof GeminiError ? e : new GeminiError(String(e), 'network');
        last = ge;
        if (ge.kind === 'key') throw ge; // Key ผิด: แจ้งผู้ใช้ ไม่สลับโมเดล
        if (ge.kind === 'model' || ge.kind === 'blocked' || ge.kind === 'bad') break; // ไปโมเดลสำรองทันที
        if (attempt < s.retries) await sleep(1200 * 2 ** attempt); // 429 / 5xx / timeout / parse → ลองใหม่
      }
    }
  }
  if (last?.kind === 'quota') throw new GeminiError('Rate limit / โควต้าของทั้งโมเดลหลักและสำรองเต็ม — รอสักพักหรือตรวจโควต้าใน Google AI Studio', 'quota', 429);
  throw last ?? new GeminiError('แปลไม่สำเร็จ', 'network');
}

/* ------------------------------------------------------------------ */
/* ทดสอบการเชื่อมต่อ                                                    */
/* ------------------------------------------------------------------ */

export async function listModels(key: string): Promise<string[]> {
  const names: string[] = [];
  let token = '';
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${BASE}/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, {
      headers: { 'x-goog-api-key': key },
    });
    const raw = await res.text();
    if (!res.ok) throw classify(res.status, raw);
    const j = JSON.parse(raw);
    for (const m of j.models || []) {
      if (!m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
        names.push(String(m.name).replace(/^models\//, ''));
    }
    token = j.nextPageToken || '';
    if (!token) break;
  }
  return names;
}

export async function pingModel(key: string, model: string): Promise<{ ok: boolean; ms: number; msg: string }> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: OK' }] }],
        generationConfig: { maxOutputTokens: 64 },
      }),
    });
    const raw = await res.text();
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) return { ok: false, ms, msg: classify(res.status, raw).message };
    return { ok: true, ms, msg: 'พร้อมใช้งาน' };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), msg: `เชื่อมต่อไม่ได้: ${(e as Error).message}` };
  }
}

export function sampleRequestPreview(s: Settings): string {
  const body = buildRequest({
    project: {
      id: 'x', title: 'ชื่อเรื่อง', createdAt: 0, updatedAt: 0, sourceLang: 'ja', direction: 'rtl',
      synopsis: 'เรื่องย่อสั้นๆ', tone: '', customPrompt: '', pageCount: 0, doneCount: 0,
      characters: [{ name: 'ナルト', thai: 'นารูโตะ', gender: 'ชาย', pronoun: 'ฉัน / นาย', note: 'ร่าเริง พูดตรง' }],
      glossary: [{ src: '火影', thai: 'โฮคาเงะ', note: '' }],
    },
    settings: s,
    pageNo: 3,
    pageTotal: 24,
    imageB64: 'A'.repeat(200),
    mime: 'image/jpeg',
    ocr: [{ id: 't1', box: [120, 640, 310, 760], text: 'おれは火影になる！' }],
    prevSummary: 'ตัวเอกประกาศความฝันต่อหน้าเพื่อน',
    prevLines: [{ source: '本当か？', thai: 'จริงเหรอ?' }],
  });
  return previewRequest(body);
}
