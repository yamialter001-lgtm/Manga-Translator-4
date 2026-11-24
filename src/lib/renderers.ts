import type { Page } from '../types';
import { db } from './db';
import { PageRenderer } from './render';
import type { Settings } from './settings';

/**
 * แคชตัวเรนเดอร์ของหลายหน้า (LRU) เพื่อให้สลับหน้าที่เคยเปิดหรือถูกเตรียมไว้ล่วงหน้าแล้ว
 * ไม่ต้องโหลดภาพ/ลบข้อความใหม่ทั้งหมด
 */
const MAX_CACHED = 4;
const cache = new Map<string, PageRenderer>(); // ลำดับการแทรก = ลำดับการใช้ล่าสุด
const loading = new Map<string, Promise<PageRenderer>>();
const pinned = new Set<string>();

function touch(id: string, r: PageRenderer) {
  cache.delete(id);
  cache.set(id, r);
}

function evict() {
  for (const [id, r] of cache) {
    if (cache.size <= MAX_CACHED) break;
    if (pinned.has(id)) continue;
    cache.delete(id);
    r.dispose();
  }
}

async function load(pageId: string): Promise<PageRenderer> {
  const blob = await db.getBlob(pageId);
  if (!blob) throw new Error('ไม่พบไฟล์ภาพของหน้านี้');
  const bmp = await createImageBitmap(blob);
  return new PageRenderer(bmp, bmp.width, bmp.height);
}

async function get(pageId: string): Promise<PageRenderer> {
  const hit = cache.get(pageId);
  if (hit) {
    touch(pageId, hit);
    return hit;
  }
  let p = loading.get(pageId);
  if (!p) {
    p = load(pageId);
    loading.set(pageId, p);
    p.then(
      () => loading.delete(pageId),
      () => loading.delete(pageId),
    );
  }
  const r = await p;
  if (!cache.has(pageId)) cache.set(pageId, r);
  touch(pageId, cache.get(pageId)!);
  evict();
  return cache.get(pageId)!;
}

/** ใช้โดยตัวแก้ไข: ล็อกไว้ไม่ให้ถูกไล่ออกจากแคชขณะเปิดอยู่ */
export async function acquireRenderer(pageId: string): Promise<PageRenderer> {
  pinned.add(pageId);
  try {
    return await get(pageId);
  } catch (e) {
    pinned.delete(pageId);
    throw e;
  }
}

/** ตอนปิดตัวแก้ไข: ปลดล็อกและคืนหน่วยความจำส่วนที่ไม่จำเป็น (ยังเก็บภาพที่ลบแล้วไว้ในแคช) */
export function releaseRenderer(pageId: string) {
  pinned.delete(pageId);
  cache.get(pageId)?.trim();
}

/** เตรียมหน้าข้างเคียงไว้ล่วงหน้า (โหลดภาพ + ลบข้อความ) */
export async function prefetchPage(page: Page, s: Settings, alive: () => boolean) {
  if (!alive()) return;
  const r = await get(page.id);
  if (!alive()) return;
  if (page.regions.length) await r.prepare(page.regions, page.brush ?? [], s);
}

/** ลบออกจากแคช (เช่น เมื่อลบหน้า) */
export function dropRenderer(pageId: string) {
  pinned.delete(pageId);
  const r = cache.get(pageId);
  cache.delete(pageId);
  r?.dispose();
}
