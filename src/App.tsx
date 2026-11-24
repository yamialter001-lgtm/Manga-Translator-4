import { App as CapApp } from '@capacitor/app';
import { useEffect, useState } from 'react';
import { loadCustomFonts, registerFiraGO } from './lib/fonts';
import EditorScreen from './screens/Editor';
import Home from './screens/Home';
import ProjectScreen from './screens/Project';
import SettingsScreen from './screens/Settings';
import { isNative } from './lib/native';
import { goUp, runBackHandlers } from './nav';
import { ToastHost, toast } from './ui';

export default function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const f = () => setHash(location.hash);
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  useEffect(() => {
    registerFiraGO();
    loadCustomFonts();
    navigator.storage?.persist?.().catch(() => undefined);
  }, []);

  /* ปุ่มย้อนกลับของโทรศัพท์ (ปุ่ม/ท่าทางของระบบ):
     ปิดหน้าต่าง/โหมดที่เปิดอยู่ก่อน → ไม่มีอะไรให้ปิดก็ย้อนขึ้นหน้าแม่ → หน้าแรกกดซ้ำ 2 ครั้งเพื่อออก */
  useEffect(() => {
    if (!isNative()) return;
    let dead = false;
    let last = 0;
    let remove: (() => void) | undefined;
    CapApp.addListener('backButton', () => {
      if (runBackHandlers()) return;
      if (goUp()) return;
      const now = Date.now();
      if (now - last < 2000) {
        CapApp.exitApp();
        return;
      }
      last = now;
      toast('กดย้อนกลับอีกครั้งเพื่อออกจากแอป');
    }).then((h) => {
      if (dead) h.remove();
      else remove = () => h.remove();
    });
    return () => {
      dead = true;
      remove?.();
    };
  }, []);

  const p = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  let view;
  if (p[0] === 'settings') view = <SettingsScreen />;
  else if (p[0] === 'p' && p[1] && p[2] === 'e' && p[3]) view = <EditorScreen key={p[3]} projectId={p[1]} pageId={p[3]} />;
  else if (p[0] === 'p' && p[1]) view = <ProjectScreen key={p[1]} projectId={p[1]} />;
  else view = <Home />;
  return (
    <>
      {view}
      <ToastHost />
    </>
  );
}
