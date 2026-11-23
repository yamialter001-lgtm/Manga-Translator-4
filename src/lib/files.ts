import { Native, isNative } from './native';
import { u8ToBase64 } from './util';

const SLICE = 1_500_000;

/** เขียนไฟล์ขนาดใหญ่ทีละส่วน แล้วบันทึกลง Download / Pictures (บนเบราว์เซอร์จะดาวน์โหลดตามปกติ) */
export class FileSink {
  private parts: Uint8Array[] = [];
  private size = 0;
  private first = true;
  private web: BlobPart[] = [];

  constructor(
    public name: string,
    public mime: string,
  ) {}

  async write(chunk: Uint8Array) {
    this.parts.push(chunk);
    this.size += chunk.length;
    if (this.size >= 2_000_000) await this.flush();
  }

  private async flush() {
    if (!this.size) return;
    const all = new Uint8Array(this.size);
    let o = 0;
    for (const p of this.parts) {
      all.set(p, o);
      o += p.length;
    }
    this.parts = [];
    this.size = 0;
    if (isNative()) {
      for (let i = 0; i < all.length; i += SLICE) {
        const data = await u8ToBase64(all.subarray(i, Math.min(all.length, i + SLICE)));
        await Native.writeChunk({ name: this.name, data, append: !this.first });
        this.first = false;
      }
    } else {
      this.web.push(all as BlobPart);
    }
  }

  async finish(): Promise<string> {
    await this.flush();
    if (isNative()) {
      const r = await Native.saveFile({ name: this.name, mime: this.mime });
      return r.location;
    }
    const url = URL.createObjectURL(new Blob(this.web, { type: this.mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = this.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return 'ดาวน์โหลดแล้ว';
  }
}

export async function saveBlob(name: string, mime: string, blob: Blob): Promise<string> {
  const sink = new FileSink(name, mime);
  await sink.write(new Uint8Array(await blob.arrayBuffer()));
  return sink.finish();
}
