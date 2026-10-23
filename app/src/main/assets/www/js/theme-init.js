/* Runs before first paint to avoid a flash of the wrong theme. */
(function () {
  var t = 'dark';
  try {
    t = localStorage.getItem('webypdf-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  } catch (e) { /* storage blocked */ }
  document.documentElement.setAttribute('data-theme', t);
})();
