// Fills club details from config.js into the privacy notice and terms pages.
(function () {
  var c = window.RHC_CONFIG || {};
  document.querySelectorAll("[data-cfg]").forEach(function (el) {
    var v = c[el.getAttribute("data-cfg")];
    if (v) el.textContent = (el.getAttribute("data-cfg-prefix") || "") + v;
  });
  document.querySelectorAll("[data-cfg-mail]").forEach(function (el) {
    var v = c[el.getAttribute("data-cfg-mail")];
    if (v) el.setAttribute("href", "mailto:" + v); else el.removeAttribute("href");
  });
})();
