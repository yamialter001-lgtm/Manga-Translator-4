import { Capacitor, registerPlugin } from '@capacitor/core';

export interface NativeApi {
  recognize(o: { image: string; lang: string }): Promise<{
    width: number;
    height: number;
    blocks: { text: string; box: number[] }[];
  }>;
  writeChunk(o: { name: string; data: string; append: boolean }): Promise<void>;
  saveFile(o: { name: string; mime: string }): Promise<{ location: string }>;
}

export const Native = registerPlugin<NativeApi>('MangaNative');
export const isNative = () => Capacitor.isNativePlatform();
