import { useSyncExternalStore } from 'react';

export type Reasoning = 'none' | 'low' | 'medium' | 'high';
export const REASONING_LEVELS: Reasoning[] = ['none', 'low', 'medium', 'high'];

export interface Settings {
  // Gemini
  apiKey: string;
  primaryModel: string;
  fallbackModel: string;
  temperature: number;
  maxOutputTokens: number;
  retries: number;
  timeoutSec: number;
  relaxSafety: boolean;
  /** Reasoning effort: none = ไม่ส่งค่า (ใช้ค่าเริ่มต้นของโมเดล) */
  reasoning: Reasoning;
  // การแปล
  useOcr: boolean;
  sendImage: boolean;
  bubblesOnly: boolean;
  keepHonorifics: boolean;
  tone: 'casual' | 'neutral' | 'formal';
  contextSharing: boolean;
  contextPages: number;
  maxImageSide: number;
  jpegQuality: number;
  importMaxSide: number;
  // การวางข้อความ
  font: string;
  textColor: string;
  strokeColor: string;
  strokePct: number;
  disableStroke: boolean;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  maxFontPct: number;
  minFontPct: number;
  maskThreshold: number;
  autoColor: boolean;
  eraseGrow: number;
  bubbleFill: 'auto' | 'white' | 'none';
}

export const DEFAULTS: Settings = {
  apiKey: '',
  primaryModel: 'gemini-3.5-flash-lite',
  fallbackModel: 'gemini-3.8-flash',
  temperature: 0.3,
  maxOutputTokens: 8192,
  retries: 2,
  timeoutSec: 90,
  relaxSafety: true,
  reasoning: 'none',
  useOcr: true,
  sendImage: true,
  bubblesOnly: true,
  keepHonorifics: false,
  tone: 'casual',
  contextSharing: true,
  contextPages: 2,
  maxImageSide: 1600,
  jpegQuality: 0.85,
  importMaxSide: 3200,
  font: 'Itim',
  textColor: '#111111',
  strokeColor: '#ffffff',
  strokePct: 0,
  disableStroke: false,
  align: 'center',
  lineHeight: 1.15,
  maxFontPct: 3.6,
  minFontPct: 1.8,
  maskThreshold: 30,
  autoColor: true,
  eraseGrow: 1,
  bubbleFill: 'auto',
};

const KEY = 'mt.settings.v1';

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = { ...DEFAULTS, ...JSON.parse(raw) } as Settings;
      if (!REASONING_LEVELS.includes(s.reasoning)) s.reasoning = 'none';
      return s;
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

let current = load();
const subs = new Set<() => void>();

export const getSettings = () => current;

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* ignore */
  }
  subs.forEach((f) => f());
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => current,
  );
}
