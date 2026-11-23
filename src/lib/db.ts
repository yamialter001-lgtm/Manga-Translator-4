import type { Page, Project } from '../types';

const NAME = 'manga-translator';
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(NAME, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('projects', { keyPath: 'id' });
        const pages = db.createObjectStore('pages', { keyPath: 'id' });
        pages.createIndex('byProject', 'projectId');
        db.createObjectStore('blobs');
        db.createObjectStore('fonts', { keyPath: 'name' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}

async function run<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = f(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export interface CustomFont {
  name: string;
  data: Blob;
}

export const db = {
  listProjects: async (): Promise<Project[]> =>
    (await run<Project[]>('projects', 'readonly', (s) => s.getAll())).sort((a, b) => b.updatedAt - a.updatedAt),
  getProject: (id: string) => run<Project | undefined>('projects', 'readonly', (s) => s.get(id)),
  putProject: (p: Project) => run('projects', 'readwrite', (s) => s.put(p)),

  listPages: async (projectId: string): Promise<Page[]> =>
    (await run<Page[]>('pages', 'readonly', (s) => s.index('byProject').getAll(projectId))).sort((a, b) => a.index - b.index),
  getPage: (id: string) => run<Page | undefined>('pages', 'readonly', (s) => s.get(id)),
  putPage: (p: Page) => run('pages', 'readwrite', (s) => s.put(p)),
  deletePage: async (id: string) => {
    await run('pages', 'readwrite', (s) => s.delete(id));
    await run('blobs', 'readwrite', (s) => s.delete(id));
  },

  getBlob: (id: string) => run<Blob | undefined>('blobs', 'readonly', (s) => s.get(id)),
  putBlob: (id: string, b: Blob) => run('blobs', 'readwrite', (s) => s.put(b, id)),

  deleteProject: async (id: string) => {
    const pages = await db.listPages(id);
    for (const p of pages) await db.deletePage(p.id);
    await run('projects', 'readwrite', (s) => s.delete(id));
  },

  listFonts: () => run<CustomFont[]>('fonts', 'readonly', (s) => s.getAll()),
  putFont: (f: CustomFont) => run('fonts', 'readwrite', (s) => s.put(f)),
  deleteFont: (name: string) => run('fonts', 'readwrite', (s) => s.delete(name)),

  /** คำนวณจำนวนหน้า/หน้าที่แปลแล้ว และภาพปกของโปรเจกต์ */
  async syncStats(projectId: string): Promise<Project | undefined> {
    const p = await db.getProject(projectId);
    if (!p) return;
    const pages = await db.listPages(projectId);
    p.pageCount = pages.length;
    p.doneCount = pages.filter((x) => x.status === 'done').length;
    p.cover = pages[0]?.thumb;
    await db.putProject(p);
    return p;
  },
};
