import { useEffect, useState } from 'react';
import { loadCustomFonts, registerFiraGO } from './lib/fonts';
import EditorScreen from './screens/Editor';
import Home from './screens/Home';
import ProjectScreen from './screens/Project';
import SettingsScreen from './screens/Settings';
import { ToastHost } from './ui';

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
