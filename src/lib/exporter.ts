import { Zip, ZipPassThrough } from 'fflate';
import type { Page, Project } from '../types';
import { db } from './db';
import { FileSink } from './files';
import { renderToBlob } from './render';
import type { Settings } from './settings';
import { safeName } from './util';

/** ส่งออกทุกหน้าเป็น CBZ / ZIP (เขียนต่อทีละส่วน ไม่กินแรมมาก) */
export async function exportArchive(
  project: Project,
  pages: Page[],
  s: Settings,
  opts: { translated: boolean; ext: 'cbz' | 'zip'; onProgress: (i: number, n: number) => void },
): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `${safeName(project.title)}-${opts.translated ? 'TH' : 'original'}-${stamp}.${opts.ext}`;
  const sink = new FileSink(name, opts.ext === 'cbz' ? 'application/vnd.comicbook+zip' : 'application/zip');
  const queue: Uint8Array[] = [];
  let zerr: unknown = null;
  const zip = new Zip((err, chunk) => {
    if (err) zerr = err;
    else queue.push(chunk);
  });
  const drain = async () => {
    while (queue.length) await sink.write(queue.shift()!);
    if (zerr) throw zerr;
  };
  for (let i = 0; i < pages.length; i++) {
    opts.onProgress(i, pages.length);
    const p = pages[i];
    const src = await db.getBlob(p.id);
    if (!src) continue;
    const out = await renderToBlob(src, p, s, opts.translated);
    const f = new ZipPassThrough(`${String(i + 1).padStart(4, '0')}.jpg`);
    zip.add(f);
    f.push(new Uint8Array(await out.arrayBuffer()), true);
    await drain();
  }
  zip.end();
  await drain();
  opts.onProgress(pages.length, pages.length);
  return sink.finish();
}

export async function exportPageImage(project: Project, page: Page, s: Settings, translated: boolean): Promise<string> {
  const src = await db.getBlob(page.id);
  if (!src) throw new Error('ไม่พบไฟล์ภาพ');
  const out = await renderToBlob(src, page, s, translated);
  const sink = new FileSink(`${safeName(project.title)}-${String(page.index + 1).padStart(3, '0')}-${Date.now()}.jpg`, 'image/jpeg');
  await sink.write(new Uint8Array(await out.arrayBuffer()));
  return sink.finish();
}

/** ส่งออกข้อความทั้งหมด (ต้นฉบับ → คำแปล) เป็น .txt */
export async function exportTexts(project: Project, pages: Page[]): Promise<string> {
  const lines: string[] = [`# ${project.title}`, ''];
  for (const p of pages) {
    if (!p.regions.length) continue;
    lines.push(`[หน้า ${p.index + 1}]`);
    p.regions.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.source.replace(/\n/g, ' ')}`);
      lines.push(`   → ${r.text.replace(/\n/g, ' ')}`);
    });
    lines.push('');
  }
  const sink = new FileSink(`${safeName(project.title)}-texts.txt`, 'text/plain');
  await sink.write(new TextEncoder().encode(lines.join('\n')));
  return sink.finish();
}
