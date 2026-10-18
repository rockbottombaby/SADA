// Send the link to a computer: the phone's share sheet (mail, messages, notes…) where there is one, else copy it.
// A file rather than an inline script so the site's Content-Security-Policy can refuse inline scripts.
const URL_ = 'https://sadawatch.com';
const say = (id, t) => { const el = document.getElementById(id); el.textContent = t; setTimeout(() => { if (el.textContent === t) el.textContent = ''; }, 3500); };
async function copy(id) {
  try { await navigator.clipboard.writeText(URL_); say(id, 'Link copied. Open it on your computer.'); }
  catch { say(id, 'Copy this: sadawatch.com'); }
}
async function share(id) {
  if (navigator.share) {
    try { await navigator.share({ title: 'SADA', text: 'SADA: track the flights that carry weapons. Open on a computer:', url: URL_ }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  location.href = 'mailto:?subject=' + encodeURIComponent('SADA, open on a computer') + '&body=' + encodeURIComponent(URL_);
}
document.getElementById('copy').onclick = () => copy('done');
document.getElementById('copy2').onclick = () => copy('done2');
document.getElementById('share').onclick = () => share('done');
document.getElementById('share2').onclick = () => share('done2');
