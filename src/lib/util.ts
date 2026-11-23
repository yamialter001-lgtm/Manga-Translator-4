export const uid = (): string =>
  (globalThis.crypto && 'randomUUID' in globalThis.crypto
    ? globalThis.crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)
  ).replace(/-/g, '').slice(0, 20);

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const natCompare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export function blobToBase64(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1] || '');
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(b);
  });
}

export const u8ToBase64 = (u: Uint8Array) => blobToBase64(new Blob([u as BlobPart]));

export function canvasToBlob(c: HTMLCanvasElement, type = 'image/jpeg', q = 0.9): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('สร้างภาพไม่สำเร็จ'))), type, q));
}

export function safeName(s: string) {
  return s.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'manga';
}

export function fmtDate(t: number) {
  return new Date(t).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
}
