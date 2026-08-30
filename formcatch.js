/**
 * Formcatch v1 — drop-in spam filter for contact forms
 *
 * Usage:
 *   <script src="formcatch.js" data-site="your-site-id"></script>
 *   <form data-formcatch action="/submit">...</form>
 *
 * What it does:
 *   1. Injects a hidden honeypot field into every form marked [data-formcatch].
 *      Bots that auto-fill all fields will fill this one too.
 *   2. Records the timestamp the form became visible, and compares it to
 *      submit time. Sub-400ms submissions are almost never human.
 *   3. Adds a signed timing token so the server can verify the check wasn't
 *      just skipped client-side (client-side alone is not enough — see
 *      server.js for the required server check).
 *
 * This file only handles detection signals. It does NOT block submission
 * itself — your backend must read formcatch_hp and formcatch_ts and decide
 * whether to accept the submission. See server.js for a reference check.
 */
(function () {
  var SCRIPT_TAG = document.currentScript;
  var SITE_ID = SCRIPT_TAG ? SCRIPT_TAG.getAttribute('data-site') : null;
  var LOAD_TIME = Date.now();

  function injectHoneypot(form) {
    var wrap = document.createElement('div');
    // Visually hidden, but present in the DOM and tab order excluded —
    // screen-reader-safe honeypot, not display:none (some bots skip those).
    wrap.style.cssText = 'position:absolute;left:-9999px;top:-9999px;height:0;overflow:hidden;';
    wrap.setAttribute('aria-hidden', 'true');

    var input = document.createElement('input');
    input.type = 'text';
    input.name = 'formcatch_hp';
    input.tabIndex = -1;
    input.autocomplete = 'off';

    wrap.appendChild(input);
    form.appendChild(wrap);
  }

  function injectTimestamp(form) {
    var ts = document.createElement('input');
    ts.type = 'hidden';
    ts.name = 'formcatch_ts';
    ts.value = String(LOAD_TIME);
    form.appendChild(ts);
  }

  function injectSiteId(form) {
    if (!SITE_ID) return;
    var site = document.createElement('input');
    site.type = 'hidden';
    site.name = 'formcatch_site';
    site.value = SITE_ID;
    form.appendChild(site);
  }

  function init() {
    var forms = document.querySelectorAll('form[data-formcatch]');
    forms.forEach(function (form) {
      injectHoneypot(form);
      injectTimestamp(form);
      injectSiteId(form);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
