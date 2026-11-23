import '@fontsource/itim/400.css';
import '@fontsource/kodchasan/400.css';
import '@fontsource/kodchasan/700.css';
import { db } from './db';

/** ฟอนต์ที่มากับแอป: Itim, Kodchasan (ผ่าน npm) และ FiraGO (ดาวน์โหลดตอน build — ถ้าไม่มีจะข้ามไป) */
export const BUILTIN_FONTS = ['Itim', 'Kodchasan', 'FiraGO'];

export const fontStack = (f: string) => `"${f}","Kodchasan","Itim","Noto Sans Thai","Noto Sans",sans-serif`;

export async function registerFiraGO() {
  const defs: [string, string][] = [
    ['400', 'fonts/FiraGO-Regular.ttf'],
    ['700', 'fonts/FiraGO-Bold.ttf'],
  ];
  for (const [weight, url] of defs) {
    try {
      const ff = new FontFace('FiraGO', `url(${url})`, { weight });
      await ff.load();
      document.fonts.add(ff);
    } catch {
      /* ไม่มีไฟล์ฟอนต์ — ใช้ฟอนต์สำรองแทน */
    }
  }
}

export async function loadCustomFonts(): Promise<string[]> {
  const names: string[] = [];
  try {
    for (const f of await db.listFonts()) {
      try {
        const ff = new FontFace(f.name, await f.data.arrayBuffer());
        await ff.load();
        document.fonts.add(ff);
        names.push(f.name);
      } catch {
        /* ฟอนต์เสีย */
      }
    }
  } catch {
    /* ignore */
  }
  return names;
}

export async function importFontFile(file: File): Promise<string> {
  const name = file.name.replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim() || 'CustomFont';
  const ff = new FontFace(name, await file.arrayBuffer());
  await ff.load();
  document.fonts.add(ff);
  await db.putFont({ name, data: file });
  return name;
}

export async function listFontNames(): Promise<string[]> {
  const custom = (await db.listFonts().catch(() => [])).map((f) => f.name);
  return [...BUILTIN_FONTS, ...custom];
}

export async function ensureFont(font: string, bold: boolean, sample: string) {
  try {
    await document.fonts.load(`${bold ? 700 : 400} 24px "${font}"`, sample || 'กขค ABC');
  } catch {
    /* ignore */
  }
}
