// Runs before first paint (classic script in <head>) so there is no flash of the wrong theme.
(function () {
  var t = null;
  try { t = localStorage.getItem("sl-theme"); } catch (e) { /* storage blocked */ }
  if (t !== "dark" && t !== "light") t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = t;
})();
