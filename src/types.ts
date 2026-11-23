export type Lang = 'auto' | 'ja' | 'en' | 'ko' | 'zh-TW' | 'zh-CN';

export const LANGS: { id: Lang; label: string; en: string }[] = [
  { id: 'ja', label: 'ญี่ปุ่น', en: 'Japanese' },
  { id: 'en', label: 'อังกฤษ', en: 'English' },
  { id: 'ko', label: 'เกาหลี', en: 'Korean' },
  { id: 'zh-TW', label: 'จีนตัวเต็ม', en: 'Traditional Chinese' },
  { id: 'zh-CN', label: 'จีนตัวย่อ', en: 'Simplified Chinese' },
  { id: 'auto', label: 'ตรวจจับอัตโนมัติ', en: 'unknown (detect it: Japanese, English, Korean, Traditional or Simplified Chinese)' },
];

/** [ymin, xmin, ymax, xmax] ปรับเป็นสเกล 0-1000 ของทั้งภาพ (รูปแบบเดียวกับ box_2d ของ Gemini) */
export type Box = [number, number, number, number];
export type Kind = 'speech' | 'thought' | 'narration' | 'sfx' | 'sign' | 'other';
export type ReadDir = 'rtl' | 'ltr' | 'ttb';

export const KIND_LABEL: Record<Kind, string> = {
  speech: 'คำพูด',
  thought: 'ความคิด',
  narration: 'บรรยาย',
  sfx: 'เสียง',
  sign: 'ป้าย',
  other: 'อื่นๆ',
};

export interface RegionStyle {
  font: string;
  sizePct: number; // % ของความกว้างหน้า, 0 = ปรับอัตโนมัติ
  color: string;
  stroke: string;
  strokePct: number; // ความหนาขอบ % ของขนาดตัวอักษร
  bold: boolean;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
}

export interface Region {
  id: string;
  kind: Kind;
  source: string;
  text: string;
  erase: Box; // พื้นที่ข้อความต้นฉบับที่จะลบ
  area: Box; // พื้นที่วางข้อความไทย
  fill: string; // 'auto' | 'none' | '#rrggbb'
  hidden: boolean;
  style: Partial<RegionStyle>;
}

export interface Page {
  id: string;
  projectId: string;
  index: number;
  name: string;
  width: number;
  height: number;
  status: 'new' | 'done' | 'error';
  error?: string;
  summary?: string;
  model?: string;
  regions: Region[];
  thumb?: Blob;
}

export interface Character {
  name: string;
  thai: string;
  gender: string;
  pronoun: string;
  note: string;
}

export interface GlossaryItem {
  src: string;
  thai: string;
  note: string;
}

export interface Project {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sourceLang: Lang;
  direction: ReadDir;
  synopsis: string;
  tone: string;
  customPrompt: string;
  characters: Character[];
  glossary: GlossaryItem[];
  pageCount: number;
  doneCount: number;
  cover?: Blob;
}
