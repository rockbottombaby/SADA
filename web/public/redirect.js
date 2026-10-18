// Phones and small tablets get the mobile page (the app needs a large screen). "?full=1" opens the app anyway and is
// remembered. A separate file rather than an inline script so the page's Content-Security-Policy can refuse inline scripts.
(function () {
  try {
    var q = new URLSearchParams(location.search);
    if (q.get('full') === '1') localStorage.setItem('sada.full', '1');
    var forced = localStorage.getItem('sada.full') === '1';
    var touch = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;   // phones and tablets; never a mouse or trackpad
    var small = touch && (Math.min(screen.width, screen.height) < 700 || Math.max(screen.width, screen.height) < 1100);
    if (small && !forced && location.pathname.indexOf('/mobile') !== 0) location.replace('/mobile/index.html');
  } catch (e) { /* storage blocked: show the app */ }
})();
