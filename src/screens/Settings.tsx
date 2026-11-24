import { useEffect, useRef, useState } from 'react';
import { db } from '../lib/db';
import { importFontFile, listFontNames } from '../lib/fonts';
import { getLastPreview, listModels, pingModel, sampleRequestPreview } from '../lib/gemini';
import { DEFAULTS, updateSettings, useSettings, type Reasoning } from '../lib/settings';
import { goUp } from '../nav';
import { Icon, Modal, Num, Range, Toggle, toast, Field } from '../ui';

interface TestRow {
  model: string;
  ok: boolean;
  ms: number;
  msg: string;
  listed?: boolean;
}

export default function SettingsScreen() {
  const s = useSettings();
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [rows, setRows] = useState<TestRow[] | null>(null);
  const [avail, setAvail] = useState<string[]>([]);
  const [fonts, setFonts] = useState<string[]>([]);
  const [preview, setPreview] = useState('');
  const fontInput = useRef<HTMLInputElement>(null);

  const loadFonts = () => listFontNames().then(setFonts);
  useEffect(() => {
    loadFonts();
  }, []);

  const runTest = async () => {
    if (!s.apiKey.trim()) return toast('กรอก API Key ก่อน', 'error');
    setTesting(true);
    setRows(null);
    try {
      const names = await listModels(s.apiKey.trim());
      setAvail(names);
      const out: TestRow[] = [];
      for (const m of [s.primaryModel, s.fallbackModel].filter((x, i, a) => x && a.indexOf(x) === i)) {
        out.push({ model: m, listed: names.includes(m), ...(await pingModel(s.apiKey.trim(), m)) });
      }
      setRows(out);
    } catch (e) {
      setRows([{ model: 'API Key', ok: false, ms: 0, msg: (e as Error).message }]);
    }
    setTesting(false);
  };

  const addFont = async (f: File | undefined) => {
    if (!f) return;
    try {
      toast(`นำเข้าฟอนต์ ${await importFontFile(f)} แล้ว`);
      loadFonts();
    } catch {
      toast('ไฟล์ฟอนต์ไม่ถูกต้อง (รองรับ .ttf .otf .woff .woff2)', 'error');
    }
  };
  const delFont = async (name: string) => {
    await db.deleteFont(name);
    toast('ลบแล้ว (มีผลเมื่อเปิดแอปใหม่)');
    loadFonts();
  };

  const custom = fonts.filter((f) => !['Itim', 'Kodchasan', 'FiraGO'].includes(f));

  return (
    <div className="screen">
      <header className="topbar">
        <button className="iconbtn" onClick={goUp} aria-label="กลับ">
          <Icon n="back" />
        </button>
        <h1 className="title">ตั้งค่า</h1>
      </header>
      <main className="content form">
        <h2 className="sec">Gemini API</h2>
        <Field label="API Key" hint="เก็บในเครื่องนี้เท่านั้น ไม่ถูกส่งไปที่ใดนอกจาก Google">
          <div className="row-del">
            <input type={showKey ? 'text' : 'password'} value={s.apiKey} autoComplete="off" onChange={(e) => updateSettings({ apiKey: e.target.value })} placeholder="AIza..." />
            <button className="btn small" onClick={() => setShowKey(!showKey)}>
              {showKey ? 'ซ่อน' : 'แสดง'}
            </button>
          </div>
        </Field>
        <Field label="โมเดลหลัก">
          <input list="models" value={s.primaryModel} onChange={(e) => updateSettings({ primaryModel: e.target.value.trim() })} />
        </Field>
        <Field label="โมเดลสำรอง" hint="ใช้เมื่อโมเดลหลักติด Rate limit / ล่ม / ไม่พบโมเดล (ถ้า Key ผิดจะไม่สลับ)">
          <input list="models" value={s.fallbackModel} onChange={(e) => updateSettings({ fallbackModel: e.target.value.trim() })} />
        </Field>
        <datalist id="models">
          {avail.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <button className="btn primary wide" onClick={runTest} disabled={testing}>
          {testing ? 'กำลังทดสอบ...' : 'ทดสอบการเชื่อมต่อ / ตรวจสอบโมเดล'}
        </button>
        {rows && (
          <div className="results">
            {rows.map((r) => (
              <div key={r.model} className={'res ' + (r.ok ? 'ok' : 'bad')}>
                <b>{r.model}</b>
                <span>
                  {r.ok ? `✓ ${r.msg} (${r.ms} ms)` : `✗ ${r.msg}`}
                  {r.listed === false && r.ok === false ? ' · ไม่อยู่ในรายการโมเดลของ Key นี้' : ''}
                </span>
              </div>
            ))}
            {avail.length > 0 && <p className="hint">พบ {avail.length} โมเดลที่ใช้ generateContent ได้ — แตะช่องโมเดลเพื่อเลือกจากรายการ</p>}
          </div>
        )}
        <div className="row2">
          <Field label="Temperature">
            <Num value={s.temperature} min={0} max={2} step={0.1} onChange={(v) => updateSettings({ temperature: v })} />
          </Field>
          <Field label="Max output tokens">
            <Num value={s.maxOutputTokens} min={512} max={65536} step={512} onChange={(v) => updateSettings({ maxOutputTokens: v })} />
          </Field>
        </div>
        <Field
          label="Reasoning Effort (ระดับการคิดของโมเดล)"
          hint={
            s.reasoning === 'none'
              ? 'ไม่ส่งค่านี้ไปให้ Gemini — ใช้ค่าเริ่มต้นของโมเดลนั้นๆ'
              : s.reasoning === 'low'
                ? 'คิดน้อย เร็วและประหยัดที่สุด'
                : s.reasoning === 'medium'
                  ? 'คิดแบบสมดุล'
                  : 'คิดลึกที่สุด ช้าลงและกินโทเคนมาก — โทเคนที่ใช้คิดนับรวมใน Max output tokens (แนะนำตั้งอย่างน้อย 16384) และอาจต้องเพิ่ม Timeout'
          }
        >
          <select value={s.reasoning} onChange={(e) => updateSettings({ reasoning: e.target.value as Reasoning })}>
            <option value="none">ไม่คิด (ไม่ส่งค่า ใช้ค่าเริ่มต้นของโมเดล)</option>
            <option value="low">ต่ำ</option>
            <option value="medium">กลาง</option>
            <option value="high">สูง</option>
          </select>
        </Field>
        <div className="row2">
          <Field label="ลองใหม่ (ครั้ง)">
            <Num value={s.retries} min={0} max={6} onChange={(v) => updateSettings({ retries: v })} />
          </Field>
          <Field label="Timeout (วินาที)">
            <Num value={s.timeoutSec} min={15} max={300} onChange={(v) => updateSettings({ timeoutSec: v })} />
          </Field>
        </div>
        <Toggle label="ลดการบล็อกเนื้อหาของ Gemini" hint="ตั้ง Safety เป็น BLOCK_NONE เพื่อลดการปฏิเสธภาพมังงะ" checked={s.relaxSafety} onChange={(v) => updateSettings({ relaxSafety: v })} />

        <h2 className="sec">การแปล</h2>
        <Toggle label="ใช้ OCR ในเครื่อง (ML Kit)" hint="อ่านข้อความและตำแหน่งก่อนส่ง Gemini — ได้กรอบลบที่แม่นขึ้น" checked={s.useOcr} onChange={(v) => updateSettings({ useOcr: v })} />
        <Toggle label="ส่งภาพต้นฉบับให้ Gemini" hint="ปิดเพื่อประหยัดโทเคน (ใช้เฉพาะข้อความ OCR)" checked={s.sendImage} onChange={(v) => updateSettings({ sendImage: v })} />
        <Toggle label="แปลเฉพาะบทพูด (ข้ามเสียงประกอบ)" checked={s.bubblesOnly} onChange={(v) => updateSettings({ bubblesOnly: v })} />
        <Toggle label="คำลงท้ายชื่อแบบเดิม (ซัง, คุง, จัง)" hint="ปิด = แปลเป็นคำไทยธรรมชาติ เช่น คุณ, พี่" checked={s.keepHonorifics} onChange={(v) => updateSettings({ keepHonorifics: v })} />
        <Field label="น้ำเสียง">
          <select value={s.tone} onChange={(e) => updateSettings({ tone: e.target.value as typeof s.tone })}>
            <option value="casual">เป็นกันเอง</option>
            <option value="neutral">กลางๆ</option>
            <option value="formal">สุภาพ</option>
          </select>
        </Field>
        <Toggle label="แชร์บริบทข้ามหน้า (Context Sharing)" hint="ส่งสรุปและบทพูดจากหน้าก่อนหน้าให้ Gemini" checked={s.contextSharing} onChange={(v) => updateSettings({ contextSharing: v })} />
        <Range label="จำนวนหน้าก่อนหน้าที่ใช้เป็นบริบท" value={s.contextPages} min={0} max={5} step={1} onChange={(v) => updateSettings({ contextPages: v })} />
        <Range label="ขนาดภาพที่ส่ง (ด้านยาวสุด)" value={s.maxImageSide} min={800} max={3000} step={100} onChange={(v) => updateSettings({ maxImageSide: v })} show={(v) => `${v}px`} />
        <Range label="คุณภาพ JPEG ที่ส่ง" value={s.jpegQuality} min={0.5} max={0.95} step={0.05} onChange={(v) => updateSettings({ jpegQuality: v })} />
        <Range label="ย่อภาพตอนนำเข้า (ด้านยาวสุด)" value={s.importMaxSide} min={1600} max={6000} step={200} onChange={(v) => updateSettings({ importMaxSide: v })} show={(v) => `${v}px`} />
        <button className="btn wide" onClick={() => setPreview(getLastPreview() || sampleRequestPreview(s))}>
          ดูรูปแบบข้อมูลที่ส่งให้ Gemini
        </button>

        <h2 className="sec">ข้อความที่วางบนภาพ</h2>
        <Field label="ฟอนต์เริ่มต้น">
          <select value={s.font} onChange={(e) => updateSettings({ font: e.target.value })}>
            {fonts.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </Field>
        <div className="row3">
          <Field label="สีตัวอักษร">
            <input type="color" value={s.textColor} onChange={(e) => updateSettings({ textColor: e.target.value })} />
          </Field>
          <Field label="สีขอบ">
            <input type="color" value={s.strokeColor} onChange={(e) => updateSettings({ strokeColor: e.target.value })} />
          </Field>
          <Field label="จัดวาง">
            <select value={s.align} onChange={(e) => updateSettings({ align: e.target.value as typeof s.align })}>
              <option value="center">กลาง</option>
              <option value="left">ซ้าย</option>
              <option value="right">ขวา</option>
            </select>
          </Field>
        </div>
        <Range label="ความหนาขอบ" value={s.strokePct} min={0} max={30} step={1} onChange={(v) => updateSettings({ strokePct: v })} />
        <Toggle label="ปิดขอบตัวอักษรทั้งหมด" checked={s.disableStroke} onChange={(v) => updateSettings({ disableStroke: v })} />
        <Range label="ระยะบรรทัด" value={s.lineHeight} min={0.9} max={1.8} step={0.05} onChange={(v) => updateSettings({ lineHeight: v })} />
        <Range label="ขนาดตัวอักษรสูงสุด (% ความกว้างหน้า)" value={s.maxFontPct} min={1.5} max={10} step={0.1} onChange={(v) => updateSettings({ maxFontPct: v })} />
        <Range label="ขนาดตัวอักษรต่ำสุด (% ความกว้างหน้า)" value={s.minFontPct} min={0.8} max={4} step={0.1} onChange={(v) => updateSettings({ minFontPct: v })} />
        <Toggle label="ใช้สีตัวอักษรเดิมของภาพ" hint="ตรวจสีตัวอักษรและขอบเดิม แล้วใช้กับข้อความไทยตอนแปล" checked={s.autoColor} onChange={(v) => updateSettings({ autoColor: v })} />
        <Range label="ความไวในการตรวจตัวอักษรที่จะลบ (ต่ำ = ลบมากขึ้น)" value={s.maskThreshold} min={12} max={80} step={1} onChange={(v) => updateSettings({ maskThreshold: v })} />
        <Range label="ตัวคูณพื้นที่ลบ (Inpaint)" value={s.eraseGrow} min={0.3} max={3} step={0.1} onChange={(v) => updateSettings({ eraseGrow: v })} />
        <Field label="พื้นหลังที่ลบข้อความ">
          <select value={s.bubbleFill} onChange={(e) => updateSettings({ bubbleFill: e.target.value as typeof s.bubbleFill })}>
            <option value="auto">อัตโนมัติ (เติมสีพื้น / ไล่สีจากขอบ)</option>
            <option value="white">เติมขาวเสมอ</option>
            <option value="none">ไม่ลบ</option>
          </select>
        </Field>

        <h2 className="sec">ฟอนต์</h2>
        <p className="hint">ฟอนต์ในแอป: Itim, Kodchasan, FiraGO (FiraGO ถ้าดาวน์โหลดตอน build ไม่สำเร็จ ให้นำเข้าไฟล์ .ttf เอง)</p>
        {custom.map((f) => (
          <div className="card-row row-del" key={f}>
            <span style={{ fontFamily: `"${f}"` }}>{f}</span>
            <button className="iconbtn" onClick={() => delFont(f)} aria-label="ลบ">
              <Icon n="trash" size={20} />
            </button>
          </div>
        ))}
        <input ref={fontInput} type="file" hidden onChange={(e) => { addFont(e.target.files?.[0]); e.target.value = ''; }} />
        <button className="btn wide" onClick={() => fontInput.current?.click()}>
          <Icon n="plus" size={18} /> นำเข้าไฟล์ฟอนต์ (.ttf / .otf)
        </button>

        <button className="btn ghost wide" onClick={() => { if (confirm('คืนค่าตั้งต้นทุกอย่าง (ยกเว้น API Key)?')) updateSettings({ ...DEFAULTS, apiKey: s.apiKey }); }}>
          คืนค่าตั้งต้น
        </button>
        <p className="hint">Manga Translator · ใช้ส่วนตัว · OCR ด้วย Google ML Kit · แปลด้วย Gemini API</p>
      </main>
      {preview && (
        <Modal title="รูปแบบ Gemini Request" onClose={() => setPreview('')} full>
          <p className="hint">ภาพ → OCR Text → Context/Glossary → Instructions แล้ว Gemini ตอบกลับเป็น JSON (ข้อความแปล + ลำดับ + พิกัดกล่อง)</p>
          <pre className="code">{preview}</pre>
        </Modal>
      )}
    </div>
  );
}
