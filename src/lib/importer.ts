import { unzipSync } from 'fflate';
import type { Page } from '../types';
import { db } from './db';
import type { Settings } from './settings';
import { canvasToBlob, natCompare, uid } from './util';

const IMG_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp',
};
const extOf = (n: string) => (n.split('.').pop() || '').toLowerCase();
const isImageName = (n: string) => extOf(n) in IMG_EXT && !/(^|\/)(__MACOSX|\._)/.test(n);

interface Entry {
  name: string;
  load: () => Promise<Blob>;
}

async function expand(files: File[]): Promise<Entry[]> {
  const loose: Entry[] = [];
  const fromArchives: Entry[] = [];
  for (const f of files) {
    const ext = extOf(f.name);
    if (ext === 'zip' || ext === 'cbz') {
      const data = new Uint8Array(await f.arrayBuffer());
      const names: string[] = [];
      unzipSync(data, { filter: (e) => { names.push(e.name); return false; } });
      names
        .filter(isImageName)
        .sort(natCompare)
        .forEach((name) =>
          fromArchives.push({
            name: name.split('/').pop() || name,
            load: async () => {
              const out = unzipSync(data, { filter: (e) => e.name === name });
              return new Blob([out[name] as BlobPart], { type: IMG_EXT[extOf(name)] });
            },
          }),
        );
    } else if (f.type.startsWith('image/') || isImageName(f.name)) {
      loose.push({ name: f.name, load: async () => f });
    }
  }
  loose.sort((a, b) => natCompare(a.name, b.name));
  return [...fromArchives, ...loose];
}

async function thumbOf(bmp: ImageBitmap): Promise<Blob> {
  const w = 240;
  const h = Math.round((bmp.height / bmp.width) * w);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = Math.min(h, 480);
  c.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
  const b = await canvasToBlob(c, 'image/jpeg', 0.7);
  c.width = c.height = 0;
  return b;
}

export async function importFiles(
  projectId: string,
  files: File[],
  startIndex: number,
  s: Settings,
  onProgress: (done: number, total: number) => void,
): Promise<number> {
  const entries = await expand(files);
  let done = 0;
  for (const e of entries) {
    onProgress(done, entries.length);
    try {
      let blob = await e.load();
      let bmp = await createImageBitmap(blob);
      const big = Math.max(bmp.width, bmp.height);
      if (big > s.importMaxSide) {
        const k = s.importMaxSide / big;
        const c = document.createElement('canvas');
        c.width = Math.round(bmp.width * k);
        c.height = Math.round(bmp.height * k);
        c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
        bmp.close?.();
        blob = await canvasToBlob(c, 'image/jpeg', 0.92);
        c.width = c.height = 0;
        bmp = await createImageBitmap(blob);
      }
      const page: Page = {
        id: uid(),
        projectId,
        index: startIndex + done,
        name: e.name,
        width: bmp.width,
        height: bmp.height,
        status: 'new',
        regions: [],
        thumb: await thumbOf(bmp),
      };
      bmp.close?.();
      await db.putBlob(page.id, blob);
      await db.putPage(page);
      done++;
    } catch {
      /* ข้ามไฟล์ที่อ่านไม่ได้ */
    }
  }
  onProgress(done, entries.length);
  return done;
}
