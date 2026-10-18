// Sessions: everything built in this browser — the chat tabs with their answers, case files and research trails — saved
// to a file and loaded back, like a desktop app's documents. The browser also keeps the current session by itself
// (IndexedDB); the file is the copy that survives a cleared browser, moves between machines, and can be shared.
import { app } from './state.svelte';
import { trail, type Trail } from './trail.svelte';

export interface SessionFile {
  sada_session: 1;
  saved_at: string;              // ISO time
  app: string;                   // the site it was saved from (informational)
  chats: any[];                  // Chat.svelte's chat tabs, as stored
  activeId: string;
  trails: Record<string, Trail>; // research trails by chat id
}

// Chat.svelte owns the chat tabs; it registers how to read and replace them
interface Hooks { get: () => { chats: any[]; activeId: string }; set: (chats: any[], activeId: string) => void }
let hooks: Hooks | null = null;
export function registerSession(h: Hooks) { hooks = h; }

export const session = $state({ file: '' });   // the name of the last file saved or loaded (shown in the menu)

export function buildSession(): SessionFile {
  const { chats, activeId } = hooks?.get() ?? { chats: [], activeId: '' };
  const ids = new Set(chats.map((c: any) => c.id));
  const trails: Record<string, Trail> = {};
  for (const [id, t] of Object.entries(trail.byChat)) if (ids.has(id)) trails[id] = JSON.parse(JSON.stringify(t));
  return { sada_session: 1, saved_at: new Date().toISOString(), app: location.origin, chats, activeId, trails };
}

export function applySession(f: SessionFile) {
  if (f?.sada_session !== 1 || !Array.isArray(f.chats)) throw new Error('Not a SADA session file');
  const chats = f.chats.filter(c => c && typeof c.id === 'string' && Array.isArray(c.turns));
  hooks?.set(chats, typeof f.activeId === 'string' ? f.activeId : '');
  const trails: Record<string, Trail> = {};
  for (const [id, t] of Object.entries(f.trails ?? {})) if (t && Array.isArray((t as Trail).steps)) trails[id] = t as Trail;
  trail.byChat = trails; trail.focus = null; trail.seq++;
}

const stamp = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

export function saveSession() {
  const name = `sada-session-${stamp()}.json`;
  const blob = new Blob([JSON.stringify(buildSession(), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  session.file = name;
  app.status = `Saved ${name}`; setTimeout(() => { if (app.status === `Saved ${name}`) app.status = ''; }, 4000);
}

export function loadSession() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      applySession(JSON.parse(await file.text()));
      session.file = file.name;
      app.status = `Loaded ${file.name}`; setTimeout(() => { if (app.status === `Loaded ${file.name}`) app.status = ''; }, 4000);
    } catch (e) { alert(`Could not load this file: ${(e as Error).message}`); }
  };
  input.click();
}

export function newSession() {
  if (!confirm('Start a new session? The current chats stay in this browser only if you saved them to a file.')) return;
  hooks?.set([], '');
  trail.byChat = {}; trail.focus = null; trail.seq++;
  session.file = '';
}
