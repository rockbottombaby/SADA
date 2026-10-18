// Window state of the two fixed rows at the bottom of the map (research panel, map card). They are always present and
// span the map's width; only the user changes their state (the assistant only changes their content):
// 'min' = a one-line footnote bar, 'normal' = the card, 'max' = fills the map viewport (one at a time).
// Minimised is remembered per browser; maximised is not (a reload starts with the map visible).
export type WinMode = 'min' | 'normal' | 'max';
export type Win = 'research' | 'scene';
const KEY = 'oam.dock';
let saved: Record<string, string> = {};
try { saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { /* private window: defaults */ }
export const dock = $state({ research: (saved.research === 'min' ? 'min' : 'normal') as WinMode, scene: (saved.scene === 'min' ? 'min' : 'normal') as WinMode });
export function setWin(w: Win, m: WinMode) {
  if (m === 'max') for (const k of ['research', 'scene'] as const) if (k !== w && dock[k] === 'max') dock[k] = 'normal';
  dock[w] = m;
  try { localStorage.setItem(KEY, JSON.stringify({ research: dock.research === 'min' ? 'min' : 'normal', scene: dock.scene === 'min' ? 'min' : 'normal' })); } catch { /* not remembered */ }
}
// what a row shows right now: the other row is a footnote while one is maximised
export const winMode = (w: Win): WinMode => {
  const other = w === 'research' ? dock.scene : dock.research;
  return other === 'max' && dock[w] !== 'max' ? 'min' : dock[w];
};
export const anyMax = () => dock.research === 'max' || dock.scene === 'max';
