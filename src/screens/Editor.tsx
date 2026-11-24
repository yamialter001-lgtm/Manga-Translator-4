import { Fragment, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { db } from '../lib/db';
import { exportPageImage } from '../lib/exporter';
import { BUILTIN_FONTS, listFontNames } from '../lib/fonts';
import { translatePage } from '../lib/pipeline';
import { resolveStyle, type PageRenderer } from '../lib/render';
import { acquireRenderer, dropRenderer, prefetchPage, releaseRenderer } from '../lib/renderers';
import { useSettings } from '../lib/settings';
import { clamp, uid } from '../lib/util';
import { goUp, replace, useBackHandler } from '../nav';
import { KIND_LABEL, type Box, type Kind, type Page, type Project, type Region, type RegionStyle, type Stroke } from '../types';
import { Icon, Modal, Range, toast } from '../ui';

type Target = 'area' | 'erase';
interface Snap {
  regions: Region[];
  brush: Stroke[];
}
interface Drag {
  id: string;
  target: Target;
  which: 'move' | 'tl' | 'br';
  sx: number;
  sy: number;
  box: Box;
  w: number;
  h: number;
  cur: Box;
}

const ZOOMS = [1, 1.6, 2.4, 3.5];
const BARS_KEY = 'mt.barsMin';
const BRUSH_COLOR = '#d23a6b';
const boxStyle = (b: Box): CSSProperties => ({
  top: `${b[0] / 10}%`,
  left: `${b[1] / 10}%`,
  width: `${(b[3] - b[1]) / 10}%`,
  height: `${(b[2] - b[0]) / 10}%`,
});

export default function Editor({ projectId, pageId }: { projectId: string; pageId: string }) {
  const settings = useSettings();
  const [project, setProject] = useState<Project | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [page, setPage] = useState<Page | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [showTr, setShowTr] = useState(true);
  const [zoom, setZoom] = useState(0);
  const [busy, setBusy] = useState('');
  const [target, setTarget] = useState<Target>('area');
  const [sheet, setSheet] = useState<'' | 'list' | 'menu'>('');
  const [drag, setDrag] = useState<{ id: string; target: Target; box: Box } | null>(null);
  const [fonts, setFonts] = useState<string[]>(BUILTIN_FONTS);
  const [tool, setTool] = useState<'select' | 'brush'>('select');
  const [brushSize, setBrushSize] = useState(22);
  const [showOcr, setShowOcr] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [barsMin, setBarsMin] = useState(() => {
    try {
      return localStorage.getItem(BARS_KEY) === '1';
    } catch {
      return false;
    }
  });

  const pageRef = useRef<Page | null>(null);
  const pendingRef = useRef<Page | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const rendererRef = useRef<PageRenderer | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const hist = useRef({ past: [] as Snap[], future: [] as Snap[], key: '', at: 0 });
  const brushRef = useRef<HTMLCanvasElement>(null);
  const strokeRef = useRef<{ pts: number[]; rect: DOMRect; drawn: number } | null>(null);
  const aliveRef = useRef(true);
  const prefetchTimer = useRef(0);
  const saveTimer = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  /* ปุ่มย้อนกลับของโทรศัพท์: ยกเลิกงานที่กำลังทำ → ออกจากโหมดแปรง → ยกเลิกเลือกกล่อง (หน้าต่างป๊อปอัปจัดการเอง) */
  useBackHandler(() => {
    if (busy) {
      abortRef.current?.abort();
      return true;
    }
    if (tool === 'brush') {
      setTool('select');
      return true;
    }
    if (sel) {
      setSel(null);
      return true;
    }
    return false;
  });

  const flushSave = async () => {
    clearTimeout(saveTimer.current);
    const p = pendingRef.current;
    pendingRef.current = null;
    if (p) await db.putPage(p);
  };
  const queueSave = (p: Page) => {
    pendingRef.current = p;
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flushSave, 500);
  };

  /* ---------- โหลดหน้า ---------- */
  useEffect(() => {
    let dead = false;
    aliveRef.current = true;
    listFontNames().then(setFonts);
    (async () => {
      // โหลดภาพ/ตัวเรนเดอร์ (ใช้แคชถ้ามี) ไปพร้อมกับอ่านข้อมูลโปรเจกต์
      const rendP = acquireRenderer(pageId);
      rendP.catch(() => undefined);
      const [proj, list] = await Promise.all([db.getProject(projectId), db.listPages(projectId)]);
      const pg = list.find((p) => p.id === pageId);
      if (dead) return;
      if (!proj || !pg) return replace(`/p/${projectId}`);
      const r = await rendP;
      if (dead) return;
      rendererRef.current = r;
      setDims({ w: r.W, h: r.H });
      setProject(proj);
      setPages(list);
      pageRef.current = pg;
      setPage(pg);
    })().catch((e) => toast((e as Error).message, 'error'));
    return () => {
      dead = true;
      aliveRef.current = false;
      abortRef.current?.abort();
      clearTimeout(prefetchTimer.current);
      flushSave().then(() => db.syncStats(projectId));
      releaseRenderer(pageId);
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, pageId]);

  /* เตรียมหน้าถัดไป/ก่อนหน้าไว้ล่วงหน้าตอนว่าง เพื่อให้สลับหน้าได้ทันที */
  const schedulePrefetch = () => {
    clearTimeout(prefetchTimer.current);
    prefetchTimer.current = window.setTimeout(async () => {
      const cur = pageRef.current;
      if (!cur) return;
      const i = pages.findIndex((p) => p.id === cur.id);
      if (i < 0) return;
      for (const n of [pages[i + 1], pages[i - 1]]) {
        if (!n || !aliveRef.current) continue;
        try {
          await prefetchPage(n, settings, () => aliveRef.current);
        } catch {
          /* ข้าม: เตรียมไว้ล่วงหน้าไม่สำเร็จไม่เป็นไร */
        }
      }
    }, 700);
  };

  /* ---------- วาดภาพ ---------- */
  useEffect(() => {
    const r = rendererRef.current;
    const c = canvasRef.current;
    if (!r || !c || !page) return;
    setRendering(true);
    r.render(c, page.regions, page.brush ?? [], settings, showTr).then((ok) => {
      if (!ok || !aliveRef.current) return; // ถูกแทนที่ด้วยคำสั่งใหม่ (จะวาดต่อเอง)
      setRendering(false);
      if (!strokeRef.current) clearBrushPreview(); // ลบพรีวิวเส้นแปรงเมื่อภาพที่ลบจริงพร้อมแล้ว
      schedulePrefetch();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dims, page?.regions, page?.brush, showTr, settings]);

  /* ---------- แก้ไข + ประวัติ (Undo/Redo) ---------- */
  const apply = (regions: Region[], extra?: Partial<Page>) => {
    const p = pageRef.current;
    if (!p) return;
    const np: Page = { ...p, ...extra, regions, status: regions.length ? 'done' : p.status };
    pageRef.current = np;
    setPage(np);
    queueSave(np);
  };
  const commit = (regions: Region[], key = '', extra?: Partial<Page>) => {
    const p = pageRef.current;
    if (!p) return;
    const h = hist.current;
    const now = Date.now();
    if (!(key && h.key === key && now - h.at < 900)) {
      h.past.push({ regions: p.regions, brush: p.brush ?? [] });
      if (h.past.length > 80) h.past.shift();
    }
    h.key = key;
    h.at = now;
    h.future = [];
    apply(regions, extra);
  };
  const undo = () => {
    const h = hist.current;
    const prev = h.past.pop();
    const p = pageRef.current;
    if (!prev || !p) return;
    h.future.push({ regions: p.regions, brush: p.brush ?? [] });
    h.key = '';
    apply(prev.regions, { brush: prev.brush });
  };
  const redo = () => {
    const h = hist.current;
    const next = h.future.pop();
    const p = pageRef.current;
    if (!next || !p) return;
    h.past.push({ regions: p.regions, brush: p.brush ?? [] });
    h.key = '';
    apply(next.regions, { brush: next.brush });
  };

  const regions = page?.regions ?? [];
  const selected = regions.find((r) => r.id === sel) ?? null;
  const patch = (id: string, p: Partial<Region>, key?: string) => commit(regions.map((r) => (r.id === id ? { ...r, ...p } : r)), key);
  const patchStyle = (id: string, p: Partial<RegionStyle>) =>
    commit(regions.map((r) => (r.id === id ? { ...r, style: { ...r.style, ...p } } : r)), `style:${id}:${Object.keys(p).join(',')}`);

  const addRegion = () => {
    const st = stageRef.current;
    const sh = sheetRef.current;
    let cy = 500;
    let cx = 500;
    if (st && sh) {
      cx = clamp(((st.scrollLeft + st.clientWidth / 2) / sh.clientWidth) * 1000, 150, 850);
      cy = clamp(((st.scrollTop + st.clientHeight / 2) / sh.clientHeight) * 1000, 100, 900);
    }
    const fill = settings.bubbleFill === 'white' ? '#ffffff' : settings.bubbleFill === 'none' ? 'none' : 'auto';
    const r: Region = {
      id: uid(),
      kind: 'speech',
      source: '',
      text: 'ข้อความ',
      erase: [cy - 40, cx - 100, cy + 40, cx + 100].map(Math.round) as Box,
      area: [cy - 55, cx - 120, cy + 55, cx + 120].map(Math.round) as Box,
      widen: false,
      fill,
      hidden: false,
      style: {},
    };
    commit([...regions, r]);
    setSel(r.id);
    setShowTr(true);
  };

  const removeRegion = (id: string) => {
    commit(regions.filter((r) => r.id !== id));
    setSel(null);
  };

  /* ---------- แปลหน้านี้ ---------- */
  const doTranslate = async () => {
    const p = pageRef.current;
    if (!p || !project) return;
    if (!settings.apiKey) return toast('ยังไม่ได้ใส่ Gemini API Key (ไปที่ ตั้งค่า)', 'error');
    if (p.regions.length && !confirm('แปลใหม่จะแทนที่กล่องข้อความในหน้านี้ (ย้อนกลับได้ด้วยปุ่ม Undo) ต้องการต่อหรือไม่?')) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy('กำลังอ่านข้อความและส่งให้ Gemini...');
    try {
      const r = await translatePage(project, p, settings, pages.map((x) => (x.id === p.id ? p : x)), ctrl.signal);
      commit(r.regions, '', { summary: r.summary, model: r.model, ocr: r.ocr, error: undefined });
      setSel(null);
      setShowTr(true);
      toast(`แปลเสร็จ ${r.regions.length} กล่อง · ${r.model}${r.ocrCount ? ` · OCR ${r.ocrCount} บล็อก` : ''}`);
    } catch (e) {
      if (!ctrl.signal.aborted) toast((e as Error).message || 'แปลไม่สำเร็จ', 'error');
    }
    abortRef.current = null;
    setBusy('');
  };

  /* ---------- ลากย้าย / ปรับขนาดกรอบ ---------- */
  const beginDrag = (e: PointerEvent, r: Region, which: Drag['which']) => {
    const sh = sheetRef.current;
    if (!sh) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = sh.getBoundingClientRect();
    dragRef.current = {
      id: r.id, target, which, sx: e.clientX, sy: e.clientY,
      box: [...r[target]] as Box, w: rect.width, h: rect.height, cur: [...r[target]] as Box,
    };
  };
  const moveDrag = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = ((e.clientX - d.sx) / d.w) * 1000;
    const dy = ((e.clientY - d.sy) / d.h) * 1000;
    let [y0, x0, y1, x1] = d.box;
    if (d.which === 'move') {
      const h = y1 - y0;
      const w = x1 - x0;
      y0 = clamp(y0 + dy, 0, 1000 - h);
      x0 = clamp(x0 + dx, 0, 1000 - w);
      y1 = y0 + h;
      x1 = x0 + w;
    } else if (d.which === 'tl') {
      y0 = clamp(y0 + dy, 0, y1 - 20);
      x0 = clamp(x0 + dx, 0, x1 - 20);
    } else {
      y1 = clamp(y1 + dy, y0 + 20, 1000);
      x1 = clamp(x1 + dx, x0 + 20, 1000);
    }
    d.cur = [y0, x0, y1, x1].map(Math.round) as Box;
    setDrag({ id: d.id, target: d.target, box: d.cur });
  };
  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (d && d.cur.some((v, i) => v !== d.box[i]))
      patch(d.id, (d.target === 'erase' ? { erase: d.cur, parts: undefined } : { area: d.cur }) as Partial<Region>);
  };
  const dragProps = (r: Region) => ({
    onPointerDown: (e: PointerEvent) => beginDrag(e, r, 'move'),
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  });

  /* ---------- ใช้สไตล์กับกล่องอื่น ---------- */
  const styleOf = (r: Region) => {
    const s = resolveStyle(r, settings);
    return { font: s.font, color: s.color, stroke: s.stroke, strokePct: s.strokePct, bold: s.bold, align: s.align, lineHeight: s.lineHeight };
  };
  const applyToPage = () => {
    if (!selected) return;
    const st = styleOf(selected);
    commit(regions.map((r) => ({ ...r, style: { ...r.style, ...st } })));
    toast('ใช้สไตล์กับทุกกล่องในหน้านี้แล้ว');
  };
  const applyToAll = async () => {
    if (!selected || !page) return;
    const st = styleOf(selected);
    setBusy('กำลังปรับสไตล์ทุกหน้า...');
    for (const pg of pages) {
      if (pg.id === page.id || !pg.regions.length) continue;
      await db.putPage({ ...pg, regions: pg.regions.map((r) => ({ ...r, style: { ...r.style, ...st } })) });
    }
    commit(regions.map((r) => ({ ...r, style: { ...r.style, ...st } })));
    setBusy('');
    toast('ใช้สไตล์กับทั้งโปรเจกต์แล้ว');
  };

  /* ---------- เมนู ---------- */
  const saveImage = async (translated: boolean) => {
    setSheet('');
    if (!project || !page) return;
    setBusy('กำลังบันทึกภาพ...');
    try {
      await flushSave();
      toast(`บันทึกแล้ว: ${await exportPageImage(project, pageRef.current!, settings, translated)}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    setBusy('');
  };
  const deletePage = async () => {
    setSheet('');
    if (!page || !confirm('ลบหน้านี้ออกจากโปรเจกต์?')) return;
    pendingRef.current = null;
    clearTimeout(saveTimer.current);
    await db.deletePage(page.id);
    dropRenderer(page.id);
    let i = 0;
    for (const p of pages.filter((x) => x.id !== page.id)) {
      if (p.index !== i) await db.putPage({ ...p, index: i });
      i++;
    }
    replace(`/p/${projectId}`);
  };
  const clearAll = () => {
    setSheet('');
    if (regions.length && confirm('ลบกล่องข้อความทั้งหมดในหน้านี้?')) {
      commit([]);
      setSel(null);
    }
  };

  /* ---------- แปรงลบ ---------- */
  // พรีวิวเส้นแปรงวาดบนผืนย่อ (กว้างไม่เกิน 1000px) และวาดเฉพาะช่วงที่เพิ่มใหม่ ไม่วาดซ้ำทั้งเส้น
  const prepBrushCanvas = () => {
    const c = brushRef.current;
    if (!c || !dims) return null;
    const pw = Math.min(dims.w, 1000);
    const ph = Math.max(1, Math.round((dims.h * pw) / dims.w));
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    return c;
  };
  const clearBrushPreview = () => {
    const c = brushRef.current;
    if (c && c.width) c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
  };
  const paintBrush = () => {
    const st = strokeRef.current;
    const c = prepBrushCanvas();
    if (!st || !c) return;
    const x = c.getContext('2d')!;
    const sx = c.width / 1000;
    const sy = c.height / 1000;
    const lw = (brushSize / 1000) * c.width;
    x.strokeStyle = BRUSH_COLOR;
    x.fillStyle = BRUSH_COLOR;
    x.lineWidth = lw;
    x.lineCap = 'round';
    x.lineJoin = 'round';
    const n = st.pts.length;
    x.beginPath();
    if (n === 2) {
      x.arc(st.pts[0] * sx, st.pts[1] * sy, lw / 2, 0, Math.PI * 2);
      x.fill();
    } else {
      const start = Math.max(0, st.drawn - 2);
      x.moveTo(st.pts[start] * sx, st.pts[start + 1] * sy);
      for (let i = start + 2; i + 1 < n; i += 2) x.lineTo(st.pts[i] * sx, st.pts[i + 1] * sy);
      x.stroke();
    }
    st.drawn = n;
  };
  const brushPos = (e: PointerEvent, rect: DOMRect): [number, number] => [
    clamp(((e.clientX - rect.left) / rect.width) * 1000, 0, 1000),
    clamp(((e.clientY - rect.top) / rect.height) * 1000, 0, 1000),
  ];
  const brushDown = (e: PointerEvent) => {
    const sh = sheetRef.current;
    if (!sh || !dims) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = sh.getBoundingClientRect();
    const p = brushPos(e, rect);
    strokeRef.current = { pts: [p[0], p[1]], rect, drawn: 0 };
    paintBrush();
  };
  const brushMove = (e: PointerEvent) => {
    const st = strokeRef.current;
    if (!st || !dims) return;
    const p = brushPos(e, st.rect);
    const n = st.pts.length;
    if (Math.hypot(((p[0] - st.pts[n - 2]) * dims.w) / 1000, ((p[1] - st.pts[n - 1]) * dims.h) / 1000) < 3) return;
    st.pts.push(p[0], p[1]);
    paintBrush();
  };
  const brushUp = () => {
    const st = strokeRef.current;
    strokeRef.current = null;
    if (!st) return;
    const stroke: Stroke = { pts: st.pts.map((v) => Math.round(v * 10) / 10), size: brushSize };
    commit(regions, '', { brush: [...(pageRef.current?.brush ?? []), stroke] });
  };
  const undoStroke = () => commit(regions, '', { brush: (pageRef.current?.brush ?? []).slice(0, -1) });
  const enterBrush = () => {
    setSel(null);
    setShowTr(true);
    setTool(tool === 'brush' ? 'select' : 'brush');
  };

  const toggleBars = () => {
    const v = !barsMin;
    setBarsMin(v);
    try {
      localStorage.setItem(BARS_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const idx = page ? pages.findIndex((p) => p.id === page.id) : -1;
  const goPage = (d: number) => {
    const n = pages[idx + d];
    if (n) replace(`/p/${projectId}/e/${n.id}`);
  };
  const st = selected ? resolveStyle(selected, settings) : null;
  const h = hist.current;
  const fillKind = !selected ? 'auto' : selected.fill === 'auto' ? 'auto' : selected.fill === 'none' ? 'none' : 'color';

  if (!page || !dims) return <div className="screen" />;

  return (
    <div className="screen editor">
      <header className="topbar">
        <button className="iconbtn" onClick={goUp} aria-label="กลับ">
          <Icon n="back" />
        </button>
        <h1 className="title">
          หน้า {idx + 1} / {pages.length}
        </h1>
        <button className="iconbtn" disabled={idx <= 0} onClick={() => goPage(-1)} aria-label="หน้าก่อน">
          <Icon n="back" />
        </button>
        <button className="iconbtn" disabled={idx >= pages.length - 1} onClick={() => goPage(1)} aria-label="หน้าถัดไป">
          <Icon n="next" />
        </button>
        <button className="iconbtn" onClick={() => setSheet('menu')} aria-label="เมนู">
          <Icon n="more" />
        </button>
      </header>

      <div className="stage" ref={stageRef} onClick={() => setSel(null)}>
        <div className="sheetwrap" ref={sheetRef} style={{ width: `${(ZOOMS[zoom] ?? 1) * 100}%` }}>
          <canvas ref={canvasRef} width={dims.w} height={dims.h} className="pagecanvas" />
          <div className="overlay">
            {showTr &&
              tool === 'select' &&
              regions.map((r) => {
                const isSel = r.id === sel;
                const boxOf = (t: Target) => (drag && drag.id === r.id && drag.target === t ? drag.box : r[t]);
                const order: Target[] = isSel ? (target === 'area' ? ['erase', 'area'] : ['area', 'erase']) : ['area'];
                return (
                  <Fragment key={r.id}>
                    {isSel && r.parts && r.parts.map((pb, k) => <div key={'p' + k} className="bx part" style={boxStyle(pb)} />)}
                    {order.map((t) => {
                      const active = isSel && t === target;
                      return (
                        <div
                          key={t}
                          className={`bx ${t}${isSel ? ' sel' : ''}${r.hidden ? ' off' : ''}${active ? ' active' : ''}`}
                          style={boxStyle(boxOf(t))}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSel(r.id);
                          }}
                          {...(active ? dragProps(r) : {})}
                        >
                          {active && (
                            <>
                              <span className="hd tl" onPointerDown={(e) => beginDrag(e, r, 'tl')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} />
                              <span className="hd br" onPointerDown={(e) => beginDrag(e, r, 'br')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} />
                            </>
                          )}
                        </div>
                      );
                    })}
                  </Fragment>
                );
              })}
            {showOcr && page.ocr?.map((o) => (
              <div key={o.id} className="bx ocr" style={boxStyle(o.box)}>
                <i>{o.id}</i>
              </div>
            ))}
            <canvas ref={brushRef} className="brushcv" />
            {tool === 'brush' && <div className="brushpad" onPointerDown={brushDown} onPointerMove={brushMove} onPointerUp={brushUp} onPointerCancel={brushUp} />}
          </div>
        </div>
      </div>

      <button className="foldbar" onClick={toggleBars} aria-label={barsMin ? 'แสดงแถบเมนู' : 'ย่อแถบเมนู'}>
        <Icon n={barsMin ? 'chevUp' : 'chevDown'} size={18} />
        {barsMin && <span>{tool === 'brush' ? 'โหมดแปรงลบ · ' : ''}แตะเพื่อแสดงเมนู</span>}
      </button>

      {!barsMin && tool === 'brush' && (
        <div className="panel">
          <Range label="ขนาดแปรง" value={brushSize} min={6} max={80} step={1} onChange={setBrushSize} show={(v) => `${(v / 10).toFixed(1)}%`} />
          <p className="hint">ระบายทับตัวอักษรที่ยังเหลือ แอปจะลบและเติมพื้นหลังให้</p>
          <div className="row2">
            <button className="btn small" disabled={!page.brush?.length} onClick={undoStroke}>
              ลบเส้นล่าสุด
            </button>
            <button className="btn small primary" onClick={() => setTool('select')}>
              เสร็จ
            </button>
          </div>
        </div>
      )}

      {!barsMin && tool === 'select' && selected && st && (
        <div className="panel">
          <div className="panel-head">
            <select value={selected.kind} onChange={(e) => patch(selected.id, { kind: e.target.value as Kind })}>
              {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <div className="seg">
              <button className={target === 'area' ? 'on' : ''} onClick={() => setTarget('area')}>
                วางข้อความ
              </button>
              <button className={target === 'erase' ? 'on' : ''} onClick={() => setTarget('erase')}>
                พื้นที่ลบ
              </button>
            </div>
            <button className="iconbtn" onClick={() => patch(selected.id, { hidden: !selected.hidden })} aria-label="ซ่อน/แสดง" style={{ opacity: selected.hidden ? 0.4 : 1 }}>
              <Icon n="eye" size={20} />
            </button>
            <button className="iconbtn danger" onClick={() => removeRegion(selected.id)} aria-label="ลบกล่อง">
              <Icon n="trash" size={20} />
            </button>
            <button className="iconbtn" onClick={() => setSel(null)} aria-label="ปิด">
              <Icon n="x" size={20} />
            </button>
          </div>

          <label className="field">
            <span className="lbl">คำแปลไทย</span>
            <textarea rows={3} value={selected.text} onChange={(e) => patch(selected.id, { text: e.target.value }, `text:${selected.id}`)} />
          </label>
          <label className="field">
            <span className="lbl">ข้อความต้นฉบับ</span>
            <textarea rows={2} value={selected.source} onChange={(e) => patch(selected.id, { source: e.target.value }, `src:${selected.id}`)} />
          </label>

          <div className="row2">
            <label className="field">
              <span className="lbl">ฟอนต์</span>
              <select value={st.font} onChange={(e) => patchStyle(selected.id, { font: e.target.value })}>
                {fonts.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="lbl">การจัดวาง</span>
              <div className="seg">
                {(['left', 'center', 'right'] as const).map((a) => (
                  <button key={a} className={st.align === a ? 'on' : ''} onClick={() => patchStyle(selected.id, { align: a })}>
                    {a === 'left' ? 'ซ้าย' : a === 'center' ? 'กลาง' : 'ขวา'}
                  </button>
                ))}
                <button className={st.bold ? 'on' : ''} onClick={() => patchStyle(selected.id, { bold: !st.bold })}>
                  <b>B</b>
                </button>
              </div>
            </label>
          </div>
          <Range label="ขนาดตัวอักษร" value={st.sizePct} min={0} max={10} step={0.1} onChange={(v) => patchStyle(selected.id, { sizePct: v })} show={(v) => (v === 0 ? 'อัตโนมัติ' : `${v}%`)} />
          <Range label="ระยะบรรทัด" value={st.lineHeight} min={0.9} max={1.8} step={0.05} onChange={(v) => patchStyle(selected.id, { lineHeight: v })} />
          <div className="row3">
            <label className="field">
              <span className="lbl">สีตัวอักษร</span>
              <input type="color" value={st.color} onChange={(e) => patchStyle(selected.id, { color: e.target.value })} />
            </label>
            <label className="field">
              <span className="lbl">สีขอบ</span>
              <input type="color" value={st.stroke} onChange={(e) => patchStyle(selected.id, { stroke: e.target.value })} />
            </label>
            <label className="field">
              <span className="lbl">พื้นหลังที่ลบ</span>
              <select
                value={fillKind}
                onChange={(e) => patch(selected.id, { fill: e.target.value === 'auto' ? 'auto' : e.target.value === 'none' ? 'none' : '#ffffff' })}
              >
                <option value="auto">อัตโนมัติ</option>
                <option value="color">เติมสี</option>
                <option value="none">ไม่ลบ</option>
              </select>
            </label>
          </div>
          {fillKind === 'color' && (
            <label className="field">
              <span className="lbl">สีที่เติม</span>
              <input type="color" value={selected.fill} onChange={(e) => patch(selected.id, { fill: e.target.value }, `fill:${selected.id}`)} />
            </label>
          )}
          <Range label="ความหนาขอบ" value={st.strokePct} min={0} max={30} step={1} onChange={(v) => patchStyle(selected.id, { strokePct: v })} />
          <label className="toggle">
            <span>
              <span className="lbl">ขยายความกว้างอัตโนมัติ</span>
              <span className="hint">สำหรับข้อความแนวตั้งเดิมที่กรอบแคบและสูง</span>
            </span>
            <input type="checkbox" checked={!!selected.widen} onChange={(e) => patch(selected.id, { widen: e.target.checked })} />
            <i className="sw" />
          </label>
          <div className="row2">
            <button className="btn small" onClick={applyToPage}>
              ใช้สไตล์กับทั้งหน้า
            </button>
            <button className="btn small" onClick={applyToAll}>
              ใช้กับทั้งโปรเจกต์
            </button>
          </div>
        </div>
      )}

      {!barsMin && (
        <nav className="dock">
          <button className="dk primary" onClick={doTranslate}>
            <Icon n="translate" />
            <span>แปลหน้านี้</span>
          </button>
          <button className="dk" onClick={() => setShowTr(!showTr)}>
            <Icon n="eye" />
            <span>{showTr ? 'ดูต้นฉบับ' : 'ดูคำแปล'}</span>
          </button>
          <button className="dk" onClick={addRegion}>
            <Icon n="box" />
            <span>เพิ่มกล่อง</span>
          </button>
          <button className={'dk' + (tool === 'brush' ? ' on' : '')} onClick={enterBrush}>
            <Icon n="pen" />
            <span>แปรงลบ</span>
          </button>
          <button className="dk" disabled={!h.past.length} onClick={undo}>
            <Icon n="undo" />
            <span>ย้อน</span>
          </button>
          <button className="dk" disabled={!h.future.length} onClick={redo}>
            <Icon n="redo" />
            <span>ทำซ้ำ</span>
          </button>
          <button className="dk" onClick={() => setSheet('list')}>
            <Icon n="list" />
            <span>รายการ</span>
          </button>
          <button className="dk" onClick={() => setZoom((zoom + 1) % ZOOMS.length)}>
            <Icon n="zoom" />
            <span>{ZOOMS[zoom]}×</span>
          </button>
        </nav>
      )}

      {rendering && (
        <div className="renderchip">
          <i className="spin sm" />
          <span>กำลังลบข้อความ…</span>
        </div>
      )}

      {busy && (
        <div className="busy">
          <div className="spin" />
          <p>{busy}</p>
          {abortRef.current && (
            <button className="btn small danger" onClick={() => abortRef.current?.abort()}>
              ยกเลิก
            </button>
          )}
        </div>
      )}

      {sheet === 'list' && (
        <Modal title={`กล่องข้อความ (${regions.length})`} onClose={() => setSheet('')}>
          {!regions.length && <p className="hint">ยังไม่มีกล่องข้อความ กด “แปลหน้านี้” หรือ “เพิ่มกล่อง”</p>}
          {regions.map((r, i) => (
            <button
              key={r.id}
              className="rrow"
              onClick={() => {
                setSel(r.id);
                setShowTr(true);
                setSheet('');
              }}
            >
              <b>
                {i + 1}. {KIND_LABEL[r.kind]}
              </b>
              <span className="src">{r.source || '—'}</span>
              <span>{r.text}</span>
            </button>
          ))}
          {page.summary && <p className="hint">สรุปหน้านี้: {page.summary}</p>}
        </Modal>
      )}

      {sheet === 'menu' && (
        <Modal title="เมนูหน้า" onClose={() => setSheet('')}>
          <button className="btn wide" onClick={() => saveImage(true)}>
            <Icon n="download" size={18} /> บันทึกภาพหน้านี้ (แปลแล้ว)
          </button>
          <button className="btn wide" onClick={() => saveImage(false)}>
            <Icon n="image" size={18} /> บันทึกภาพต้นฉบับ
          </button>
          <button className="btn wide" onClick={() => { setShowOcr(!showOcr); setSheet(''); }}>
            <Icon n="search" size={18} /> {showOcr ? 'ซ่อนกรอบ OCR' : 'แสดงกรอบ OCR (ตรวจตำแหน่ง)'}
          </button>
          <button className="btn wide" disabled={!page.brush?.length} onClick={() => { commit(regions, '', { brush: [] }); setSheet(''); }}>
            <Icon n="pen" size={18} /> ล้างรอยแปรงทั้งหมด
          </button>
          <button className="btn wide" onClick={clearAll}>
            <Icon n="box" size={18} /> ล้างกล่องทั้งหมด
          </button>
          <button className="btn wide danger" onClick={deletePage}>
            <Icon n="trash" size={18} /> ลบหน้านี้
          </button>
          {page.model && <p className="hint">แปลด้วย {page.model}</p>}
        </Modal>
      )}
    </div>
  );
}
