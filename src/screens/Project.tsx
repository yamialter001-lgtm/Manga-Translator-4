import { useEffect, useRef, useState } from 'react';
import { db } from '../lib/db';
import { exportArchive, exportTexts } from '../lib/exporter';
import { GeminiError } from '../lib/gemini';
import { importFiles } from '../lib/importer';
import { translatePage } from '../lib/pipeline';
import { getSettings, useSettings } from '../lib/settings';
import { go, goUp, useBackHandler } from '../nav';
import type { Page, Project } from '../types';
import { BlobImg, Icon, Modal, toast } from '../ui';
import ContextPanel from './ContextPanel';

interface Job {
  label: string;
  i: number;
  n: number;
  cancel?: () => void;
}

export default function ProjectScreen({ projectId }: { projectId: string }) {
  const settings = useSettings();
  const [project, setProject] = useState<Project | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const pagesRef = useRef<Page[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [sheet, setSheet] = useState<'' | 'import' | 'menu' | 'export' | 'find' | 'context'>('');
  const [find, setFind] = useState('');
  const [repl, setRepl] = useState('');
  const fileImg = useRef<HTMLInputElement>(null);
  const fileArc = useRef<HTMLInputElement>(null);
  const saveTimer = useRef(0);
  const aborter = useRef<AbortController | null>(null);

  /* ปุ่มย้อนกลับของโทรศัพท์ ระหว่างมีงานทำอยู่: แปลทั้งหมดถามก่อนหยุด / นำเข้า-ส่งออกรอให้เสร็จ (ป้องกันกดพลาดแล้วงานหาย) */
  useBackHandler(() => {
    if (!job) return false;
    if (job.cancel && confirm('กำลังทำงานอยู่ ต้องการหยุดงานนี้หรือไม่?')) job.cancel();
    return true;
  });

  const setAllPages = (list: Page[]) => {
    pagesRef.current = list;
    setPages(list);
  };
  const reload = async () => {
    const p = await db.syncStats(projectId);
    if (!p) return go('/');
    setProject(p);
    setAllPages(await db.listPages(projectId));
  };
  useEffect(() => {
    reload();
    return () => aborter.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const editProject = (p: Project) => {
    setProject(p);
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => db.putProject({ ...p, updatedAt: Date.now() }), 400);
  };

  /* ---------- นำเข้า ---------- */
  const doImport = async (files: FileList | null) => {
    setSheet('');
    if (!files || !files.length) return;
    setJob({ label: 'กำลังนำเข้าภาพ', i: 0, n: files.length });
    try {
      const n = await importFiles(projectId, Array.from(files), pagesRef.current.length, getSettings(), (i, t) => setJob({ label: 'กำลังนำเข้าภาพ', i, n: t }));
      toast(n ? `นำเข้า ${n} หน้า` : 'ไม่พบไฟล์ภาพที่ใช้ได้', n ? 'info' : 'error');
    } catch (e) {
      toast(`นำเข้าไม่สำเร็จ: ${(e as Error).message}`, 'error');
    }
    setJob(null);
    await reload();
  };

  /* ---------- แปลทั้งหมด ---------- */
  const translateAll = async (force: boolean) => {
    setSheet('');
    if (!project) return;
    if (!settings.apiKey) return toast('ยังไม่ได้ใส่ Gemini API Key (ไปที่ ตั้งค่า)', 'error');
    const todo = pagesRef.current.filter((p) => force || p.status !== 'done');
    if (!todo.length) return toast('ทุกหน้าแปลเสร็จแล้ว');
    const ctrl = new AbortController();
    aborter.current = ctrl;
    let ok = 0;
    for (let k = 0; k < todo.length; k++) {
      if (ctrl.signal.aborted) break;
      const pg = todo[k];
      setJob({ label: `กำลังแปลหน้า ${pg.index + 1}`, i: k, n: todo.length, cancel: () => ctrl.abort() });
      try {
        const r = await translatePage(project, pg, getSettings(), pagesRef.current, ctrl.signal);
        const upd: Page = { ...pg, regions: r.regions, summary: r.summary, model: r.model, ocr: r.ocr, brush: [], status: 'done', error: undefined };
        await db.putPage(upd);
        setAllPages(pagesRef.current.map((x) => (x.id === upd.id ? upd : x)));
        ok++;
      } catch (e) {
        if (ctrl.signal.aborted) break;
        const msg = (e as Error).message || 'แปลไม่สำเร็จ';
        const upd: Page = { ...pg, status: 'error', error: msg };
        await db.putPage(upd);
        setAllPages(pagesRef.current.map((x) => (x.id === upd.id ? upd : x)));
        const kind = e instanceof GeminiError ? e.kind : '';
        if (kind === 'key' || kind === 'quota') {
          toast(msg, 'error');
          break; // Key ผิด / โควต้าหมด: หยุดงาน
        }
      }
    }
    aborter.current = null;
    setJob(null);
    toast(ok ? `แปลเสร็จ ${ok} หน้า` : 'ไม่มีหน้าที่แปลสำเร็จ', ok ? 'info' : 'error');
    await reload();
  };

  /* ---------- ส่งออก ---------- */
  const doExport = async (translated: boolean, ext: 'cbz' | 'zip') => {
    setSheet('');
    if (!project || !pagesRef.current.length) return;
    setJob({ label: 'กำลังสร้างไฟล์', i: 0, n: pagesRef.current.length });
    try {
      const where = await exportArchive(project, pagesRef.current, getSettings(), {
        translated,
        ext,
        onProgress: (i, n) => setJob({ label: 'กำลังสร้างไฟล์', i, n }),
      });
      toast(`บันทึกแล้ว: ${where}`);
    } catch (e) {
      toast(`ส่งออกไม่สำเร็จ: ${(e as Error).message}`, 'error');
    }
    setJob(null);
  };

  const doExportTexts = async () => {
    setSheet('');
    if (!project) return;
    try {
      toast(`บันทึกแล้ว: ${await exportTexts(project, pagesRef.current)}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  /* ---------- ค้นหา / แทนที่ ---------- */
  const countMatches = () => (find ? pages.reduce((n, p) => n + p.regions.reduce((m, r) => m + (r.text.split(find).length - 1), 0), 0) : 0);
  const doReplace = async () => {
    if (!find) return;
    let n = 0;
    const list: Page[] = [];
    for (const p of pagesRef.current) {
      let changed = false;
      const regions = p.regions.map((r) => {
        const c = r.text.split(find).length - 1;
        if (!c) return r;
        n += c;
        changed = true;
        return { ...r, text: r.text.split(find).join(repl) };
      });
      const np = changed ? { ...p, regions } : p;
      if (changed) await db.putPage(np);
      list.push(np);
    }
    setAllPages(list);
    setSheet('');
    toast(`แทนที่ ${n} จุด`);
  };

  if (!project) return <div className="screen" />;
  const done = pages.filter((p) => p.status === 'done').length;

  return (
    <div className="screen">
      <header className="topbar">
        <button className="iconbtn" onClick={goUp} aria-label="กลับ">
          <Icon n="back" />
        </button>
        <h1 className="title">{project.title}</h1>
        <button className="iconbtn" onClick={() => setSheet('context')} aria-label="บริบทและคำศัพท์">
          <Icon n="book" />
        </button>
        <button className="iconbtn" onClick={() => setSheet('menu')} aria-label="เมนู">
          <Icon n="more" />
        </button>
      </header>

      <main className="content">
        <div className="tools">
          <button className="btn" onClick={() => setSheet('import')}>
            <Icon n="plus" size={18} /> นำเข้า
          </button>
          <button className="btn primary" disabled={!pages.length} onClick={() => translateAll(false)}>
            <Icon n="translate" size={18} /> แปลทั้งหมด
          </button>
          <button className="btn" disabled={!pages.length} onClick={() => setSheet('export')}>
            <Icon n="download" size={18} /> ส่งออก
          </button>
        </div>
        <p className="meta">
          แปลแล้ว {done}/{pages.length} หน้า · ลำดับการอ่านและบริบทมีผลต่อคุณภาพ ลองใส่ตัวละครใน “บริบทและคำศัพท์”
        </p>

        {!pages.length && (
          <div className="empty">
            <div className="bubble-art" aria-hidden="true" />
            <p>นำเข้าภาพหรือไฟล์ CBZ / ZIP เพื่อเริ่มแปล</p>
          </div>
        )}

        <div className="grid">
          {pages.map((p) => (
            <button key={p.id} className={'pg ' + p.status} onClick={() => go(`/p/${projectId}/e/${p.id}`)}>
              <BlobImg blob={p.thumb} className="pgimg" />
              <span className="no">{p.index + 1}</span>
              {p.status === 'done' && (
                <span className="stamp ok">
                  <Icon n="check" size={14} />
                </span>
              )}
              {p.status === 'error' && <span className="stamp err">!</span>}
            </button>
          ))}
        </div>
      </main>

      {job && (
        <div className="jobbar">
          <div className="jobtxt">
            <span>
              {job.label} ({Math.min(job.i + 1, job.n)}/{job.n})
            </span>
            {job.cancel && (
              <button className="btn small danger" onClick={job.cancel}>
                หยุด
              </button>
            )}
          </div>
          <div className="bar">
            <i style={{ width: `${(job.i / Math.max(1, job.n)) * 100}%` }} />
          </div>
        </div>
      )}

      <input ref={fileImg} type="file" accept="image/*" multiple hidden onChange={(e) => { doImport(e.target.files); e.target.value = ''; }} />
      <input ref={fileArc} type="file" multiple hidden onChange={(e) => { doImport(e.target.files); e.target.value = ''; }} />

      {sheet === 'import' && (
        <Modal title="นำเข้า" onClose={() => setSheet('')}>
          <button className="btn wide" onClick={() => fileImg.current?.click()}>
            <Icon n="image" size={18} /> เลือกรูปภาพ (JPG / PNG / WebP / AVIF)
          </button>
          <button className="btn wide" onClick={() => fileArc.current?.click()}>
            <Icon n="file" size={18} /> เลือกไฟล์ CBZ / ZIP
          </button>
          <p className="hint">ภาพที่ใหญ่เกิน {settings.importMaxSide}px จะถูกย่อเพื่อประหยัดหน่วยความจำ (ปรับได้ในตั้งค่า)</p>
        </Modal>
      )}

      {sheet === 'menu' && (
        <Modal title="เมนูโปรเจกต์" onClose={() => setSheet('')}>
          <button className="btn wide" onClick={() => translateAll(true)} disabled={!pages.length}>
            <Icon n="spark" size={18} /> แปลใหม่ทุกหน้า
          </button>
          <button className="btn wide" onClick={() => setSheet('find')} disabled={!pages.length}>
            <Icon n="search" size={18} /> ค้นหาและแทนที่ข้อความ
          </button>
          <button className="btn wide" onClick={doExportTexts} disabled={!pages.length}>
            <Icon n="file" size={18} /> ส่งออกข้อความทั้งหมด (.txt)
          </button>
        </Modal>
      )}

      {sheet === 'export' && (
        <Modal title="ส่งออก" onClose={() => setSheet('')}>
          <button className="btn primary wide" onClick={() => doExport(true, 'cbz')}>
            ฉบับแปลไทย → CBZ
          </button>
          <button className="btn wide" onClick={() => doExport(true, 'zip')}>
            ฉบับแปลไทย → ZIP
          </button>
          <button className="btn wide" onClick={() => doExport(false, 'cbz')}>
            ต้นฉบับ → CBZ
          </button>
          <p className="hint">ไฟล์จะถูกบันทึกในโฟลเดอร์ Download/MangaTranslator (ถ้า Android เติม .zip ต่อท้ายชื่อ .cbz ให้เปลี่ยนชื่อเอง)</p>
        </Modal>
      )}

      {sheet === 'find' && (
        <Modal title="ค้นหาและแทนที่" onClose={() => setSheet('')}>
          <label className="field">
            <span className="lbl">ค้นหา</span>
            <input value={find} onChange={(e) => setFind(e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">แทนที่ด้วย</span>
            <input value={repl} onChange={(e) => setRepl(e.target.value)} />
          </label>
          <p className="hint">พบ {countMatches()} จุดในคำแปลของทุกหน้า</p>
          <button className="btn primary wide" disabled={!find || !countMatches()} onClick={doReplace}>
            แทนที่ทั้งหมด
          </button>
        </Modal>
      )}

      {sheet === 'context' && <ContextPanel project={project} onChange={editProject} onClose={() => setSheet('')} />}
    </div>
  );
}
