import { useEffect, useState } from 'react';
import { db } from '../lib/db';
import { useSettings } from '../lib/settings';
import { fmtDate, uid } from '../lib/util';
import { go } from '../nav';
import { LANGS, type Lang, type Project, type ReadDir } from '../types';
import { BlobImg, Field, Icon, Modal } from '../ui';

const DIR_BY_LANG: Record<Lang, ReadDir> = { ja: 'rtl', ko: 'ttb', en: 'ltr', 'zh-TW': 'ltr', 'zh-CN': 'ltr', auto: 'rtl' };
export const DIR_LABEL: Record<ReadDir, string> = { rtl: 'ขวา → ซ้าย (มังงะ)', ltr: 'ซ้าย → ขวา', ttb: 'เลื่อนลง (เว็บตูน)' };

export default function Home() {
  const s = useSettings();
  const [list, setList] = useState<Project[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [lang, setLang] = useState<Lang>('ja');
  const [dir, setDir] = useState<ReadDir>('rtl');

  const load = () => db.listProjects().then(setList);
  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    const now = Date.now();
    const p: Project = {
      id: uid(),
      title: title.trim() || 'โปรเจกต์ใหม่',
      createdAt: now,
      updatedAt: now,
      sourceLang: lang,
      direction: dir,
      synopsis: '',
      tone: '',
      customPrompt: '',
      characters: [],
      glossary: [],
      pageCount: 0,
      doneCount: 0,
    };
    await db.putProject(p);
    go(`/p/${p.id}`);
  };

  const remove = async (p: Project) => {
    if (!confirm(`ลบโปรเจกต์ "${p.title}" และทุกหน้าในนั้น?`)) return;
    await db.deleteProject(p.id);
    load();
  };

  return (
    <div className="screen">
      <header className="topbar">
        <h1 className="brand">Manga Translator</h1>
        <button className="iconbtn" onClick={() => go('/settings')} aria-label="ตั้งค่า">
          <Icon n="sliders" />
        </button>
      </header>
      <main className="content">
        {!s.apiKey && (
          <button className="notice" onClick={() => go('/settings')}>
            ยังไม่ได้ใส่ Gemini API Key — แตะเพื่อตั้งค่า
          </button>
        )}
        {list && list.length === 0 && (
          <div className="empty">
            <div className="bubble-art" aria-hidden="true" />
            <p>ยังไม่มีโปรเจกต์ เริ่มจากสร้างโปรเจกต์แล้วนำเข้าภาพมังงะหรือไฟล์ CBZ</p>
          </div>
        )}
        <div className="plist">
          {list?.map((p) => (
            <div key={p.id} className="pcard">
              <button className="pmain" onClick={() => go(`/p/${p.id}`)}>
                <BlobImg blob={p.cover} className="pcover" />
                <span className="pinfo">
                  <b>{p.title}</b>
                  <span>
                    {LANGS.find((l) => l.id === p.sourceLang)?.label} → ไทย
                  </span>
                  <span>
                    แปลแล้ว {p.doneCount}/{p.pageCount} หน้า · {fmtDate(p.updatedAt)}
                  </span>
                </span>
              </button>
              <button className="iconbtn" onClick={() => remove(p)} aria-label="ลบโปรเจกต์">
                <Icon n="trash" size={20} />
              </button>
            </div>
          ))}
        </div>
      </main>
      <button className="fab" onClick={() => setAdding(true)}>
        <Icon n="plus" /> โปรเจกต์ใหม่
      </button>
      {adding && (
        <Modal title="โปรเจกต์ใหม่" onClose={() => setAdding(false)}>
          <Field label="ชื่อเรื่อง">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="เช่น One Piece ตอนที่ 1" autoFocus />
          </Field>
          <Field label="ภาษาต้นฉบับ">
            <select
              value={lang}
              onChange={(e) => {
                const l = e.target.value as Lang;
                setLang(l);
                setDir(DIR_BY_LANG[l]);
              }}
            >
              {LANGS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="ทิศทางการอ่าน" hint="ใช้เรียงลำดับกล่องข้อความให้ตรงกับการอ่าน">
            <select value={dir} onChange={(e) => setDir(e.target.value as ReadDir)}>
              {(Object.keys(DIR_LABEL) as ReadDir[]).map((d) => (
                <option key={d} value={d}>
                  {DIR_LABEL[d]}
                </option>
              ))}
            </select>
          </Field>
          <button className="btn primary wide" onClick={create}>
            สร้างโปรเจกต์
          </button>
        </Modal>
      )}
    </div>
  );
}
