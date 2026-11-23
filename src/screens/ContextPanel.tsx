import { LANGS, type Character, type GlossaryItem, type Lang, type Project, type ReadDir } from '../types';
import { Field, Icon, Modal } from '../ui';
import { DIR_LABEL } from './Home';

/** แก้ไขบริบทของเรื่อง: ตัวละคร, คำศัพท์เฉพาะ (Glossary), พรอมต์เพิ่มเติม */
export default function ContextPanel({ project, onChange, onClose }: { project: Project; onChange: (p: Project) => void; onClose: () => void }) {
  const set = (patch: Partial<Project>) => onChange({ ...project, ...patch });
  const setChar = (i: number, patch: Partial<Character>) => set({ characters: project.characters.map((c, j) => (i === j ? { ...c, ...patch } : c)) });
  const setGloss = (i: number, patch: Partial<GlossaryItem>) => set({ glossary: project.glossary.map((g, j) => (i === j ? { ...g, ...patch } : g)) });

  return (
    <Modal title="บริบทและคำศัพท์" onClose={onClose} full>
      <Field label="ชื่อเรื่อง">
        <input value={project.title} onChange={(e) => set({ title: e.target.value })} />
      </Field>
      <div className="row2">
        <Field label="ภาษาต้นฉบับ">
          <select value={project.sourceLang} onChange={(e) => set({ sourceLang: e.target.value as Lang })}>
            {LANGS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="ทิศทางการอ่าน">
          <select value={project.direction} onChange={(e) => set({ direction: e.target.value as ReadDir })}>
            {(Object.keys(DIR_LABEL) as ReadDir[]).map((d) => (
              <option key={d} value={d}>
                {DIR_LABEL[d]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="เรื่องย่อ / แนวเรื่อง" hint="บอก Gemini ว่าเรื่องเกี่ยวกับอะไร เพื่อให้เลือกคำและน้ำเสียงได้เหมาะสม">
        <textarea rows={3} value={project.synopsis} onChange={(e) => set({ synopsis: e.target.value })} />
      </Field>
      <Field label="หมายเหตุด้านน้ำเสียง / สรรพนาม" hint="เช่น ฉากโรงเรียน ใช้ภาษาวัยรุ่น ห้ามใช้คำหยาบ">
        <textarea rows={2} value={project.tone} onChange={(e) => set({ tone: e.target.value })} />
      </Field>
      <Field label="พรอมต์เพิ่มเติม" hint={`${project.customPrompt.length}/2000`}>
        <textarea rows={3} maxLength={2000} value={project.customPrompt} onChange={(e) => set({ customPrompt: e.target.value })} placeholder="คำสั่งเพิ่มเติมที่ต้องการให้ AI ทำตามทุกหน้า" />
      </Field>

      <h3 className="sub">ตัวละคร</h3>
      {project.characters.map((c, i) => (
        <div className="card-row" key={i}>
          <div className="row2">
            <input placeholder="ชื่อในต้นฉบับ" value={c.name} onChange={(e) => setChar(i, { name: e.target.value })} />
            <input placeholder="ชื่อภาษาไทย" value={c.thai} onChange={(e) => setChar(i, { thai: e.target.value })} />
          </div>
          <div className="row2">
            <select value={c.gender} onChange={(e) => setChar(i, { gender: e.target.value })}>
              <option value="">เพศ (ไม่ระบุ)</option>
              <option value="ชาย">ชาย</option>
              <option value="หญิง">หญิง</option>
              <option value="อื่นๆ">อื่นๆ</option>
            </select>
            <input placeholder="สรรพนาม เช่น ฉัน/นาย" value={c.pronoun} onChange={(e) => setChar(i, { pronoun: e.target.value })} />
          </div>
          <div className="row-del">
            <input placeholder="บุคลิก / หมายเหตุ" value={c.note} onChange={(e) => setChar(i, { note: e.target.value })} />
            <button className="iconbtn" onClick={() => set({ characters: project.characters.filter((_, j) => j !== i) })} aria-label="ลบ">
              <Icon n="trash" size={20} />
            </button>
          </div>
        </div>
      ))}
      <button className="btn ghost" onClick={() => set({ characters: [...project.characters, { name: '', thai: '', gender: '', pronoun: '', note: '' }] })}>
        <Icon n="plus" size={18} /> เพิ่มตัวละคร
      </button>

      <h3 className="sub">คำศัพท์เฉพาะ (Glossary)</h3>
      {project.glossary.map((g, i) => (
        <div className="card-row" key={i}>
          <div className="row2">
            <input placeholder="คำต้นฉบับ" value={g.src} onChange={(e) => setGloss(i, { src: e.target.value })} />
            <input placeholder="คำแปลไทย" value={g.thai} onChange={(e) => setGloss(i, { thai: e.target.value })} />
          </div>
          <div className="row-del">
            <input placeholder="หมายเหตุ (ถ้ามี)" value={g.note} onChange={(e) => setGloss(i, { note: e.target.value })} />
            <button className="iconbtn" onClick={() => set({ glossary: project.glossary.filter((_, j) => j !== i) })} aria-label="ลบ">
              <Icon n="trash" size={20} />
            </button>
          </div>
        </div>
      ))}
      <button className="btn ghost" onClick={() => set({ glossary: [...project.glossary, { src: '', thai: '', note: '' }] })}>
        <Icon n="plus" size={18} /> เพิ่มคำศัพท์
      </button>
      <p className="hint">แอปจะส่งเฉพาะตัวละครและคำศัพท์ที่พบในหน้านั้นให้ Gemini (ถ้ารายการเกิน 40 รายการ) เพื่อประหยัดโทเคน</p>
    </Modal>
  );
}
