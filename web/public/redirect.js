// Phones get the app itself now (the layout adapts below 760 px). This file stays so older cached pages that still
// reference it load cleanly; "?full=1" is remembered for the same reason.
(function () {
  try { if (new URLSearchParams(location.search).get('full') === '1') localStorage.setItem('sada.full', '1'); } catch (e) { /* storage blocked */ }
})();
