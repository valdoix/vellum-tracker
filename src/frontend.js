/**
 * VELLUM Tracker — frontend
 * Draggable, resizable, illuminated FLOATING WINDOW rendering the parsed
 * <ledger> + [BTS] state of the latest VELLUM turn.
 * @param {import('lumiverse-spindle-types').SpindleFrontendContext} ctx
 */
export function setup(ctx) {
  try {
    return _setupImpl(ctx);
  } catch (err) {
    const msg = (err && (err.stack || err.message)) ? (err.stack || err.message) : String(err);
    try { console.error('[vellum_tracker] setup() threw:', err); } catch (e) {}
    try { ctx.sendToBackend({ type: 'vellum_setup_error', error: String(msg).slice(0, 800) }); } catch (e) {}
    // visible banner so the failure is not silent
    try {
      const b = document.createElement('div');
      b.textContent = 'VELLUM setup error: ' + String(msg).slice(0, 300);
      b.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:999999;max-width:420px;background:#2a1416;color:#f0c0c0;border:1px solid #a55;border-radius:8px;padding:10px 12px;font:12px/1.4 monospace;white-space:pre-wrap';
      document.body.appendChild(b);
      setTimeout(() => b.remove(), 30000);
    } catch (e) {}
    return () => {};
  }
}

function _setupImpl(ctx) {
  const removeStyle = ctx.dom.addStyle(VELLUM_CSS);
  _ctx = ctx;

  const win = document.createElement('div');
  win.className = 'vlm-window vlm-hidden';
  win.innerHTML = WINDOW_HTML;
  document.body.appendChild(win);

  const body = win.querySelector('[data-body]');
  const dot = win.querySelector('[data-dot]');
  let lastData = null;
  let visible = false;
  let userClosed = false;
  let currentChatId = null;
  _getChatId = () => currentChatId;

  function show() { visible = true; userClosed = false; win.classList.remove('vlm-hidden'); requestRefresh(); }
  function hide() { visible = false; userClosed = true; win.classList.add('vlm-hidden'); }
  function toggle() { visible ? hide() : show(); }

  // Ask the backend for the cached state of the current chat. The backend is the
  // single source of truth — it parses every GENERATION_ENDED, so we never re-parse
  // stale content on the frontend.
  function requestRefresh() {
    ctx.sendToBackend({ type: 'get_state', chatId: currentChatId });
    ctx.sendToBackend({ type: 'get_pulse', chatId: currentChatId });
    // Window refresh also re-pulls the chronicle/cast/tree + toggles so the ⟳
    // button fully refreshes everything, not just the live window state.
    requestChronicle();
  }

  // ---- entry points: drawer tab + input-bar button both toggle the window ----
  const tab = ctx.ui.registerDrawerTab({
    id: 'vellum-tracker-tab',
    title: 'VELLUM Tracker',
    shortName: 'VELLUM',
    description: 'Open the floating ledger window',
    keywords: ['tracker', 'ledger', 'bts', 'vellum', 'state'],
    headerTitle: 'VELLUM Tracker',
    iconSvg: ICON_SVG,
  });
  const tabPanel = document.createElement('div');
  tabPanel.className = 'vlc-root';
  tabPanel.setAttribute('data-view', 'all');
  tabPanel.innerHTML = CHRONICLE_HTML;
  tab.root.appendChild(tabPanel);

  const chronicleBody = tabPanel.querySelector('[data-vlc-body]');
  let chronicleData = null;

  // Delegated: Deep Recall toggle lives inside the re-rendered injection panel.
  chronicleBody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-vlc-deep]');
    if (btn) {
      ctx.sendToBackend({ type: 'set_deep_recall', chatId: currentChatId, enabled: !_deepOn });
      btn.textContent = '…';
      return;
    }
    const hideBtn = e.target.closest('[data-vlc-hide]');
    if (hideBtn) {
      ctx.sendToBackend({ type: 'set_hide_summarized', chatId: currentChatId, enabled: !_hideOn });
      hideBtn.textContent = '…';
      return;
    }
    const scanK = e.target.closest('[data-scan-knowledge]');
    if (scanK) {
      scanK.disabled = true; scanK.textContent = '⏳ Scanning…';
      ctx.sendToBackend({ type: 'scan_knowledge', chatId: currentChatId });
      clearTimeout(scanK._t); scanK._t = setTimeout(() => { scanK.disabled = false; scanK.textContent = '🔑 Scan knowledge'; }, 300000);
      return;
    }
    const delK = e.target.closest('[data-know-del]');
    if (delK) {
      ctx.sendToBackend({ type: 'knowledge_delete', chatId: currentChatId, kind: delK.getAttribute('data-know-del'), id: delK.getAttribute('data-id') || undefined, index: parseInt(delK.getAttribute('data-i'), 10) });
      return;
    }
  });

  // ---- separate Cast tab ----
  const castTab = ctx.ui.registerDrawerTab({
    id: 'vellum-cast-tab',
    title: 'VELLUM Cast',
    shortName: 'CAST',
    description: 'Characters in the narrative — present, active, mentioned, and your own',
    keywords: ['cast', 'characters', 'roster', 'who', 'vellum', 'people'],
    headerTitle: 'VELLUM Cast',
    iconSvg: CAST_ICON_SVG,
  });
  const castRoot = document.createElement('div');
  castRoot.className = 'vlc-root';
  castRoot.setAttribute('data-view', 'all');
  castRoot.innerHTML = CAST_HTML;
  castTab.root.appendChild(castRoot);
  const castBody = castRoot.querySelector('[data-cast-body]');
  let castData = null;
  // Delegated: Memory Journal scan + per-entry delete (cast body re-renders).
  castBody.addEventListener('click', (e) => {
    const scanM = e.target.closest('[data-scan-mem]');
    if (scanM) {
      scanM.disabled = true; scanM.textContent = '⏳ Scanning…';
      ctx.sendToBackend({ type: 'scan_memjournal', chatId: currentChatId });
      clearTimeout(scanM._t); scanM._t = setTimeout(() => { scanM.disabled = false; scanM.textContent = '📖 Scan memories'; }, 300000);
      return;
    }
    const delM = e.target.closest('[data-mj-del]');
    if (delM) {
      ctx.sendToBackend({ type: 'mem_delete', chatId: currentChatId, charKey: delM.getAttribute('data-mj-del'), id: delM.getAttribute('data-id') || undefined, index: parseInt(delM.getAttribute('data-i'), 10) });
      return;
    }
    const mjF = e.target.closest('[data-mj-filter]');
    if (mjF) {
      _mjFilter[mjF.getAttribute('data-mj-filter')] = mjF.getAttribute('data-w') || 'all';
      if (castData) renderCast(castBody, castData);
      return;
    }
    const sortB = e.target.closest('[data-sort]');
    if (sortB) {
      _sortDir = sortB.getAttribute('data-sort') === 'asc' ? 'asc' : 'desc';
      if (castData) renderCast(castBody, castData);
      return;
    }
    const A = (el, n) => el.getAttribute(n) || '';
    // Memory-journal add/edit (these rows live in the cast body).
    let mb = e.target.closest('[data-mj-add]');
    if (mb) { const who = A(mb, 'data-who');
      vlcFormModal('New Memory \u2014 ' + who, [
        { key: 'memory', label: 'Memory', type: 'textarea', placeholder: 'what ' + who + ' remembers' },
        { key: 'about', label: 'About whom', type: 'text', placeholder: 'who/what it concerns (optional)' },
        { key: 'weight', label: 'Weight', type: 'select', value: 'minor', options: WEIGHT_OPTS },
        { key: 'sentiment', label: 'Sentiment', type: 'select', value: 'neutral', options: SENT_OPTS },
      ], (v) => { if (v.memory && v.memory.trim()) ctx.sendToBackend({ type: 'mem_add', chatId: currentChatId, entry: Object.assign({ who }, v) }); });
      return; }
    mb = e.target.closest('[data-mj-edit]');
    if (mb) { e.preventDefault(); e.stopPropagation();
      vlcFormModal('Edit Memory', [
        { key: 'memory', label: 'Memory', type: 'textarea', value: A(mb, 'data-memory') },
        { key: 'about', label: 'About whom', type: 'text', value: A(mb, 'data-about') },
        { key: 'weight', label: 'Weight', type: 'select', value: A(mb, 'data-weight') || 'minor', options: WEIGHT_OPTS },
        { key: 'sentiment', label: 'Sentiment', type: 'select', value: A(mb, 'data-sentiment') || 'neutral', options: SENT_OPTS },
      ], (v) => ctx.sendToBackend({ type: 'mem_edit', chatId: currentChatId, charKey: A(mb, 'data-key'), id: A(mb, 'data-id'), entry: v }));
      return; }
    // Relations CRUD + filter (rendered in the cast body).
    const relF = e.target.closest('[data-rel-filter]');
    if (relF) { _relFilter = relF.getAttribute('data-rel-filter') || 'all'; if (castData) renderCast(castBody, castData); return; }
    let rb = e.target.closest('[data-relation-add]');
    if (rb) {
      vlcFormModal('New Relation', [
        { key: 'a', label: 'Character A', type: 'text', placeholder: 'name (the subject)' },
        { key: 'label', label: 'Relation (from A\u2019s side)', type: 'text', placeholder: "e.g. Tywin's daughter / betrothed to Daeron" },
        { key: 'b', label: 'Character B', type: 'text', placeholder: 'the other person' },
        { key: 'categories', label: 'Categories (one or more)', type: 'checks', value: [], options: REL_CAT_MULTI_OPTS },
        { key: 'status', label: 'Status', type: 'select', value: 'active', options: REL_STATUS_OPTS },
        { key: 'sentiment', label: 'Sentiment', type: 'select', value: 'neutral', options: REL_SENT_OPTS },
      ], (v) => { if (v.a && v.a.trim() && v.b && v.b.trim()) { v.categories = splitCats(v.categories); ctx.sendToBackend({ type: 'relation_add', chatId: currentChatId, entry: v }); } });
      return; }
    rb = e.target.closest('[data-relation-edit]');
    if (rb) {
      vlcFormModal('Edit Relation', [
        { key: 'a', label: 'Character A', type: 'text', value: A(rb, 'data-a') },
        { key: 'label', label: 'Relation (from A\u2019s side)', type: 'text', value: A(rb, 'data-label') },
        { key: 'b', label: 'Character B', type: 'text', value: A(rb, 'data-b') },
        { key: 'categories', label: 'Categories (one or more)', type: 'checks', value: A(rb, 'data-categories') || A(rb, 'data-category') || 'neutral', options: REL_CAT_MULTI_OPTS },
        { key: 'status', label: 'Status', type: 'select', value: A(rb, 'data-status') || 'active', options: REL_STATUS_OPTS },
        { key: 'affection', label: 'Affection (-100..100)', type: 'text', value: A(rb, 'data-affection') || '0' },
        { key: 'trust', label: 'Trust (-100..100)', type: 'text', value: A(rb, 'data-trust') || '0' },
      ], (v) => { v.categories = splitCats(v.categories); ctx.sendToBackend({ type: 'relation_edit', chatId: currentChatId, id: A(rb, 'data-id'), entry: v }); });
      return; }
    rb = e.target.closest('[data-relation-del]');
    if (rb) { if (confirm('Delete this relation?')) ctx.sendToBackend({ type: 'relation_delete', chatId: currentChatId, id: A(rb, 'data-id') }); return; }
  });
  wireCastTab(ctx, castRoot, castBody, () => currentChatId, (id) => { currentChatId = id; });

  tabPanel.querySelector('[data-vlc-open]').addEventListener('click', show);
  tabPanel.querySelector('[data-vlc-refresh]').addEventListener('click', () => {
    requestChronicle();
  });
  const rebuildBtn = tabPanel.querySelector('[data-vlc-rebuild]');
  rebuildBtn.addEventListener('click', () => {
    rebuildBtn.disabled = true;
    rebuildBtn.textContent = '⏳ Scanning history…';
    // The backend reads the RAW stored message history itself (regex-proof);
    // we still pass a DOM-scraped fallback in case that API is unavailable.
    const messages = collectHistory();
    ctx.sendToBackend({ type: 'rebuild_chronicle', chatId: currentChatId, messages });
    // safety reset if the backend never answers
    clearTimeout(rebuildBtn._t);
    rebuildBtn._t = setTimeout(() => { rebuildBtn.disabled = false; rebuildBtn.textContent = '⟲ Rescan full history'; }, 8000);
  });
  const summBtn = tabPanel.querySelector('[data-vlc-summarize]');
  if (summBtn) summBtn.addEventListener('click', () => {
    summBtn.disabled = true;
    summBtn.textContent = '⏳ Summarizing…';
    ctx.sendToBackend({ type: 'summarize_all', chatId: currentChatId });
    // long safety reset — backfill can run many LLM calls
    clearTimeout(summBtn._t);
    summBtn._t = setTimeout(() => { summBtn.disabled = false; summBtn.textContent = '✦ Summarize past turns'; }, 180000);
  });
  // filter tabs
  tabPanel.querySelectorAll('[data-vlc-filter]').forEach((b) => {
    b.addEventListener('click', () => {
      tabPanel.querySelectorAll('[data-vlc-filter]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      tabPanel.setAttribute('data-view', b.getAttribute('data-vlc-filter'));
    });
  });

  // Import chat history: pick a file, read it, ship the raw text to the backend.
  const importBtn = tabPanel.querySelector('[data-vlc-import]');
  const importFile = tabPanel.querySelector('[data-vlc-import-file]');
  if (importBtn && importFile) {
    importBtn.addEventListener('click', () => { importFile.value = ''; importFile.click(); });
    importFile.addEventListener('change', () => {
      const f = importFile.files && importFile.files[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) { importBtn.textContent = '⚠ File too large (max 8MB)'; setTimeout(() => { importBtn.textContent = '⬆ Import chat history'; }, 4000); return; }
      const reader = new FileReader();
      reader.onload = () => {
        importBtn.disabled = true;
        importBtn.textContent = '⏳ Importing…';
        ctx.sendToBackend({ type: 'import_history', chatId: currentChatId, text: String(reader.result || '') });
        clearTimeout(importBtn._t);
        importBtn._t = setTimeout(() => { importBtn.disabled = false; importBtn.textContent = '⬆ Import chat history'; }, 180000);
      };
      reader.onerror = () => { importBtn.textContent = '⚠ Could not read file'; setTimeout(() => { importBtn.textContent = '⬆ Import chat history'; }, 4000); };
      reader.readAsText(f);
    });
  }

  // Clear all data: two-click confirm, then wipe the chronicle for this chat.
  const clearAllBtn = tabPanel.querySelector('[data-vlc-clear-all]');
  if (clearAllBtn) clearAllBtn.addEventListener('click', () => {
    if (clearAllBtn._armed) {
      clearAllBtn._armed = false;
      clearTimeout(clearAllBtn._t);
      clearAllBtn.disabled = true;
      clearAllBtn.textContent = '⏳ Clearing…';
      ctx.sendToBackend({ type: 'clear_all', chatId: currentChatId });
      clearAllBtn._t2 = setTimeout(() => { clearAllBtn.disabled = false; clearAllBtn.textContent = '🗑 Clear all data'; }, 8000);
    } else {
      clearAllBtn._armed = true;
      clearAllBtn.classList.add('armed');
      clearAllBtn.textContent = '⚠ Click again to erase everything';
      clearAllBtn._t = setTimeout(() => { clearAllBtn._armed = false; clearAllBtn.classList.remove('armed'); clearAllBtn.textContent = '🗑 Clear all data'; }, 4000);
    }
  });

  function requestChronicle() { ctx.sendToBackend({ type: 'get_chronicle', chatId: currentChatId }); ctx.sendToBackend({ type: 'get_injection', chatId: currentChatId }); ctx.sendToBackend({ type: 'get_deep_recall', chatId: currentChatId }); ctx.sendToBackend({ type: 'get_hide_summarized', chatId: currentChatId }); ctx.sendToBackend({ type: 'get_memtree', chatId: currentChatId }); }

  // Best-effort scrape of the visible transcript so a rebuild has data even if
  // the backend's cached interceptor array is empty (e.g. just after reload).
  function collectHistory() {
    try {
      const nodes = document.querySelectorAll('[data-message-id], .message, .mes');
      const out = [];
      nodes.forEach((n) => {
        const txt = n.getAttribute('data-raw') || n.textContent || '';
        if (/<ledger>|\[BTS/i.test(txt)) out.push({ role: 'assistant', content: txt });
      });
      return out;
    } catch (e) { return []; }
  }

  let inputBtn = null;
  try {
    inputBtn = ctx.ui.registerInputBarAction({
      id: 'vellum-tracker-toggle',
      title: 'VELLUM Ledger',
      iconSvg: ICON_SVG,
      onClick: toggle,
    });
  } catch (e) { /* input-bar action optional */ }

  wireWindowControls(win, hide, requestRefresh);
  makeDraggable(win, win.querySelector('[data-drag]'));
  makeResizable(win, win.querySelector('[data-resize]'));

  // ---- Theming: skin (shape/layout) + custom accent color ----
  const VELLUM_SKINS = ['vellum', 'parchment', 'phone', 'vn', 'codex', 'grimoire'];
  const SKIN_LABEL = { vellum: 'Vellum', parchment: 'Parchment', phone: 'Phone', vn: 'Visual Novel', codex: 'Codex', grimoire: 'Grimoire' };
  const themedEls = () => [win, tabPanel, castRoot].filter(Boolean);
  // Fixed base palette (gilt) supplies the default CSS vars; the custom color
  // picker overrides them. There is no palette cycle anymore.
  themedEls().forEach((el) => el.classList.add('vlt-gilt'));

  // hex -> "r,g,b" for the rgba(var(--vacc)) usages
  function hexToRgb(hex) {
    let h = String(hex || '').trim().replace(/^#/, '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16);
  }
  // lighten/darken a hex toward white/black by t (-1..1); + lightens, - darkens
  function shadeHex(hex, t) {
    const rgb = hexToRgb(hex); if (!rgb) return hex;
    const [r, g, b] = rgb.split(',').map(Number);
    const mix = (c) => t >= 0 ? Math.round(c + (255 - c) * t) : Math.round(c * (1 + t));
    return '#' + [mix(r), mix(g), mix(b)].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('');
  }
  function lightenHex(hex, t) { return shadeHex(hex, t); }

  // Full custom theme: accent + background + text + font. Any subset may be set;
  // unset keys fall back to the skin/base defaults. Persisted as JSON.
  const FONT_STACKS = {
    '': '',
    serif: "'Cormorant Garamond', Georgia, serif",
    mono: "'JetBrains Mono', Consolas, monospace",
    sans: "'Inter', system-ui, sans-serif",
    rounded: "'Quicksand', 'Comfortaa', system-ui, sans-serif",
    slab: "'Roboto Slab', Georgia, serif",
  };
  let _theme = { accent: null, bg: null, text: null, font: '', size: 100 };
  // A dedicated <style> element carries the text/font overrides at high
  // specificity with !important, because per-element skin rules (e.g. parchment
  // sets its own color, and .vlm-body/titles set their own font-family) would
  // otherwise beat an inline style on the container.
  let _themeStyleEl = null;
  function ensureThemeStyle() {
    if (_themeStyleEl && _themeStyleEl.isConnected) return _themeStyleEl;
    _themeStyleEl = document.createElement('style');
    _themeStyleEl.id = 'vellum-custom-theme';
    document.head.appendChild(_themeStyleEl);
    return _themeStyleEl;
  }
  function applyTheme2() {
    themedEls().forEach((el) => {
      // accent (CSS vars cascade fine via inline style)
      if (_theme.accent && hexToRgb(_theme.accent)) {
        const rgb = hexToRgb(_theme.accent), solid = shadeHex(_theme.accent, 0.18);
        el.style.setProperty('--vacc', rgb);
        el.style.setProperty('--vsolid', solid);
        el.style.setProperty('--vsec', rgb);
        el.style.setProperty('--vsolid2', solid);
      } else { ['--vacc', '--vsolid', '--vsec', '--vsolid2'].forEach((v) => el.style.removeProperty(v)); }
    });
    // text color + font need !important descendant rules to override skin/base.
    const rules = [];
    const scopes = '.vlm-window, .vlc-root';
    if (_theme.text && hexToRgb(_theme.text)) {
      // recolor body text and most text elements, but leave accent-colored
      // headers/labels alone so the accent still reads.
      rules.push(scopes + ', .vlm-window .vlm-body, .vlc-root .vlc-body, '
        + '.vlm-chip-v, .vlm-actor-n, .vlm-doing, .vlm-attr-v, .vlm-mind-t, .vlm-list li, .vlm-title-lg'
        + '{color:' + _theme.text + ' !important}');
    }
    const stack = FONT_STACKS[_theme.font] || '';
    if (stack) {
      // force the font across the window/tabs and every descendant.
      rules.push(scopes + ', .vlm-window *, .vlc-root *{font-family:' + stack + ' !important}');
    }
    // font size: child elements all use explicit px, so scaling the body's
    // font-size won't cascade. Use `zoom` on the scroll container, which scales
    // the rendered size of every descendant regardless of its px value.
    // Scoped to the FLOATING WINDOW only — the chronicle/cast drawer tabs keep
    // their default size for legibility.
    const sz = Number(_theme.size) || 100;
    if (sz !== 100) {
      const f = (sz / 100).toFixed(3);
      rules.push('.vlm-window .vlm-body{zoom:' + f + '}');
    }
    ensureThemeStyle().textContent = rules.join('\n');
    // background only applies to the floating window (tabs live in the drawer)
    if (_theme.bg && hexToRgb(_theme.bg)) {
      const acc = _theme.accent && hexToRgb(_theme.accent) ? hexToRgb(_theme.accent) : '205,168,78';
      win.style.background = 'radial-gradient(130% 90% at 0% 0%,rgba(' + acc + ',.12),transparent 55%),linear-gradient(165deg,' + shadeHex(_theme.bg, -0.12) + ',' + shadeHex(_theme.bg, 0.04) + ')';
    } else { win.style.removeProperty('background'); }
    try { localStorage.setItem('vellum_theme_custom', JSON.stringify(_theme)); } catch (e) {}
  }
  function resetTheme2() {
    _theme = { accent: null, bg: null, text: null, font: '', size: 100 };
    themedEls().forEach((el) => { ['--vacc', '--vsolid', '--vsec', '--vsolid2'].forEach((v) => el.style.removeProperty(v)); });
    if (_themeStyleEl) _themeStyleEl.textContent = '';
    win.style.removeProperty('background');
    try { localStorage.removeItem('vellum_theme_custom'); localStorage.removeItem('vellum_color'); } catch (e) {}
  }

  function applySkin(name) {
    const s = VELLUM_SKINS.includes(name) ? name : 'vellum';
    themedEls().forEach((el) => {
      VELLUM_SKINS.forEach((x) => el.classList.remove('vls-' + x));
      el.classList.add('vls-' + s);
    });
    try { localStorage.setItem('vellum_skin', s); } catch (e) {}
  }

  let _skinIdx = 0;
  try { const sv = localStorage.getItem('vellum_skin'); if (sv && VELLUM_SKINS.includes(sv)) _skinIdx = VELLUM_SKINS.indexOf(sv); } catch (e) {}
  applySkin(VELLUM_SKINS[_skinIdx]);
  // Load saved custom theme (new multi-key, with legacy accent-only fallback).
  try {
    const j = localStorage.getItem('vellum_theme_custom');
    if (j) { const o = JSON.parse(j); _theme = { accent: o.accent || null, bg: o.bg || null, text: o.text || null, font: o.font || '', size: Number(o.size) || 100 }; }
    else { const legacy = localStorage.getItem('vellum_color'); if (legacy) _theme.accent = legacy; }
  } catch (e) {}
  applyTheme2();

  const skinBtn = win.querySelector('[data-skin]');
  if (skinBtn) skinBtn.addEventListener('click', () => {
    _skinIdx = (_skinIdx + 1) % VELLUM_SKINS.length;
    applySkin(VELLUM_SKINS[_skinIdx]);
    skinBtn.title = 'Skin: ' + (SKIN_LABEL[VELLUM_SKINS[_skinIdx]] || VELLUM_SKINS[_skinIdx]);
  });
  // ---- Window tabs (Scene / Minds / Story / Backstage / Pulse) ----
  let _livingOn = false;
  const WIN_TABS = ['scene', 'minds', 'story', 'backstage', 'pulse'];
  function applyWinTab(name) {
    const t = WIN_TABS.includes(name) ? name : 'scene';
    win.setAttribute('data-wintab', t);
    win.querySelectorAll('[data-wintab-btn]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-wintab-btn') === t));
    try { localStorage.setItem('vellum_wintab', t); } catch (e) {}
    if (t === 'pulse' && win._onPulseTab) win._onPulseTab();
  }
  let _winTab = 'scene';
  try { const sv = localStorage.getItem('vellum_wintab'); if (sv && WIN_TABS.includes(sv)) _winTab = sv; } catch (e) {}
  applyWinTab(_winTab);
  win.querySelectorAll('[data-wintab-btn]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    applyWinTab(b.getAttribute('data-wintab-btn'));
  }));
  // Custom theme popover (accent / background / text / font)
  const colorBtn = win.querySelector('[data-color]');
  const colorPop = win.querySelector('[data-colorpop]');
  if (colorBtn && colorPop) {
    const q = (sel) => colorPop.querySelector(sel);
    const accW = q('[data-cp-accent]'), accH = q('[data-cp-accent-hex]');
    const bgW = q('[data-cp-bg]'), bgH = q('[data-cp-bg-hex]');
    const txW = q('[data-cp-text]'), txH = q('[data-cp-text-hex]');
    const fontSel = q('[data-cp-font]');
    const sizeSl = q('[data-cp-size]'); const sizeVal = q('[data-cp-size-val]');
    const cpSwatches = q('[data-cp-swatches]');
    const PRESET_SWATCHES = ['#cda84e', '#9bc0e6', '#e89bb0', '#7fd0a0', '#c4ccd8', '#f0a05a', '#b48ed0', '#d86a6a', '#6fb0a6', '#e6c07a'];
    if (cpSwatches) cpSwatches.innerHTML = PRESET_SWATCHES.map((c) => '<button class="vlm-cp-s" data-cp-pick="' + c + '" style="background:' + c + '" title="' + c + '"></button>').join('');
    const syncUI = () => {
      if (accW) accW.value = _theme.accent || '#cda84e';
      if (accH) accH.value = _theme.accent || '';
      if (bgW) bgW.value = _theme.bg || '#171511';
      if (bgH) bgH.value = _theme.bg || '';
      if (txW) txW.value = _theme.text || '#d8c9a8';
      if (txH) txH.value = _theme.text || '';
      if (fontSel) fontSel.value = _theme.font || '';
      if (sizeSl) sizeSl.value = _theme.size || 100;
      if (sizeVal) sizeVal.textContent = (_theme.size || 100) + '%';
    };
    const norm = (v) => { const s = String(v || '').trim(); if (!s) return null; const h = s.replace(/^#?/, '#'); return hexToRgb(h) ? h : null; };

    colorBtn.addEventListener('click', (e) => { e.stopPropagation(); colorPop.hidden = !colorPop.hidden; if (!colorPop.hidden) syncUI(); });
    colorPop.addEventListener('click', (e) => e.stopPropagation());

    if (accW) accW.addEventListener('input', () => { _theme.accent = accW.value; if (accH) accH.value = accW.value; applyTheme2(); });
    if (accH) accH.addEventListener('change', () => { _theme.accent = norm(accH.value); applyTheme2(); syncUI(); });
    if (bgW) bgW.addEventListener('input', () => { _theme.bg = bgW.value; if (bgH) bgH.value = bgW.value; applyTheme2(); });
    if (bgH) bgH.addEventListener('change', () => { _theme.bg = norm(bgH.value); applyTheme2(); syncUI(); });
    if (txW) txW.addEventListener('input', () => { _theme.text = txW.value; if (txH) txH.value = txW.value; applyTheme2(); });
    if (txH) txH.addEventListener('change', () => { _theme.text = norm(txH.value); applyTheme2(); syncUI(); });
    if (fontSel) fontSel.addEventListener('change', () => { _theme.font = fontSel.value; applyTheme2(); });
    if (sizeSl) sizeSl.addEventListener('input', () => { _theme.size = Number(sizeSl.value) || 100; if (sizeVal) sizeVal.textContent = _theme.size + '%'; applyTheme2(); });
    if (cpSwatches) cpSwatches.addEventListener('click', (e) => { const b = e.target.closest('[data-cp-pick]'); if (b) { _theme.accent = b.getAttribute('data-cp-pick'); applyTheme2(); syncUI(); } });

    const applyB = q('[data-cp-apply]'); if (applyB) applyB.addEventListener('click', () => { colorPop.hidden = true; });
    const resetB = q('[data-cp-reset]'); if (resetB) resetB.addEventListener('click', () => { resetTheme2(); syncUI(); });
    document.addEventListener('click', () => { if (!colorPop.hidden) colorPop.hidden = true; });
    // Living tracker toggle (inside the customizer popover).
    const livingBtn = q('[data-cp-living]');
    if (livingBtn) livingBtn.addEventListener('click', (e) => { e.stopPropagation(); ctx.sendToBackend({ type: 'set_living', chatId: currentChatId, enabled: !_livingOn }); livingBtn.textContent = '…'; });
    win._livingBtn = livingBtn;
  }

  // ---- Pulse: notifications + activity feed ----
  let _pulse = [];           // full event list for the Pulse tab
  let _unseen = 0;
  const toastWrap = win.querySelector('[data-toasts]');
  const pulseBadge = win.querySelector('[data-pulse-badge]');
  function pulseIcon(ev) { return ev.icon || { knowledge: '◇', secret: '⚿', relation: '↔', memory: '📖' }[ev.kind] || '✦'; }
  function setUnseen(n) {
    _unseen = Math.max(0, n | 0);
    if (!pulseBadge) return;
    if (_unseen > 0 && win.getAttribute('data-wintab') !== 'pulse') { pulseBadge.textContent = _unseen > 99 ? '99+' : String(_unseen); pulseBadge.hidden = false; }
    else pulseBadge.hidden = true;
  }
  function showToast(ev) {
    if (!toastWrap) return;
    const el = document.createElement('div');
    el.className = 'vlm-toast vlm-toast-' + (ev.kind || 'info') + (ev.big ? ' big' : '');
    el.innerHTML = '<span class="vlm-toast-i">' + escapeHtml(pulseIcon(ev)) + '</span><span class="vlm-toast-t">' + escapeHtml(ev.text || '') + '</span>';
    toastWrap.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    const life = ev.big ? 7000 : 5000;
    const kill = () => { el.classList.remove('in'); setTimeout(() => el.remove(), 250); };
    el.addEventListener('click', kill);
    setTimeout(kill, life);
    // cap stacked toasts
    while (toastWrap.children.length > 4) toastWrap.removeChild(toastWrap.firstChild);
  }
  function renderPulsePanel() {
    const host = body.querySelector('[data-panel="pulse"]');
    if (!host) return;
    if (!_pulse.length) { host.innerHTML = emptyPanel('No activity yet. Enable the Living tracker (✦ → Living tracker) to auto-record relationship shifts, new knowledge, secrets, and memories as they happen.'); return; }
    const kindCls = { knowledge: 'pk-know', secret: 'pk-sec', relation: 'pk-rel', memory: 'pk-mem' };
    const rows = _pulse.slice().reverse().slice(0, 80).map((ev) =>
      '<div class="vlm-pulse-row ' + (kindCls[ev.kind] || '') + '">'
      + '<span class="vlm-pulse-i">' + escapeHtml(pulseIcon(ev)) + '</span>'
      + '<div class="vlm-pulse-b"><div class="vlm-pulse-t">' + escapeHtml(ev.text || '') + '</div>'
      + '<div class="vlm-pulse-m">turn ' + (ev.turn || 0) + (ev.day ? ' · day ' + ev.day : '') + ' · ' + (ev.kind || '') + '</div></div></div>'
    ).join('');
    host.innerHTML = '<div class="vlm-pulse-bar"><span>' + _pulse.length + ' events</span><button class="vlm-pulse-clear" data-pulse-clear>Clear</button></div>' + rows;
    const clr = host.querySelector('[data-pulse-clear]');
    if (clr) clr.addEventListener('click', () => ctx.sendToBackend({ type: 'pulse_clear', chatId: currentChatId }));
  }
  win._renderPulsePanel = renderPulsePanel;
  win._onPulseTab = () => { if (_unseen) { ctx.sendToBackend({ type: 'pulse_seen', chatId: currentChatId }); setUnseen(0); } };

  const unsubBackend = ctx.onBackendMessage((p) => {
    if (p?.type === 'vellum_tracker_update') {
      lastData = p;
      if (p.chatId) currentChatId = p.chatId;
      render(body, dot, p);
      renderPulsePanel();
      // Ledger + backstage are hidden from chat, so surface the window
      // automatically the first time real state arrives.
      const hasState = (p.ledger && p.ledger.raw) || p.bts;
      if (hasState && !visible && !userClosed) {
        visible = true; win.classList.remove('vlm-hidden');
      }
      if (visible && tab.setBadge) tab.setBadge('●');
    } else if (p?.type === 'vellum_tracker_empty') {
      // No cached state yet for this chat; keep whatever is shown.
      if (!lastData) { render(body, dot, null); renderPulsePanel(); }
    } else if (p?.type === 'vellum_pulse') {
      // live notifications from the living tracker
      if (Array.isArray(p.events)) {
        for (const ev of p.events) { _pulse.push(ev); showToast(ev); }
        if (_pulse.length > 200) _pulse = _pulse.slice(-200);
      }
      setUnseen(typeof p.unseen === 'number' ? p.unseen : _unseen + (p.events ? p.events.length : 0));
      renderPulsePanel();
    } else if (p?.type === 'vellum_pulse_list') {
      _pulse = Array.isArray(p.events) ? p.events : [];
      _livingOn = !!p.living;
      if (win._livingBtn) win._livingBtn.textContent = _livingOn ? 'ON' : 'OFF';
      if (win._livingBtn) win._livingBtn.classList.toggle('on', _livingOn);
      setUnseen(p.unseen || 0);
      renderPulsePanel();
    } else if (p?.type === 'vellum_pulse_unseen') {
      setUnseen(p.unseen || 0);
    } else if (p?.type === 'vellum_living') {
      _livingOn = !!p.enabled;
      if (win._livingBtn) { win._livingBtn.textContent = _livingOn ? 'ON' : 'OFF'; win._livingBtn.classList.toggle('on', _livingOn); }
    } else if (p?.type === 'vellum_chronicle') {
      chronicleData = p.chronicle;
      renderChronicle(chronicleBody, p.chronicle);
      castData = p.chronicle;
      renderCast(castBody, p.chronicle);
    } else if (p?.type === 'vellum_injection') {
      _lastInjection = p.injection;
      const host = chronicleBody && chronicleBody.querySelector('[data-vlc-inj]');
      if (host) host.innerHTML = injectionHtml(_lastInjection);
    } else if (p?.type === 'vellum_deep_recall') {
      _deepOn = !!p.enabled;
      const host = chronicleBody && chronicleBody.querySelector('[data-vlc-inj]');
      if (host) host.innerHTML = injectionHtml(_lastInjection);
    } else if (p?.type === 'vellum_hide_summarized') {
      _hideOn = !!p.enabled;
      _hideInfo = { covered: p.covered || 0, memories: p.memories || 0 };
      const host = chronicleBody && chronicleBody.querySelector('[data-vlc-inj]');
      if (host) host.innerHTML = injectionHtml(_lastInjection);
    } else if (p?.type === 'vellum_memtree' || p?.type === 'vellum_memtree_done') {
      _memTree = { arcs: p.arcs || [], unassigned: p.unassigned || [], index: p.index || {}, builtAt: p.builtAt || 0, chapters: p.chapters || 0 };
      const mh = chronicleBody && chronicleBody.querySelector('[data-vlc-memtree]');
      if (mh) mh.innerHTML = memTreeHtml(_memTree);
      if (p.type === 'vellum_memtree_done') {
        const b = chronicleBody && chronicleBody.querySelector('[data-memtree-build]');
        if (b) { b.textContent = p.ok ? '⟲ Build / Rebuild' : ('⚠ ' + (p.reason || 'error')); setTimeout(() => { b.textContent = '⟲ Build / Rebuild'; }, 3500); }
      }
    } else if (p?.type === 'vellum_memtree_building') {
      const b = chronicleBody && chronicleBody.querySelector('[data-memtree-build]');
      if (b) b.textContent = '⏳ Building…';
    } else if (p?.type === 'vellum_chronicle_empty') {
      if (chronicleBody && !chronicleData) renderChronicle(chronicleBody, null);
      if (castBody && !castData) renderCast(castBody, null);
    } else if (p?.type === 'vellum_cast_done') {
      handleCastDone(castRoot, p);
    } else if (p?.type === 'vellum_mem_progress') {
      const b = castBody && castBody.querySelector('[data-scan-mem]');
      if (b && p.chunks > 1) b.textContent = '⏳ Scanning ' + p.chunk + '/' + p.chunks + '…';
    } else if (p?.type === 'vellum_mem_done') {
      const b = castBody && castBody.querySelector('[data-scan-mem]');
      if (b) { clearTimeout(b._t); b.disabled = false; b.textContent = p.ok ? ('✓ +' + (p.added || 0) + ' memories') : ('⚠ ' + (p.reason || 'error')); setTimeout(() => { b.textContent = '📖 Scan memories'; }, 4000); }
    } else if (p?.type === 'vellum_know_progress') {
      const b = chronicleBody && chronicleBody.querySelector('[data-scan-knowledge]');
      if (b && p.chunks > 1) b.textContent = '⏳ Scanning ' + p.chunk + '/' + p.chunks + '…';
    } else if (p?.type === 'vellum_know_done') {
      const b = chronicleBody && chronicleBody.querySelector('[data-scan-knowledge]');
      if (b) { clearTimeout(b._t); b.disabled = false; b.textContent = p.ok ? ('✓ +' + (p.addedK || 0) + 'k/' + (p.addedS || 0) + 's') : ('⚠ ' + (p.reason || 'error')); setTimeout(() => { b.textContent = '🔑 Scan knowledge'; }, 4000); }
    } else if (p?.type === 'vellum_perms') {
      applyPermBanner(tabPanel, p.granted || []);
      applyPermBanner(castRoot, p.granted || []);
    } else if (p?.type === 'vellum_import_progress') {
      const b = tabPanel.querySelector('[data-vlc-import]');
      if (b) { const stage = { parsing: 'Reading', cast: 'Cast', memory: 'Memories', knowledge: 'Knowledge' }[p.stage] || 'Working'; const prog = (p.chunks && p.chunks > 1) ? (' ' + p.chunk + '/' + p.chunks) : ''; b.textContent = '⏳ ' + stage + prog + '…'; }
    } else if (p?.type === 'vellum_import_done') {
      const b = tabPanel.querySelector('[data-vlc-import]');
      if (b) {
        clearTimeout(b._t);
        b.disabled = false;
        let label = '⬆ Import chat history';
        if (!p.ok) {
          if (p.reason === 'no_active_chat') label = '⚠ No active chat';
          else if (p.reason === 'no_chat_mutation_permission') label = '⚠ Grant "chat_mutation"';
          else if (p.reason === 'empty') label = '⚠ No messages found in file';
          else if (p.reason === 'busy') label = '⏳ Already importing…';
          else label = '⚠ Import failed';
        } else {
          const bits = [];
          if (p.foldedTurns) bits.push(p.foldedTurns + ' turns');
          if (p.cast) bits.push('+' + p.cast + ' cast');
          if (p.memories) bits.push('+' + p.memories + ' mem');
          if (p.knowledge || p.secrets) bits.push('+' + (p.knowledge || 0) + 'k/' + (p.secrets || 0) + 's');
          label = '✓ Imported ' + p.messages + ' msgs' + (bits.length ? ' (' + bits.join(', ') + ')' : '');
          if (p.generated === false) label += ' — enable "generation" for full extraction';
          requestChronicle();
        }
        b.textContent = label;
        setTimeout(() => { b.textContent = '⬆ Import chat history'; }, 6000);
      }
    } else if (p?.type === 'vellum_cleared') {
      const b = tabPanel.querySelector('[data-vlc-clear-all]');
      if (b) {
        clearTimeout(b._t2);
        b.disabled = false;
        b.classList.remove('armed');
        b.textContent = p.ok ? '✓ Cleared' : '⚠ Clear failed';
        setTimeout(() => { b.textContent = '🗑 Clear all data'; }, 3500);
      }
      if (p.ok) { chronicleData = null; castData = null; requestChronicle(); }
    } else if (p?.type === 'vellum_chronicle_rebuilt') {
      if (rebuildBtn) {
        clearTimeout(rebuildBtn._t);
        rebuildBtn.disabled = false;
        let label = '⟲ Rescan full history';
        if (p.reason === 'no_active_chat') label = '⚠ No active chat';
        else if (p.scanned) label = '✓ Scanned ' + (p.turns || 0) + ' turns';
        else label = '⚠ No ledgers found';
        rebuildBtn.textContent = label;
        setTimeout(() => { rebuildBtn.textContent = '⟲ Rescan full history'; }, 3500);
      }
    } else if (p?.type === 'vellum_summary_progress') {
      if (summBtn) summBtn.textContent = '⏳ Summarizing… ' + (p.made || 0);
    } else if (p?.type === 'vellum_summary_done') {
      if (summBtn) {
        clearTimeout(summBtn._t);
        summBtn.disabled = false;
        let label = '✦ Summarize past turns';
        if (!p.ok && p.reason === 'no_active_chat') label = '⚠ No active chat';
        else if (!p.ok && p.reason === 'no_generation_permission') label = '⚠ Grant "generation"';
        else if (!p.ok && p.reason === 'no_chat_mutation_permission') label = '⚠ Grant "chat_mutation"';
        else if (!p.ok && p.reason === 'no_history') label = '⚠ No readable history';
        else if (!p.ok && p.reason === 'gen_failed') label = '⚠ Generation failed';
        else if (!p.ok && p.reason === 'busy') label = '⏳ Already running…';
        else if (!p.ok) label = '⚠ Summary error';
        else if (p.made > 0) label = '✓ Archived ' + p.made + (p.capped ? ' (more left — run again)' : '');
        else label = '✓ Up to date (' + (p.storedTurns != null ? p.storedTurns + ' turns covered' : 'covered') + ')';
        summBtn.textContent = label;
        setTimeout(() => { summBtn.textContent = '✦ Summarize past turns'; }, 4000);
      }
    }
  });
  const unsubGen = ctx.events.on('GENERATION_ENDED', (p) => {
    if (p?.chatId) currentChatId = p.chatId;
    // Backend also listens to GENERATION_ENDED and caches state; this is a
    // belt-and-suspenders parse in case the backend missed the event.
    if (p?.content) ctx.sendToBackend({ type: 'parse_content', content: p.content, chatId: p.chatId });
    // refresh the chronicle view shortly after the turn folds in
    setTimeout(requestChronicle, 400);
  });

  // When the active chat changes, re-pull that chat's cached state so the window
  // never lingers on a previous chat's tracker.
  let unsubChat = () => {};
  try {
    const onChat = (p) => {
      const id = p?.chatId || p?.chat_id || p?.id || null;
      if (id === currentChatId) return; // no-op on same chat
      currentChatId = id;
      // Reset ALL per-chat cached state so a new chat starts visually fresh and
      // never shows the previous chat's chronicle/cast/tree/pulse for a frame.
      lastData = null; chronicleData = null; castData = null;
      _memTree = null; _lastInjection = null; _pulse = []; _unseen = 0;
      _hideInfo = { covered: 0, memories: 0 };
      try {
        render(body, dot, null);
        if (chronicleBody) renderChronicle(chronicleBody, null);
        if (castBody) renderCast(castBody, null);
        renderPulsePanel();
        setUnseen(0);
      } catch (e) {}
      requestRefresh();
      requestChronicle();
    };
    // CHAT_SWITCHED is the real Lumiverse event ({chatId|null}); CHAT_CHANGED is
    // also emitted. Subscribe to both; the host ignores unknown names safely.
    const off1 = ctx.events.on('CHAT_SWITCHED', onChat);
    const off2 = ctx.events.on('CHAT_CHANGED', onChat);
    unsubChat = () => { try { off1 && off1(); } catch (e) {} try { off2 && off2(); } catch (e) {} };
  } catch (e) { /* events optional */ }

  // initial pull — restore both the live window state and the chronicle.
  // get_state resolves the active chat backend-side and falls back to the
  // persisted blob, so the window re-opens even after a worker/frontend reload.
  requestRefresh();
  requestChronicle();
  ctx.sendToBackend({ type: 'check_perms' });

  return () => {
    unsubBackend(); unsubGen(); unsubChat();
    removeStyle();
    try { tab.destroy(); } catch (e) {}
    try { castTab.destroy(); } catch (e) {}
    try { inputBtn && inputBtn.destroy && inputBtn.destroy(); } catch (e) {}
    win.remove();
    ctx.dom.cleanup();
  };
}

function wireWindowControls(win, hide, refresh) {
  win.querySelector('[data-close]').addEventListener('click', hide);
  win.querySelector('[data-min]').addEventListener('click', () => win.classList.toggle('vlm-min'));
  const rb = win.querySelector('[data-refresh]');
  if (rb) rb.addEventListener('click', () => {
    rb.classList.add('vlm-spin');
    setTimeout(() => rb.classList.remove('vlm-spin'), 600);
    if (typeof refresh === 'function') refresh();
  });
}

function makeDraggable(win, handle) {
  let sx = 0, sy = 0, ox = 0, oy = 0, on = false;
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('.vlm-btn') || e.target.closest('.vlm-colorpop')) return;
    on = true;
    const r = win.getBoundingClientRect();
    ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
    win.style.right = 'auto'; win.style.left = ox + 'px'; win.style.top = oy + 'px';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!on) return;
    const nx = Math.max(0, Math.min(window.innerWidth - 80, ox + e.clientX - sx));
    const ny = Math.max(0, Math.min(window.innerHeight - 46, oy + e.clientY - sy));
    win.style.left = nx + 'px'; win.style.top = ny + 'px';
  });
  window.addEventListener('mouseup', () => { on = false; });
}

function makeResizable(win, grip) {
  let sx = 0, sy = 0, sw = 0, sh = 0, on = false;
  grip.addEventListener('mousedown', (e) => {
    on = true;
    const r = win.getBoundingClientRect();
    sw = r.width; sh = r.height; sx = e.clientX; sy = e.clientY;
    e.preventDefault(); e.stopPropagation();
  });
  window.addEventListener('mousemove', (e) => {
    if (!on) return;
    win.style.width = Math.max(260, sw + e.clientX - sx) + 'px';
    win.style.height = Math.max(220, sh + e.clientY - sy) + 'px';
  });
  window.addEventListener('mouseup', () => { on = false; });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Reusable inline edit/add form, styled like the cast/chapter-memory editors.
// `fields`: [{ key, label, type:'text'|'textarea'|'select', value, placeholder,
// options:[{value,label}] }]. Calls onSave(values) with a {key:value} map.
// Renders as a centered overlay panel within the drawer; Esc / Cancel closes.
function vlcFormModal(title, fields, onSave) {
  const prev = document.querySelector('.vlc-formmodal');
  if (prev) prev.remove();
  const overlay = document.createElement('div');
  overlay.className = 'vlc-formmodal';
  const rows = fields.map((f) => {
    const id = 'ff_' + f.key;
    if (f.type === 'textarea') {
      return '<label class="vlc-ff-l">' + escapeHtml(f.label) + '<textarea class="vlc-cf-in vlc-cf-ta" data-ff="' + f.key + '" placeholder="' + escapeHtml(f.placeholder || '') + '">' + escapeHtml(f.value || '') + '</textarea></label>';
    }
    if (f.type === 'select') {
      const opts = (f.options || []).map((o) => '<option value="' + escapeHtml(o.value) + '"' + (String(o.value) === String(f.value) ? ' selected' : '') + '>' + escapeHtml(o.label) + '</option>').join('');
      return '<label class="vlc-ff-l">' + escapeHtml(f.label) + '<select class="vlc-cf-in vlc-cf-sel" data-ff="' + f.key + '">' + opts + '</select></label>';
    }
    if (f.type === 'checks') {
      // multi-select checkbox group; value is an array (or comma string) of
      // currently-checked option values. Collected back into a comma string.
      const sel = Array.isArray(f.value) ? f.value.map(String) : String(f.value || '').split(',').map((s) => s.trim()).filter(Boolean);
      const boxes = (f.options || []).map((o) =>
        '<label class="vlc-ff-chk"><input type="checkbox" data-ff-chk="' + f.key + '" value="' + escapeHtml(o.value) + '"' + (sel.includes(String(o.value)) ? ' checked' : '') + '> ' + escapeHtml(o.label) + '</label>'
      ).join('');
      return '<div class="vlc-ff-l" data-ff-checks="' + f.key + '">' + escapeHtml(f.label) + '<div class="vlc-ff-chkrow">' + boxes + '</div></div>';
    }
    return '<label class="vlc-ff-l">' + escapeHtml(f.label) + '<input class="vlc-cf-in" data-ff="' + f.key + '" placeholder="' + escapeHtml(f.placeholder || '') + '" value="' + escapeHtml(f.value || '') + '"></label>';
  }).join('');
  overlay.innerHTML = '<div class="vlc-formmodal-panel"><div class="vlc-formmodal-h">' + escapeHtml(title) + '</div>'
    + '<div class="vlc-formmodal-body">' + rows + '</div>'
    + '<div class="vlc-cf-btns"><button class="vlc-cf-save" data-ff-save>Save</button><button class="vlc-cf-cancel" data-ff-cancel>Cancel</button></div></div>';
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-ff-cancel]').addEventListener('click', close);
  overlay.querySelector('[data-ff-save]').addEventListener('click', () => {
    const values = {};
    overlay.querySelectorAll('[data-ff]').forEach((el) => { values[el.getAttribute('data-ff')] = el.value; });
    // checkbox groups -> comma-joined string of checked values
    overlay.querySelectorAll('[data-ff-checks]').forEach((grp) => {
      const key = grp.getAttribute('data-ff-checks');
      const on = Array.from(grp.querySelectorAll('[data-ff-chk]')).filter((c) => c.checked).map((c) => c.value);
      values[key] = on.join(',');
    });
    close();
    onSave(values);
  });
  document.body.appendChild(overlay);
  const first = overlay.querySelector('[data-ff]');
  if (first) first.focus();
}

const REL_OPTS = [{ value: 'knows', label: 'knows' }, { value: 'believes', label: 'believes' }, { value: 'suspects', label: 'suspects' }, { value: 'wrong', label: 'wrongly believes' }, { value: 'unaware', label: 'unaware of' }];
const TRUTH_OPTS = [{ value: 'unknown', label: 'unknown' }, { value: 'true', label: 'true' }, { value: 'false', label: 'false' }];
const DANGER_OPTS = [{ value: 'minor', label: 'minor' }, { value: 'major', label: 'major' }, { value: 'explosive', label: 'explosive' }];
const WEIGHT_OPTS = [{ value: 'trivial', label: 'trivial' }, { value: 'minor', label: 'minor' }, { value: 'significant', label: 'significant' }, { value: 'defining', label: 'defining' }];
const SENT_OPTS = [{ value: 'neutral', label: 'neutral' }, { value: 'positive', label: 'positive' }, { value: 'negative', label: 'negative' }, { value: 'complex', label: 'complex' }];
// Category "maturity" rank — mirrors the backend's REL_CAT_RANK so the card
// accent (data-cat) uses the most-defined facet of a multi-category bond.
const REL_RANK = { neutral: 0, social: 1, alliance: 2, rivalry: 2, romantic: 3, familial: 3 };
const REL_CAT_OPTS = [{ value: 'familial', label: 'familial' }, { value: 'romantic', label: 'romantic' }, { value: 'alliance', label: 'alliance' }, { value: 'rivalry', label: 'rivalry' }, { value: 'social', label: 'social' }, { value: 'neutral', label: 'neutral' }];
// Multi-select category options (neutral is the implicit "no real bond" state,
// so it's omitted from the checkbox group — leave all unchecked for neutral).
const REL_CAT_MULTI_OPTS = [{ value: 'familial', label: 'familial' }, { value: 'romantic', label: 'romantic' }, { value: 'alliance', label: 'alliance' }, { value: 'rivalry', label: 'rivalry' }, { value: 'social', label: 'social' }];
// Parse a comma-joined category string from the form into a clean array; an
// empty selection falls back to ['neutral'].
function splitCats(s) {
  const arr = String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return arr.length ? arr : ['neutral'];
}
const REL_STATUS_OPTS = [{ value: 'active', label: 'active' }, { value: 'past', label: 'past' }, { value: 'broken', label: 'broken' }, { value: 'secret', label: 'secret' }];
const REL_SENT_OPTS = [{ value: 'neutral', label: 'neutral' }, { value: 'warm', label: 'warm' }, { value: 'strained', label: 'strained' }, { value: 'hostile', label: 'hostile' }, { value: 'complex', label: 'complex' }];

function splitItems(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/\n|(?=▸)|(?=◉)|(?=•)|(?=::)/)
    .map((s) => s.replace(/^[\s•▸◉\-]+/, '').trim())
    .filter(Boolean);
}

function chipHtml(label, val) {
  if (!val) return '';
  return '<div class="vlm-chip"><span class="vlm-chip-l">' + label + '</span><span class="vlm-chip-v">' + escapeHtml(val) + '</span></div>';
}

function meterHtml(label, value, cls) {
  const n = Math.min(10, Math.max(0, parseInt(value, 10) || 0));
  return '<div class="vlm-m"><div class="vlm-m-top"><span>' + label + '</span><span>' + n + '<i>/10</i></span></div>'
    + '<div class="vlm-track"><div class="vlm-fill ' + (cls || '') + '" style="width:' + (n * 10) + '%"></div></div></div>';
}

function listSecHtml(icon, title, raw) {
  const items = splitItems(raw);
  if (!items.length) return '';
  const lis = items.map((it) => '<li>' + escapeHtml(it) + '</li>').join('');
  return '<div class="vlm-card"><div class="vlm-card-h">' + icon + ' ' + title + '</div><ul class="vlm-list">' + lis + '</ul></div>';
}

// Inner Landscape: each item is "Name: 『verbatim inner thought』".
// Render the name as a gold label and the thought as an italic, quoted line.
function mindSecHtml(icon, title, raw) {
  const items = splitItems(raw);
  if (!items.length) return '';
  const rows = items.map((it) => {
    let name = '';
    let thought = it;
    const m = it.match(/^([^:：『]{1,40})\s*[:：]\s*([\s\S]+)$/);
    if (m) { name = m[1].trim(); thought = m[2].trim(); }
    // strip the 『』 corner brackets (and stray quotes) — we style it instead
    thought = thought.replace(/^[『「"'\s]+/, '').replace(/[』」"'\s]+$/, '');
    const nameHtml = name ? '<span class="vlm-mind-n">' + escapeHtml(name) + '</span>' : '';
    return '<li class="vlm-mind-i">' + nameHtml + '<span class="vlm-mind-t">' + escapeHtml(thought) + '</span></li>';
  }).join('');
  return '<div class="vlm-card"><div class="vlm-card-h">' + icon + ' ' + title + '</div><ul class="vlm-list vlm-mind">' + rows + '</ul></div>';
}

/* ---- Backstage: parse the [BTS] notation into distinct, glanceable sections ---- */
function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Parse one actor descriptor into parts. `knownName` is used when the name
// arrived on its own line and the details follow on the next.
function parseActor(line, knownName) {
  let body = String(line).trim();
  let name = knownName || '';
  if (!name) {
    const dbl = body.match(/^(.+?)\s*::\s*(.+)$/);
    if (dbl && /[@|]/.test(dbl[2])) { name = dbl[1].trim(); body = dbl[2].trim(); }
  }
  const segs = body.split('|').map((s) => s.trim()).filter(Boolean);
  if (!name) {
    if (segs.length && !/^@/.test(segs[0])) name = segs.shift();
  } else if (segs.length && segs[0] === name) {
    segs.shift();
  }
  let loc = '', mood = '', doing = '';
  for (const s of segs) {
    if (/^@/.test(s)) loc = s.replace(/^@\s*/, '');
    else if (!mood) mood = s;
    else doing = doing ? doing + ' · ' + s : s;
  }
  const act = loc.match(/\(([^)]+)\)/);
  if (act) { doing = doing ? act[1] + ' · ' + doing : act[1]; loc = loc.replace(/\([^)]*\)/, '').trim(); }
  if (!name) return null;

  // The model often crams the whole state into a "›"/">"-chained location run:
  //   "Private dining room › wearing borrowed tunic › arousal 8/10 › gripping wine stem"
  // Split that chain: the FIRST fragment is the real place; the rest are
  // categorized into Body/Mind/Appearance/doing so they render as stats.
  const a = { name, loc: '', mood, doing, extras: { body: [], mind: [], appearance: [] } };
  const frags = loc.split(/\s*(?:›|>)\s*/).map((x) => x.trim()).filter(Boolean);
  if (frags.length) {
    a.loc = frags.shift();
    for (const fr of frags) classifyFragment(a, fr);
  }
  return a;
}

// Sort a free-text fragment into a stat category (or the "doing" line).
function classifyFragment(a, fr) {
  const f = fr.trim();
  if (!f) return;
  const low = f.toLowerCase();
  // explicit "key N/10" or "key: x" → measured stat
  const meter = f.match(/^([a-z][a-z ]*?)[:\s]+(\d{1,2}\s*\/\s*10|\d{1,2})\s*([↑↓→])?$/i);
  if (meter) {
    const k = meter[1].trim().toLowerCase();
    const row = meter[1].trim() + ': ' + meter[2] + (meter[3] ? ' ' + meter[3] : '');
    if (/arous|fear|stress|lust|anger|panic|desire|tension|sanity|focus/.test(k)) a.extras.mind.push(row);
    else a.extras.body.push(row);
    return;
  }
  if (/\b(arous|fear|stress|lust|anger|panic|desire|aching|trembl|flush|dizz|breathless|heart|pulse|mind|thought|fixat|wanting|need)/.test(low)) { a.extras.mind.push(f); return; }
  if (/\b(wearing|dressed|tunic|breeches|gown|dress|shirt|coat|robe|naked|bare|nude|undone|unbuttoned|torn|bloodied|dishevel|disrobed|removed|stripped|skirt|bodice|collar|boots|barefoot|hair|makeup|outfit|clothes)/.test(low)) { a.extras.appearance.push(f); return; }
  if (/\b(wound|bleed|bruis|cut|gash|injur|fatigue|exhaust|drunk|drugged|sober|aching|sweat|hp|stamina|kneel|sitting|seated|standing|lying|sprawl|pinned|position|posture)/.test(low)) { a.extras.body.push(f); return; }
  // otherwise it's an action / behavior → the doing line
  a.doing = a.doing ? a.doing + ' · ' + f : f;
}

// Is this payload just a bare name (no location/mood/detail markers)?
function isBareName(p) {
  return p && !/[@|]/.test(p) && !/::/.test(p) && p.split(/\s+/).length <= 5;
}

function actorCard(a, off) {
  if (!a) return '';
  const av = '<div class="vlm-av' + (off ? ' off' : '') + '">' + escapeHtml(initials(a.name)) + '</div>';
  const meta = [];
  if (a.loc) meta.push('<span class="vlm-pill loc">📍 ' + escapeHtml(a.loc) + '</span>');
  if (a.mood) meta.push('<span class="vlm-pill mood">' + escapeHtml(a.mood) + '</span>');
  const doing = a.doing ? '<div class="vlm-doing">' + escapeHtml(a.doing) + '</div>' : '';
  return '<div class="vlm-actor">' + av + '<div class="vlm-actor-b"><div class="vlm-actor-n">' + escapeHtml(a.name) + '</div>'
    + (meta.length ? '<div class="vlm-pills">' + meta.join('') + '</div>' : '') + doing + '</div></div>';
}

// Attribute-line detection for the robust BTS (Body/Mind/Appearance/Inventory).
const BTS_ATTR_KEY = /^(hp|wounds?|status|fatigue|hunger|thirst|hygiene|position|comfort|injur\w*|mana|stamina|blood|mood|stress|fear|arousal|focus|moodlet\w*|fixat\w*|sanity|outfit|hair|makeup|scent|clothing|condition|dress|attire|carrying|gold|g|currency|items?)\b\s*:/i;
function btsIsAttrLine(l) {
  return BTS_ATTR_KEY.test(l) || /^[+\-]\w/.test(l) || /^\w[\w ]*\([^)]*\)/.test(l);
}
function btsPushAttr(cur, line) {
  let cat = 'body';
  if (/^(mood|stress|fear|arousal|focus|moodlet|fixat|sanity)\b/i.test(line)) cat = 'mind';
  else if (/^(outfit|hair|makeup|scent|clothing|condition|dress|attire)\b/i.test(line)) cat = 'appearance';
  else if (/^(carrying|gold|g\b|currency|items?)\b/i.test(line) || /^[+\-]\w/.test(line) || /^\w[\w ]*\([^)]*\)/.test(line)) cat = 'inventory';
  cur.attrs[cat].push(line);
}
// Render one attribute row: "key: value" with colored trend arrows and old→new.
function btsAttrRow(line) {
  const m = String(line).match(/^(\w[\w ]*?):\s*(.+)$/);
  if (!m) return '<div class="vlm-attr">' + escapeHtml(line) + '</div>';
  const key = m[1].trim();
  let val = escapeHtml(m[2].trim())
    .replace(/↑/g, '<span class="vlm-up">↑</span>')
    .replace(/↓/g, '<span class="vlm-dn">↓</span>')
    .replace(/→/g, '<span class="vlm-arr">→</span>');
  return '<div class="vlm-attr"><span class="vlm-attr-k">' + escapeHtml(key) + '</span><span class="vlm-attr-v">' + val + '</span></div>';
}
function btsAttrGroup(label, items) {
  if (!items || !items.length) return '';
  return '<div class="vlm-ag"><div class="vlm-ag-l">' + label + '</div><div class="vlm-ag-r">' + items.map(btsAttrRow).join('') + '</div></div>';
}
function btsInvChips(items) {
  if (!items || !items.length) return '';
  return '<div class="vlm-ag"><div class="vlm-ag-l">Inventory</div><div class="vlm-inv">' + items.map((i) => '<span class="vlm-ichip">' + escapeHtml(i) + '</span>').join('') + '</div></div>';
}
// Rich, collapsible actor card with grouped attributes.
function richActorCard(a, off, open) {
  if (!a) return '';
  if (!a.attrs) a.attrs = { body: [], mind: [], appearance: [], inventory: [] };
  // Merge fragments extracted from the location run-on into the stat groups.
  if (a.extras) {
    a.attrs.body = a.attrs.body.concat(a.extras.body || []);
    a.attrs.mind = a.attrs.mind.concat(a.extras.mind || []);
    a.attrs.appearance = a.attrs.appearance.concat(a.extras.appearance || []);
  }
  const av = '<div class="vlm-av' + (off ? ' off' : '') + '">' + escapeHtml(initials(a.name)) + '</div>';
  const meta = [];
  if (a.loc) meta.push('<span class="vlm-pill loc">📍 ' + escapeHtml(a.loc) + '</span>');
  if (a.mood) meta.push('<span class="vlm-pill mood">' + escapeHtml(a.mood) + '</span>');
  const doing = a.doing ? '<div class="vlm-doing">' + escapeHtml(a.doing) + '</div>' : '';
  const hasAttrs = a.attrs.body.length || a.attrs.mind.length || a.attrs.appearance.length || a.attrs.inventory.length;
  // Off-stage with no attributes: compact non-collapsible card.
  if (!hasAttrs && off) {
    return '<div class="vlm-actor">' + av + '<div class="vlm-actor-b"><div class="vlm-actor-n">' + escapeHtml(a.name) + '</div>'
      + (meta.length ? '<div class="vlm-pills">' + meta.join('') + '</div>' : '') + doing + '</div></div>';
  }
  const inner = doing
    + btsAttrGroup('🩸 Body', a.attrs.body)
    + btsAttrGroup('🧠 Mind', a.attrs.mind)
    + btsAttrGroup('👗 Appearance', a.attrs.appearance)
    + btsInvChips(a.attrs.inventory);
  return '<details class="vlm-actor-dtls"' + (open ? ' open' : '') + '><summary class="vlm-actor-sum">' + av
    + '<div class="vlm-actor-b"><div class="vlm-actor-n">' + escapeHtml(a.name) + '</div>'
    + (meta.length ? '<div class="vlm-pills">' + meta.join('') + '</div>' : '') + '</div></summary>'
    + '<div class="vlm-actor-x">' + inner + '</div></details>';
}

function btsHtml(raw) {
  const text = String(raw).replace(/\r/g, '');
  const onStage = [], offStage = [];
  const threads = [], world = [], rels = [], timeNotes = [];

  let mode = 'on';
  let cur = null; // current actor for attribute attachment
  let lastOn = null; // last ON-STAGE actor (fallback for unlabeled detail lines)
  let lastCat = null; // last actor a category line (body:/mind:/...) resolved to
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let raw0 of lines) {
    let line = raw0;
    const offInline = line.match(/^:{0,2}\s*OFF\s*:{0,2}\s*(.*)$/i);
    if (offInline) { mode = 'off'; cur = null; line = offInline[1].trim(); if (!line) continue; }
    if (/^:{1,2}\s*$/.test(line)) continue;

    // Time-delta / clock notes (e.g. "time: +5min") belong with the date/time, not the cast.
    if (/^(time|clock|elapsed|duration)\s*:/i.test(line)) { cur = null; lastCat = null; timeNotes.push(line.replace(/^(time|clock|elapsed|duration)\s*:\s*/i, '').trim()); continue; }

    if (/^\+?thread\b/i.test(line) || /^thread→/i.test(line)) { cur = null; lastCat = null; threads.push(line.replace(/^\+?thread[:→\s]*/i, '').trim()); continue; }
    // know→/secret→/mem→ are tracker-extraction lines (folded into the Knowledge,
    // Secrets, and Memory Journal tabs) — they are NOT backstage display content,
    // so skip them here instead of mis-rendering them as actor cards on stage.
    if (/^(know|secret|mem)[\s:→]/i.test(line)) { cur = null; lastCat = null; continue; }
    if (/^rel→/i.test(line)) { cur = null; lastCat = null; rels.push(line.replace(/^rel→\s*/i, '').trim()); continue; }
    if (/^rel\w+→/i.test(line)) { cur = null; lastCat = null; rels.push(line.replace(/^rel/i, '').trim()); continue; }
    if (/^world\b/i.test(line)) { cur = null; lastCat = null; world.push(line.replace(/^world[:\s]*/i, '').trim()); continue; }

    // Attribute / inventory line. Off-stage entries are reduced-format and never
    // carry body/mind/appearance detail — so when we're past the OFF divider,
    // an unlabeled detail line belongs to the last ON-STAGE actor, not the
    // off-stage one it happens to follow.
    if (btsIsAttrLine(line)) {
      const tgt = (mode === 'off') ? (lastOn || cur) : cur;
      if (tgt) btsPushAttr(tgt, line);
      else if (/^[+\-]\w/.test(line) || /^\w[\w ]*\([^)]*\)/.test(line)) world.push(line.trim());
      continue;
    }

    // Explicit category line: "body: ...", "mind: ...", "appearance: ...",
    // "inventory: ...", "bonds: ...". The model emits these (esp. in checkpoints)
    // in a flat list, usually naming the character ("body: Cersei—came twice...").
    // Route by that NAME to the matching actor — never to whatever `cur` happens
    // to be (which would mis-file it onto an off-stage character).
    const catLine = line.match(/^(body|mind|appearance|inventory|carrying|bonds?|relationships?)\s*:\s*(.+)$/i);
    if (catLine) {
      const cat0 = catLine[1].toLowerCase();
      let val = catLine[2].trim();
      // Checkpoint category lines come in a run describing ONE character; only
      // the first usually names them ("body: Cersei—…"), the rest are unlabeled
      // continuations of that SAME character. So: a name prefix sets the target
      // (and remembers it); an unlabeled line inherits the last category target,
      // NOT whatever actor happened to be declared last.
      let target = null;
      const nm = val.match(/^([A-Z][\w'’\-]*(?:\s+[A-Z][\w'’\-]*)?)\s*[—–:-]\s*(.+)$/);
      if (nm) {
        const found = onStage.concat(offStage).find((a) => {
          const an = a.name.toLowerCase(), q = nm[1].toLowerCase();
          return an === q || an.split(/\s+/)[0] === q.split(/\s+/)[0];
        });
        if (found) { target = found; val = nm[2].trim(); }
      }
      if (!target) target = lastCat || (mode === 'off' ? lastOn : cur) || lastOn;
      if (/^bond|^relationship/.test(cat0)) { rels.push(val); continue; }
      if (target) lastCat = target;
      if (target) {
        if (!target.attrs) target.attrs = { body: [], mind: [], appearance: [], inventory: [] };
        const cat = (cat0 === 'carrying' || cat0 === 'inventory') ? 'inventory'
          : (cat0 === 'appearance') ? 'appearance'
          : (cat0 === 'mind') ? 'mind' : 'body';
        target.attrs[cat].push(val);
      }
      continue;
    }

    const m = line.match(/^:{1,2}\s*(.+)$/);
    const payload = m ? m[1].trim() : line;
    if (!payload) continue;

    // Bare name on its own line → new actor; detail follows on the next line.
    if (isBareName(payload) && !/^@/.test(payload)) {
      cur = null; lastCat = null;
      const a = parseActor(payload, payload);
      if (a && a.name) { a.attrs = { body: [], mind: [], appearance: [], inventory: [] }; (mode === 'off' ? offStage : onStage).push(a); cur = a; if (mode !== 'off') lastOn = a; }
      continue;
    }
    const actor = parseActor(payload, '');
    if (actor && actor.name) {
      actor.attrs = { body: [], mind: [], appearance: [], inventory: [] };
      (mode === 'off' ? offStage : onStage).push(actor);
      cur = actor; lastCat = null;
      if (mode !== 'off') lastOn = actor;
    } else {
      cur = null;
    }
  }

  let html = '<div class="vlm-bts-h">✦ Behind the Curtain</div>';
  if (timeNotes.length) {
    html += '<div class="vlm-timenote">⏱ ' + timeNotes.map((t) => escapeHtml(t)).join(' · ') + '</div>';
  }
  if (onStage.length) {
    html += '<div class="vlm-bts-sec"><div class="vlm-bts-l on">On Stage</div>'
      + onStage.map((a, i) => richActorCard(a, false, i === 0)).join('') + '</div>';
  }
  if (offStage.length) {
    html += '<div class="vlm-bts-sec"><div class="vlm-bts-l off">Off Stage</div>'
      + offStage.map((a) => richActorCard(a, true, false)).join('') + '</div>';
  }
  if (rels.length) {
    html += '<div class="vlm-card vlm-bts-card"><div class="vlm-card-h">⚲ Bonds</div><ul class="vlm-list">'
      + rels.map((r) => '<li>' + escapeHtml(r) + '</li>').join('') + '</ul></div>';
  }
  if (threads.length) {
    html += '<div class="vlm-card vlm-bts-card"><div class="vlm-card-h">🧵 Threads</div><ul class="vlm-list thread">'
      + threads.map((t) => '<li>' + escapeHtml(t) + '</li>').join('') + '</ul></div>';
  }
  if (world.length) {
    html += '<div class="vlm-world">🌍 ' + world.map((w) => escapeHtml(w)).join(' &nbsp;·&nbsp; ') + '</div>';
  }
  return html;
}

// Rapport strip: per present character, their feeling toward {{user}} drawn from
// the relations system (affection/trust), replacing the old single Bond meter.
function rapportHtml(rapport) {
  if (!Array.isArray(rapport) || !rapport.length) return '';
  const sCls = { warm: 'se-warm', hostile: 'se-host', strained: 'se-strain', complex: 'se-cx', neutral: 'se-neu' };
  const sGlyph = { warm: '\u2665', hostile: '\u2694', strained: '\u26A1', complex: '\u269C', neutral: '\u25CB' };
  const bar = (v) => {
    const n = Math.max(-100, Math.min(100, Number(v) || 0));
    const pct = Math.abs(n) / 2; const pos = n >= 0;
    return '<span class="vlm-rap-track"><span class="vlm-rap-mid"></span><span class="vlm-rap-fill ' + (pos ? 'pos' : 'neg') + '" style="' + (pos ? 'left:50%;width:' + pct + '%' : 'right:50%;width:' + pct + '%') + '"></span></span>';
  };
  const rows = rapport.map((r) => '<div class="vlm-rap-row">'
    + '<span class="vlm-rap-name">' + escapeHtml(r.name) + '</span>'
    + '<span class="vlm-rap-sent ' + (sCls[r.sentiment] || 'se-neu') + '">' + (sGlyph[r.sentiment] || '\u25CB') + ' ' + escapeHtml(r.sentiment) + '</span>'
    + '<span class="vlm-rap-bars"><span class="vlm-rap-lbl">aff</span>' + bar(r.affection) + '<span class="vlm-rap-lbl">trust</span>' + bar(r.trust) + '</span>'
    + '</div>').join('');
  return '<div class="vlm-rapport"><div class="vlm-rap-h">Rapport with you</div>' + rows + '</div>';
}

function render(body, dot, data) {
  const g = data && data.ledger;
  const bts = data && data.bts;
  if ((!g || !g.raw) && !bts) {
    body.innerHTML = '<div class="vlm-empty">✦<br>Awaiting the first ledger…</div>';
    if (dot) dot.style.background = '#7a8b6f';
    return;
  }
  let html = '';
  if (g) {
    // ----- SCENE panel: where & when, right now -----
    let scene = '<div class="vlm-hero">'
      + '<div class="vlm-kicker">· current state ·</div>'
      + (g.location ? '<div class="vlm-title-lg">' + escapeHtml(g.location.split(/[—,]/)[0].trim()) + '</div>' : '<div class="vlm-title-lg">The Scene</div>')
      + '<div class="vlm-rule"></div></div>';
    scene += '<div class="vlm-chips">'
      + chipHtml('⏱', g.time) + chipHtml('🌤', g.weather) + chipHtml('👥', g.present) + '</div>';
    if (g.sceneTension) {
      scene += '<div class="vlm-meters">' + meterHtml('Scene tension', g.sceneTension, '') + '</div>';
    }
    scene += rapportHtml(data && data.rapport);
    html += '<div class="vlm-panel" data-panel="scene">' + scene + '</div>';
    // ----- MINDS panel: inner landscape -----
    const minds = mindSecHtml('💭', 'Inner Landscape', g.thoughts);
    html += '<div class="vlm-panel" data-panel="minds">' + (minds || emptyPanel('No inner landscape recorded this turn.')) + '</div>';
    // ----- STORY panel: arcs + undercurrents -----
    let story = listSecHtml('📜', 'Active Arcs', g.arcs) + listSecHtml('🌊', 'Undercurrents', g.offscreen);
    html += '<div class="vlm-panel" data-panel="story">' + (story || emptyPanel('No active arcs or undercurrents yet.')) + '</div>';
  } else {
    html += '<div class="vlm-panel" data-panel="scene">' + emptyPanel('No ledger yet.') + '</div>';
    html += '<div class="vlm-panel" data-panel="minds">' + emptyPanel('No inner landscape yet.') + '</div>';
    html += '<div class="vlm-panel" data-panel="story">' + emptyPanel('No story state yet.') + '</div>';
  }
  // ----- BACKSTAGE panel -----
  html += '<div class="vlm-panel" data-panel="backstage">' + (bts ? btsHtml(bts) : emptyPanel('No backstage activity yet.')) + '</div>';
  // ----- PULSE panel (filled by renderPulsePanel) -----
  html += '<div class="vlm-panel" data-panel="pulse"></div>';
  html += '<div class="vlm-foot">The ledger and backstage are hidden from the chat and live only here. Arc memory (@vellum_*) syncs every turn.</div>';
  body.innerHTML = html;
  if (dot) dot.style.background = '#cda84e';
}

function emptyPanel(msg) { return '<div class="vlm-empty" style="padding:40px 12px;font-size:14px">' + escapeHtml(msg) + '</div>'; }

/* ============================================================================
 * CHRONICLE VIEW (drawer tab) — long-term continuity.
 * Renders arcs, threads, parallel events, and shifts, each with an evolution
 * timeline showing how a past state became the current one.
 * ========================================================================== */
// ---- Chronicle render: paginated sections + uniform date timeline ----
let _chronHost = null, _chronCh = null;
const _chronPage = {};
const PER_TRACK = 12, PER_LOG = 30, PER_DATE = 12;

function dayLabel(d) { return d ? 'Day ' + d : '—'; }

function pageOf(key, total, per) {
  const pages = Math.max(1, Math.ceil(total / per));
  let p = _chronPage[key] || 0;
  if (p >= pages) p = pages - 1;
  if (p < 0) p = 0;
  _chronPage[key] = p;
  return { p, pages };
}

function pagerBar(key, p, pages) {
  if (pages <= 1) return '';
  return '<div class="vlc-pager">'
    + '<button class="vlc-pg" data-pg-key="' + key + '" data-pg-dir="-1"' + (p <= 0 ? ' disabled' : '') + '>‹ Prev</button>'
    + '<span class="vlc-pg-i">' + (p + 1) + ' / ' + pages + '</span>'
    + '<button class="vlc-pg" data-pg-key="' + key + '" data-pg-dir="1"' + (p >= pages - 1 ? ' disabled' : '') + '>Next ›</button>'
    + '</div>';
}

function paginate(items, key, per) {
  const total = items.length;
  const { p, pages } = pageOf(key, total, per);
  const start = p * per;
  return { slice: items.slice(start, start + per), pager: pagerBar(key, p, pages), p, pages, start, total };
}

function sortTracks(map) {
  return Object.values(map || {}).sort((a, b) => (b.lastTurn || 0) - (a.lastTurn || 0));
}

// Last injection snapshot pushed from the backend (what VELLUM put in the prompt).
let _lastInjection = null;
let _deepOn = false;
let _hideOn = false;          // hide-summarized-turns toggle state
let _hideInfo = { covered: 0, memories: 0 };
// Active category filters (persist across re-renders).
let _knowFilter = 'all';   // all | knows | believes | suspects | wrong | unaware
let _secFilter = 'all';    // all | minor | major | explosive
let _sortDir = 'desc';     // newest-first (desc) or oldest-first (asc) by reveal/happen turn
const _mjFilter = {};      // per-character key -> weight filter (all|defining|significant|minor|trivial)
let _relFilter = 'all';    // all | familial | romantic | alliance | rivalry | social | neutral
let _memTree = null;       // last vellum_memtree view { arcs, unassigned, index, builtAt, chapters }
let _memTreeAxis = '';     // which axis index is expanded in the UI
// Module refs so render helpers can message the backend (set once in setup()).
let _ctx = null;
let _getChatId = () => null;

// Render the "what was injected into the chat this turn" panel (LoreRecall-style).
function injectionHtml(inj) {
  const toggle = '<div class="vlc-deep"><div class="vlc-deep-l"><b>Deep Recall</b> <span>LLM picks relevant entries each turn (background, opt-in)</span></div>'
    + '<button class="vlc-deep-btn' + (_deepOn ? ' on' : '') + '" data-vlc-deep>' + (_deepOn ? 'ON' : 'OFF') + '</button></div>'
    + '<div class="vlc-deep"><div class="vlc-deep-l"><b>Hide summarized turns</b> <span>' + (_hideInfo.covered ? ('Drops ~' + _hideInfo.covered + ' old turns already in ' + _hideInfo.memories + ' memories; replaced by a compact \u201cStory so far\u201d. Recent turns kept.') : 'Once early turns are summarized, drop them from the prompt to save tokens (a compact recap is sent instead).') + '</span></div>'
    + '<button class="vlc-deep-btn' + (_hideOn ? ' on' : '') + '" data-vlc-hide>' + (_hideOn ? 'ON' : 'OFF') + '</button></div>';
  if (!inj || (!inj.cast && (!inj.recall || !inj.recall.length))) {
    return toggle + '<div class="vlc-empty">Nothing injected yet.<br><span style="opacity:.7;font-size:10px">After your next turn, the cast roster and scene-relevant recall VELLUM adds to the prompt will show here.</span></div>';
  }
  let html = toggle;
  if (inj.cast) {
    html += '<div class="vlc-inj"><div class="vlc-inj-h"><span>\u25C8 Cast roster</span><span>' + (inj.castCount || 0) + '</span></div>'
      + '<div class="vlc-inj-pre">' + escapeHtml(inj.cast) + '</div></div>';
  }
  if (inj.recall && inj.recall.length) {
    html += '<div class="vlc-inj"><div class="vlc-inj-h"><span>\u2756 Scene recall</span><span>' + inj.recall.length + '</span></div>'
      + '<div class="vlc-inj-pre">' + escapeHtml(inj.recall.join('\n')) + '</div></div>';
  }
  // Reasoning: WHY each entry was injected.
  const trace = (inj.castTrace || []).concat(inj.recallTrace || []);
  if (trace.length) {
    const kindIcon = { cast: '\u25C8', arc: '\u25C9', thread: '\uD83E\uDDF5', event: '\u25B8', shift: '\u26B2', memory: '\u2756', secret: '\u26BF', knowledge: '\u25C7' };
    html += '<div class="vlc-inj"><div class="vlc-inj-h"><span>\uD83D\uDD0E Why these?</span><span>' + trace.length + '</span></div>'
      + '<div class="vlc-why">'
      + trace.map((t) => '<div class="vlc-why-row"><span class="vlc-why-i">' + (kindIcon[t.kind] || '\u2022') + '</span>'
        + '<span class="vlc-why-l">' + escapeHtml(String(t.label || '')) + '</span>'
        + '<span class="vlc-why-r">' + escapeHtml(String(t.why || '')) + '</span>'
        + '<span class="vlc-why-s">' + escapeHtml(String(t.score)) + '</span></div>').join('')
      + '</div></div>';
  }
  const when = inj.at ? new Date(inj.at).toLocaleTimeString() : '';
  const phaseTag = inj.phase && inj.phase !== 'unknown' ? ' \u00B7 scene: ' + escapeHtml(inj.phase) : '';
  const cachedTag = inj.cached ? ' \u00B7 reused' : '';
  html += '<div class="vlc-inj-meta">~' + (inj.chars || 0) + ' chars injected before your last message' + (when ? ' \u00B7 ' + when : '') + phaseTag + cachedTag + '. This is added silently to the prompt, never shown in the story.</div>';
  return html;
}

// Auto-summary chapter memories — newest first, with keyword chips.
// Knowledge & Secrets render (dramatic-irony surface).
function knowledgeHtml(ch) {
  const knAll = ch.knowledge || [];
  const secAll = ch.secrets || [];
  if (!knAll.length && !secAll.length) {
    return '<div class="vlc-empty">No knowledge mapped yet.<br><span style="opacity:.7;font-size:10px">Click \u201cScan knowledge\u201d to extract who knows, believes, suspects, or is ignorant of what \u2014 and what secrets are being kept.</span></div>';
  }
  // Count helper for filter chips.
  const countBy = (arr, field) => arr.reduce((acc, x) => { const v = x[field] || ''; acc[v] = (acc[v] || 0) + 1; return acc; }, {});
  // Sort by reveal/happen turn (then add-order), honoring the global direction.
  const sortByWhen = (arr) => arr.slice().sort((a, b) => {
    const ta = (a.turn || a.lastTurn || 0), tb = (b.turn || b.lastTurn || 0);
    return _sortDir === 'asc' ? (ta - tb) : (tb - ta);
  });
  const sortBar = '<div class="vlc-sortbar"><span class="vlc-sort-l">Sort</span>'
    + '<button class="vlc-fchip' + (_sortDir === 'desc' ? ' on' : '') + '" data-sort="desc">Newest \u2193</button>'
    + '<button class="vlc-fchip' + (_sortDir === 'asc' ? ' on' : '') + '" data-sort="asc">Oldest \u2191</button></div>';
  let html = sortBar;
  if (knAll.length) {
    const relCls = { knows: 'k-knows', believes: 'k-believes', suspects: 'k-suspects', wrong: 'k-wrong', unaware: 'k-unaware' };
    const relLbl = { knows: 'knows', believes: 'believes', suspects: 'suspects', wrong: 'WRONGLY believes', unaware: 'unaware of' };
    const cnt = countBy(knAll, 'reliability');
    const order = ['knows', 'believes', 'suspects', 'wrong', 'unaware'];
    const chips = ['all'].concat(order.filter((r) => cnt[r])).map((r) =>
      '<button class="vlc-fchip' + (_knowFilter === r ? ' on' : '') + '" data-know-filter="' + r + '">'
      + (r === 'all' ? 'All' : escapeHtml(relLbl[r] || r)) + ' <span class="vlc-fchip-n">' + (r === 'all' ? knAll.length : cnt[r]) + '</span></button>'
    ).join('');
    const kn = sortByWhen(_knowFilter === 'all' ? knAll : knAll.filter((k) => k.reliability === _knowFilter));
    html += '<div class="vlc-know-h">What characters know</div>';
    html += '<div class="vlc-fbar" data-know-fbar>' + chips + '</div>';
    html += kn.length ? '<div class="vlc-know-grid">' + kn.map((k) => {
      const i = knAll.indexOf(k);
      const untrue = (k.reliability === 'wrong' && k.truth === 'false') ? '<span class="vlc-know-x">untrue</span>' : '';
      return '<div class="vlc-know ' + (relCls[k.reliability] || 'k-knows') + '" data-know-i="' + i + '">'
      + '<div class="vlc-know-top">'
        + '<span class="vlc-know-who">' + escapeHtml(k.who) + '</span>'
        + '<span class="vlc-know-rel">' + escapeHtml(relLbl[k.reliability] || k.reliability) + '</span>' + untrue
        + '<span class="vlc-know-ctl">'
        + '<button class="vlc-mini-edit" data-know-edit data-id="' + escapeHtml(k.id || '') + '" data-who="' + escapeHtml(k.who) + '" data-fact="' + escapeHtml(k.fact) + '" data-reliability="' + escapeHtml(k.reliability || '') + '" data-truth="' + escapeHtml(k.truth || '') + '" data-source="' + escapeHtml(k.source || '') + '" title="Edit">\u270E</button>'
        + '<button class="vlc-mini-del" data-know-del="knowledge" data-id="' + escapeHtml(k.id || '') + '" data-i="' + i + '" title="Delete">\u2715</button>'
        + '</span>'
      + '</div>'
      + '<div class="vlc-know-fact">' + escapeHtml(k.fact) + '</div>'
      + (k.source ? '<div class="vlc-know-src">via ' + escapeHtml(k.source) + '</div>' : '')
      + '</div>';
    }).join('') + '</div>' : '<div class="vlc-empty" style="padding:8px">No \u201c' + escapeHtml(relLbl[_knowFilter] || _knowFilter) + '\u201d entries.</div>';
  }
  if (secAll.length) {
    const dCls = { minor: 's-minor', major: 's-major', explosive: 's-explosive' };
    const cnt = countBy(secAll, 'danger');
    const order = ['minor', 'major', 'explosive'];
    const chips = ['all'].concat(order.filter((d) => cnt[d])).map((d) =>
      '<button class="vlc-fchip' + (_secFilter === d ? ' on' : '') + '" data-sec-filter="' + d + '">'
      + (d === 'all' ? 'All' : escapeHtml(d)) + ' <span class="vlc-fchip-n">' + (d === 'all' ? secAll.length : cnt[d]) + '</span></button>'
    ).join('');
    const sec = sortByWhen(_secFilter === 'all' ? secAll : secAll.filter((x) => x.danger === _secFilter));
    html += '<div class="vlc-know-h" style="margin-top:12px">Secrets in play</div>';
    html += '<div class="vlc-fbar" data-sec-fbar>' + chips + '</div>';
    html += sec.length ? '<div class="vlc-sec-grid">' + sec.map((x) => {
      const i = secAll.indexOf(x);
      return '<div class="vlc-secret ' + (dCls[x.danger] || 's-major') + '" data-secret-i="' + i + '">'
      + '<div class="vlc-secret-top"><span class="vlc-secret-keeper">' + escapeHtml(x.keeper) + '</span>'
      + '<span class="vlc-secret-arrow">hides from</span><span class="vlc-secret-from">' + escapeHtml(x.from || 'others') + '</span>'
      + '<span class="vlc-secret-danger">' + escapeHtml(x.danger) + '</span>'
      + '<button class="vlc-mini-edit" data-secret-edit data-id="' + escapeHtml(x.id || '') + '" data-secret="' + escapeHtml(x.secret) + '" data-keeper="' + escapeHtml(x.keeper) + '" data-from="' + escapeHtml(x.from || '') + '" data-exposure="' + escapeHtml(x.exposure || '') + '" data-danger="' + escapeHtml(x.danger || '') + '" title="Edit">\u270E</button>'
      + '<button class="vlc-mini-del" data-know-del="secret" data-id="' + escapeHtml(x.id || '') + '" data-i="' + i + '" title="Delete">\u2715</button></div>'
      + '<div class="vlc-secret-body">' + escapeHtml(x.secret) + '</div>'
      + (x.exposure ? '<div class="vlc-secret-exp">may surface: ' + escapeHtml(x.exposure) + '</div>' : '')
      + '</div>';
    }).join('') + '</div>' : '<div class="vlc-empty" style="padding:8px">No \u201c' + escapeHtml(_secFilter) + '\u201d secrets.</div>';
  }
  return html;
}

// Memory Journal render (per character) for the Cast tab.
function memJournalHtml(ch) {
  const mj = ch.memJournal || {};
  const keys = Object.keys(mj);
  if (!keys.length) {
    return '<div class="vlc-empty">No memory journals yet.<br><span style="opacity:.7;font-size:10px">Click \u201cScan memories\u201d to build, per character, the moments they remember about {{user}} and each other.</span></div>';
  }
  // most-recently-touched character first
  keys.sort((a, b) => {
    const la = Math.max(0, ...(mj[a].entries || []).map((e) => e.turn || 0));
    const lb = Math.max(0, ...(mj[b].entries || []).map((e) => e.turn || 0));
    return lb - la;
  });
  const wCls = { trivial: 'w-trivial', minor: 'w-minor', significant: 'w-sig', defining: 'w-def' };
  const sCls = { positive: 's-pos', negative: 's-neg', neutral: 's-neu', complex: 's-cx' };
  const mjSortBar = '<div class="vlc-sortbar"><span class="vlc-sort-l">Sort</span>'
    + '<button class="vlc-fchip' + (_sortDir === 'desc' ? ' on' : '') + '" data-sort="desc">Newest \u2193</button>'
    + '<button class="vlc-fchip' + (_sortDir === 'asc' ? ' on' : '') + '" data-sort="asc">Oldest \u2191</button></div>';
  const W_ORDER = ['defining', 'significant', 'minor', 'trivial'];
  const body = keys.map((k) => {
    const c = mj[k];
    const all = (c.entries || []).slice().sort((a, b) => { const ta = (a.turn || 0), tb = (b.turn || 0); return _sortDir === 'asc' ? (ta - tb) : (tb - ta); });
    const cnt = all.reduce((acc, e) => { const w = e.weight || 'minor'; acc[w] = (acc[w] || 0) + 1; return acc; }, {});
    const active = _mjFilter[k] || 'all';
    const chips = ['all'].concat(W_ORDER.filter((w) => cnt[w])).map((w) =>
      '<button class="vlc-fchip' + (active === w ? ' on' : '') + '" data-mj-filter="' + escapeHtml(k) + '" data-w="' + w + '">'
      + (w === 'all' ? 'All' : escapeHtml(w)) + ' <span class="vlc-fchip-n">' + (w === 'all' ? all.length : cnt[w]) + '</span></button>'
    ).join('');
    const ents = active === 'all' ? all : all.filter((e) => (e.weight || 'minor') === active);
    const rows = ents.length ? ents.map((e) => {
      const i = all.indexOf(e);
      return '<div class="vlc-mj-row ' + (sCls[e.sentiment] || 's-neu') + '">'
      + '<span class="vlc-mj-w ' + (wCls[e.weight] || 'w-minor') + '">' + escapeHtml(e.weight) + '</span>'
      + '<span class="vlc-mj-t">' + escapeHtml(e.memory) + (e.about ? ' <em class="vlc-mj-about">\u2014 ' + escapeHtml(e.about) + '</em>' : '') + '</span>'
      + '<button class="vlc-mini-edit" data-mj-edit data-key="' + escapeHtml(k) + '" data-id="' + escapeHtml(e.id || '') + '" data-memory="' + escapeHtml(e.memory) + '" data-about="' + escapeHtml(e.about || '') + '" data-weight="' + escapeHtml(e.weight || '') + '" data-sentiment="' + escapeHtml(e.sentiment || '') + '" title="Edit">\u270E</button>'
      + '<button class="vlc-mini-del" data-mj-del="' + escapeHtml(k) + '" data-id="' + escapeHtml(e.id || '') + '" data-i="' + i + '" title="Delete">\u2715</button>'
      + '</div>';
    }).join('') : '<div class="vlc-empty" style="padding:8px">No \u201c' + escapeHtml(active) + '\u201d memories.</div>';
    const bar = (W_ORDER.filter((w) => cnt[w]).length > 1) ? ('<div class="vlc-fbar" data-mj-fbar>' + chips + '</div>') : '';
    return '<details class="vlc-mj" open><summary class="vlc-mj-sum"><span class="vlc-mj-name">' + escapeHtml(c.name || k) + '</span><span class="vlc-h-n">' + all.length + '</span><button class="vlc-add-btn" data-mj-add data-who="' + escapeHtml(c.name || k) + '">+ Add</button></summary><div class="vlc-mj-body">' + bar + rows + '</div></details>';
  }).join('');
  return mjSortBar + body;
}


// Memory Tree render: arc cards (editable title/gist, chapter chips with a
// "move" affordance), an Unassigned bucket, and a collapsible axis index.
function memTreeHtml(t) {
  if (!t) return '<div class="vlc-empty">Loading…</div>';
  if (!t.chapters) {
    return '<div class="vlc-empty">No chapters to organize yet.<br><span style="opacity:.7;font-size:10px">Chapters are auto-summarized as the story grows; then hit Build to cluster them into arcs.</span></div>';
  }
  const arcOpts = (t.arcs || []).map((a) => '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.title) + '</option>').join('');
  const chip = (m) => {
    const dl = m.day ? 'D' + m.day : 't' + m.fromTurn;
    return '<div class="vlc-mt-chip" title="' + escapeHtml(m.text) + '">'
      + '<span class="vlc-mt-chip-d">' + escapeHtml(dl) + '</span>'
      + '<span class="vlc-mt-chip-t">' + escapeHtml(m.title) + '</span>'
      + '<button class="vlc-mt-move" data-mt-move data-id="' + escapeHtml(m.id) + '" title="Move to arc…">⇄</button>'
      + '</div>';
  };
  let html = '';
  if (t.builtAt) html += '<div class="vlc-mt-meta">' + (t.arcs || []).length + ' arcs · ' + t.chapters + ' chapters · built ' + new Date(t.builtAt).toLocaleString() + '</div>';
  html += (t.arcs || []).map((a) => {
    const span = (a.day ? 'Day ' + a.day + ' · ' : '') + 't' + (a.from || '?') + '–' + (a.to || '?');
    return '<details class="vlc-mt-arc" open><summary class="vlc-mt-sum">'
      + '<span class="vlc-mt-title">' + escapeHtml(a.title) + '</span>'
      + '<span class="vlc-mt-span">' + escapeHtml(span) + '</span>'
      + '<span class="vlc-mt-n">' + (a.chapters || []).length + '</span>'
      + '<button class="vlc-mini-edit" data-mt-edit data-id="' + escapeHtml(a.id) + '" data-title="' + escapeHtml(a.title) + '" data-gist="' + escapeHtml(a.gist || '') + '" title="Edit arc">✎</button>'
      + '<button class="vlc-mini-del" data-mt-del data-id="' + escapeHtml(a.id) + '" title="Delete arc">✕</button>'
      + '</summary>'
      + '<div class="vlc-mt-body">'
      + (a.gist ? '<div class="vlc-mt-gist">' + escapeHtml(a.gist) + '</div>' : '')
      + '<div class="vlc-mt-chips">' + (a.chapters || []).map(chip).join('') + '</div>'
      + '</div></details>';
  }).join('');
  if ((t.unassigned || []).length) {
    html += '<details class="vlc-mt-arc unassigned" open><summary class="vlc-mt-sum"><span class="vlc-mt-title">Unassigned</span><span class="vlc-mt-n">' + t.unassigned.length + '</span></summary>'
      + '<div class="vlc-mt-body"><div class="vlc-mt-chips">' + t.unassigned.map(chip).join('') + '</div></div></details>';
  }
  // collapsible axis index
  const idx = t.index || {};
  const axisBtn = (k, label) => { const n = Object.keys(idx[k] || {}).length; return n ? '<button class="vlc-fchip' + (_memTreeAxis === k ? ' on' : '') + '" data-mt-axis="' + k + '">' + label + ' <span class="vlc-fchip-n">' + n + '</span></button>' : ''; };
  html += '<div class="vlc-mt-axes"><div class="vlc-fbar">' + axisBtn('characters', 'Characters') + axisBtn('topics', 'Topics') + axisBtn('plots', 'Plots') + axisBtn('days', 'Days') + '</div>';
  if (_memTreeAxis && idx[_memTreeAxis]) {
    const entries = Object.entries(idx[_memTreeAxis]).sort((a, b) => b[1] - a[1]);
    html += '<div class="vlc-mt-axislist">' + entries.map(([k, n]) => '<span class="vlc-mt-axitem">' + escapeHtml(k) + ' <em>' + n + '</em></span>').join('') + '</div>';
  }
  html += '</div>';
  // stash arc options for the move prompt
  html += '<div data-mt-arcopts hidden>' + arcOpts + '</div>';
  return html;
}

function memoryList(memories) {
  if (!memories || !memories.length) {
    return '<div class="vlc-empty">No chapter memories yet.<br><span style="opacity:.7;font-size:10px">Older turns are auto-summarized in the background as the story grows.</span></div>';
  }
  const ordered = memories.slice().reverse();
  const { slice, pager } = paginate(ordered, 'pg_mem', 8);
  const rows = slice.map((m, i) => {
    const span = 't' + m.fromTurn + (m.toTurn !== m.fromTurn ? '\u2013' + m.toTurn : '');
    const chips = (m.keywords || []).slice(0, 12).map((k) => '<span class="vlc-kw">' + escapeHtml(k) + '</span>').join('');
    const preview = String(m.text || '').slice(0, 60).replace(/\s+\S*$/, '');
    const open = i === 0 ? ' open' : '';
    return '<details class="vlc-mem"' + open + ' data-mem-id="' + escapeHtml(m.id || '') + '">'
      + '<summary class="vlc-mem-sum"><span class="vlc-mem-span">' + escapeHtml(dayLabel(m.day)) + ' \u00B7 ' + span + '</span>'
      + '<span class="vlc-mem-prev">' + escapeHtml(preview) + '\u2026</span>'
      + '<button class="vlc-mem-edit" data-mem-edit title="Edit this summary">\u270E</button>'
      + '<button class="vlc-mem-del" data-mem-del title="Delete this summary">\u2715</button></summary>'
      + '<div class="vlc-mem-body">'
      + '<div class="vlc-mem-t" data-mem-text>' + escapeHtml(m.text) + '</div>'
      + (chips ? '<div class="vlc-mem-kw">' + chips + '</div>' : '')
      + '<div class="vlc-mem-kw-raw" data-mem-kw hidden>' + escapeHtml((m.keywords || []).join(', ')) + '</div>'
      + '</div></details>';
  }).join('');
  const clearBtn = '<div class="vlc-mem-bar"><button class="vlc-mem-clear" data-mem-clear>\u2715 Clear all summaries</button></div>';
  return '<div class="vlc-mems">' + rows + '</div>' + pager + clearBtn;
}

// One track (arc or thread) with its evolution timeline.
function trackCard(t, grp) {
  const hist = (t.history || []);
  const current = t.status || (hist.length ? hist[hist.length - 1].status : '');
  const span = (t.firstDay && t.lastDay && t.firstDay !== t.lastDay)
    ? dayLabel(t.firstDay) + ' → ' + dayLabel(t.lastDay)
    : dayLabel(t.lastDay || t.firstDay);
  let steps = '';
  if (hist.length > 1) {
    steps = '<div class="vlc-evo">' + hist.map((h, i) => {
      const cls = i === hist.length - 1 ? 'vlc-step now' : 'vlc-step';
      return '<div class="' + cls + '"><span class="vlc-step-d">' + escapeHtml(dayLabel(h.day)) + '</span>'
        + '<span class="vlc-step-t">' + escapeHtml(h.status || '—') + '</span></div>';
    }).join('') + '</div>';
  }
  const toggle = hist.length > 1 ? '<button class="vlc-evo-toggle" data-evo>▾ ' + hist.length + ' beats</button>' : '';
  const g = grp === 'threads' ? 'thread' : 'arc';
  const ctl = '<span class="vlc-row-ctl">'
    + '<button class="vlc-mini-edit" data-track-edit data-group="' + g + '" data-id="' + escapeHtml(t.id) + '" data-title="' + escapeHtml(t.title || '') + '" data-status="' + escapeHtml(current || '') + '" title="Edit">✎</button>'
    + '<button class="vlc-mini-del" data-track-del data-group="' + g + '" data-id="' + escapeHtml(t.id) + '" title="Delete">✕</button></span>';
  return '<div class="vlc-track">'
    + '<div class="vlc-track-h"><span class="vlc-track-name">' + escapeHtml(t.title || t.id) + '</span>'
    + '<span class="vlc-track-span">' + escapeHtml(span) + '</span>' + ctl + '</div>'
    + '<div class="vlc-track-now">' + escapeHtml(current || '—') + '</div>'
    + toggle + steps + '</div>';
}

// Paginated chronological log (events or shifts), newest first.
function logList(items, icon, key, kind) {
  if (!items || !items.length) return '<div class="vlc-empty">Nothing recorded yet.</div>';
  // Group near-identical entries so a recurring event/shift reads as ONE topic
  // evolving across days, instead of many repeated rows.
  const groups = logGroup(items);
  const { slice, pager } = paginate(groups, key, PER_LOG);
  const ctl = (e) => '<span class="vlc-row-ctl">'
    + '<button class="vlc-mini-edit" data-log-edit data-kind="' + kind + '" data-id="' + escapeHtml(e.id || '') + '" data-text="' + escapeHtml(e.text || '') + '" data-day="' + (e.day || '') + '" title="Edit">✎</button>'
    + '<button class="vlc-mini-del" data-log-del data-kind="' + kind + '" data-id="' + escapeHtml(e.id || '') + '" title="Delete">✕</button></span>';
  const html = slice.map((g) => {
    const ents = g.entries.slice().sort((a, b) => a.idx - b.idx); // oldest→newest (evolution reads downward)
    if (ents.length === 1) {
      const e = ents[0];
      return '<div class="vlc-log-row"><span class="vlc-log-d">' + escapeHtml(dayLabel(e.day)) + '</span>'
        + '<span class="vlc-log-x">' + icon + '</span>'
        + '<span class="vlc-log-t">' + escapeHtml(e.text) + '</span>' + ctl(e) + '</div>';
    }
    const steps = ents.map((e, i) =>
      '<div class="vlc-eg-step' + (i === ents.length - 1 ? ' now' : '') + '">'
      + '<span class="vlc-eg-d">' + escapeHtml(dayLabel(e.day)) + '</span>'
      + '<span class="vlc-eg-t">' + escapeHtml(e.text) + '</span>' + ctl(e) + '</div>'
    ).join('');
    return '<details class="vlc-eg" open><summary class="vlc-eg-sum">'
      + '<span class="vlc-log-x">' + icon + '</span>'
      + '<span class="vlc-eg-l">' + escapeHtml(logGroupLabel(ents)) + '</span>'
      + '<span class="vlc-eg-n">' + ents.length + '</span></summary>'
      + '<div class="vlc-eg-body">' + steps + '</div></details>';
  }).join('');
  return '<div class="vlc-log">' + html + '</div>' + pager;
}

const LOG_STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'her', 'his', 'she', 'they', 'them', 'from', 'into', 'about', 'was', 'were', 'are', 'has', 'have', 'had', 'its', 'but', 'not', 'now', 'one', 'day', 'all', 'who', 'what', 'when', 'where', 'his', 'their']);
function logTokens(t) {
  return (String(t).toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !LOG_STOP.has(w));
}
// Key tokens for similarity: prefer the subject before a ':' (shifts like
// "Cersei-Daeron: …"), else the whole text's distinctive tokens.
function logKeyTokens(t) {
  const c = String(t).indexOf(':');
  const head = c > 0 && c < 40 ? t.slice(0, c) : t;
  const ht = logTokens(head);
  return ht.length ? ht : logTokens(t);
}
function logJaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; A.forEach((x) => { if (B.has(x)) inter++; });
  return inter / (A.size + B.size - inter);
}
function logSubject(text) {
  const c = String(text).indexOf(':');
  if (c > 0 && c < 40) {
    const head = String(text).slice(0, c).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    // Relationship shifts name two parties ("Alice-Bob" / "Bob & Alice"). After
    // normalization the separator is a space, so treat the subject as an
    // UNORDERED set of tokens — sort them so "A B" and "B A" produce the same
    // key and group together as one evolving bond.
    const toks = head.split(/\s+/).filter(Boolean);
    return toks.slice().sort().join(' ');
  }
  return null;
}
function logGroup(items) {
  const groups = [];
  items.forEach((e, idx) => {
    const subject = logSubject(e.text);
    const toks = logKeyTokens(e.text);
    let best = null, bestScore = 0;
    for (const g of groups) {
      let sc = 0;
      if (subject && g.subject) sc = (subject === g.subject) ? 1 : 0;     // shifts: exact subject only
      else if (!subject && !g.subject) sc = logOverlap(toks, g.tokens);    // events: token containment
      if (sc > bestScore) { bestScore = sc; best = g; }
    }
    const bar = subject ? 1 : 0.34;
    if (best && bestScore >= bar) {
      best.entries.push({ day: e.day, text: e.text, idx, id: e.id });
      best.tokens = Array.from(new Set(best.tokens.concat(toks)));
      best.lastIdx = Math.max(best.lastIdx, idx);
    } else {
      groups.push({ subject, tokens: toks, entries: [{ day: e.day, text: e.text, idx, id: e.id }], lastIdx: idx });
    }
  });
  groups.sort((a, b) => b.lastIdx - a.lastIdx);
  return groups;
}
// Shared tokens relative to the smaller set (containment), better than Jaccard
// for grouping a short entry with a longer elaboration of the same topic.
function logOverlap(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; A.forEach((x) => { if (B.has(x)) inter++; });
  return inter / Math.min(A.size, B.size);
}
// Label for a grouped topic: the subject before ':' if present, else the first
// few distinctive words of the earliest entry.
function logGroupLabel(ents) {
  const t = ents[0].text;
  const c = t.indexOf(':');
  if (c > 0 && c < 40) return t.slice(0, c).trim();
  const words = t.split(/\s+/).slice(0, 6).join(' ');
  return words.length < t.length ? words + '…' : words;
}
// Paginated section of track cards (arcs or threads).
function trackSection(grp, icon, title, tracks, emptyMsg) {
  const g = grp === 'threads' ? 'thread' : 'arc';
  const addBtn = '<button class="vlc-add-btn" data-track-add data-group="' + g + '">+ Add</button>';
  const head = '<h3 class="vlc-h">' + icon + ' ' + title + ' <span class="vlc-h-n">' + tracks.length + '</span>' + addBtn + '</h3>';
  if (!tracks.length) return '<section data-grp="' + grp + '">' + head + '<div class="vlc-empty">' + emptyMsg + '</div></section>';
  const { slice, pager } = paginate(tracks, 'pg_' + grp, PER_TRACK);
  return '<section data-grp="' + grp + '">' + head + slice.map((t) => trackCard(t, grp)).join('') + pager + '</section>';
}

function renderChronicle(host, ch) {
  if (host) _chronHost = host;
  if (ch) _chronCh = ch;
  host = _chronHost; ch = _chronCh;
  if (!host) return;
  if (!ch || (!Object.keys(ch.arcs || {}).length && !Object.keys(ch.threads || {}).length && !(ch.events || []).length && !(ch.shifts || []).length)) {
    host.innerHTML = '<div class="vlc-empty big">✦<br>No chronicle yet.<br><span>Play a few turns, or rescan the history below.</span></div>';
    return;
  }
  const arcs = sortTracks(ch.arcs);
  const threads = sortTracks(ch.threads);
  const stat = '<div class="vlc-stat">'
    + '<span><b>' + arcs.length + '</b> arcs</span>'
    + '<span><b>' + threads.length + '</b> threads</span>'
    + '<span><b>' + (ch.events || []).length + '</b> events</span>'
    + '<span><b>' + (ch.shifts || []).length + '</b> shifts</span>'
    + '<span><b>' + ((ch.memories || []).length) + '</b> memories</span>'
    + '<span><b>' + (ch.turns || 0) + '</b> turns · ' + escapeHtml(dayLabel(ch.lastDay)) + '</span>'
    + '</div>';

  host.innerHTML = stat
    + '<section data-grp="memories"><h3 class="vlc-h">✦ Chapter Memories <span class="vlc-h-n">' + ((ch.memories || []).length) + '</span><button class="vlc-add-btn" data-memory-add>+ Add</button></h3>' + memoryList(ch.memories) + '</section>'
    + '<div class="vlc-break"></div>'
    + '<section data-grp="memtree"><h3 class="vlc-h">🌳 Memory Tree <button class="vlc-add-btn" data-memtree-build>⟲ Build / Rebuild</button><button class="vlc-add-btn" data-memtree-addarc>+ Arc</button></h3><div data-vlc-memtree>' + memTreeHtml(_memTree) + '</div></section>'
    + '<div class="vlc-break"></div>'
    + trackSection('arcs', '📜', 'Character Arcs', arcs, 'No character arcs tracked yet.')
    + '<div class="vlc-break"></div>'
    + trackSection('threads', '🧵', 'Plot Threads', threads, 'No plot threads tracked yet.')
    + '<div class="vlc-break"></div>'
    + '<section data-grp="events"><h3 class="vlc-h">🌊 Parallel & Off-screen Events <span class="vlc-h-n">' + (ch.events || []).length + '</span><button class="vlc-add-btn" data-log-add data-kind="event">+ Add</button></h3>' + logList(ch.events, '▸', 'pg_events', 'event') + '</section>'
    + '<div class="vlc-break"></div>'
    + '<section data-grp="shifts"><h3 class="vlc-h">⚲ Narrative Shifts <span class="vlc-h-n">' + (ch.shifts || []).length + '</span><button class="vlc-add-btn" data-log-add data-kind="shift">+ Add</button></h3>' + logList(ch.shifts, '⚲', 'pg_shifts', 'shift') + '</section>'
    + '<div class="vlc-break"></div>'
    + '<section data-grp="date"><h3 class="vlc-h">🗓 Timeline by Day</h3>' + byDateHtml(ch) + '</section>'
    + '<div class="vlc-break"></div>'
    + '<section data-grp="lore"><h3 class="vlc-h">🔑 Knowledge &amp; Secrets <span class="vlc-h-n">' + ((ch.knowledge || []).length + (ch.secrets || []).length) + '</span></h3>'
      + '<div class="vlc-lore-bar"><button class="vlc-btn" data-scan-knowledge>🔑 Scan knowledge</button><button class="vlc-btn" data-knowledge-add>+ Knowledge</button><button class="vlc-btn" data-secret-add>+ Secret</button></div>'
      + knowledgeHtml(ch) + '</section>'
    + '<div class="vlc-break"></div>'
    + '<section data-grp="injection"><h3 class="vlc-h">⇲ Injected into Chat</h3><div data-vlc-inj>' + injectionHtml(_lastInjection) + '</div></section>';

  wireChronicleControls(host);
}

function wireChronicleControls(host) {
  host.querySelectorAll('[data-evo]').forEach((btn) => {
    const evo = btn.nextElementSibling;
    if (evo) evo.style.display = 'none';
    btn.addEventListener('click', () => {
      const open = evo.style.display !== 'none';
      evo.style.display = open ? 'none' : 'block';
      btn.textContent = (open ? '▾ ' : '▴ ') + btn.textContent.replace(/^[▾▴]\s*/, '');
    });
  });
  // Delete a single chapter summary.
  host.querySelectorAll('[data-mem-del]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const det = btn.closest('[data-mem-id]');
      const id = det && det.getAttribute('data-mem-id');
      if (id && _ctx) _ctx.sendToBackend({ type: 'memory_delete', chatId: _getChatId(), id });
    });
  });
  // Edit a single chapter summary (inline form: text + keywords).
  host.querySelectorAll('[data-mem-edit]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const det = btn.closest('[data-mem-id]');
      if (!det) return;
      if (!det.open) det.open = true;
      const body = det.querySelector('.vlc-mem-body');
      if (!body || body.querySelector('.vlc-mem-editform')) return; // already editing
      const id = det.getAttribute('data-mem-id');
      const curText = (det.querySelector('[data-mem-text]') || {}).textContent || '';
      const curKw = (det.querySelector('[data-mem-kw]') || {}).textContent || '';
      const form = document.createElement('div');
      form.className = 'vlc-mem-editform';
      form.innerHTML =
        '<textarea class="vlc-cf-in vlc-mem-ta" data-ef="text">' + escapeHtml(curText) + '</textarea>'
        + '<input class="vlc-cf-in" data-ef="kw" placeholder="Keywords (comma-separated)" value="' + escapeHtml(curKw) + '">'
        + '<div class="vlc-cf-btns"><button class="vlc-cf-save" data-ef-save>Save</button><button class="vlc-cf-cancel" data-ef-cancel>Cancel</button></div>';
      body.appendChild(form);
      const ta = form.querySelector('[data-ef="text"]'); if (ta) ta.focus();
      form.querySelector('[data-ef-save]').addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const text = (form.querySelector('[data-ef="text"]') || {}).value || '';
        const kw = (form.querySelector('[data-ef="kw"]') || {}).value || '';
        if (id && _ctx) _ctx.sendToBackend({ type: 'memory_edit', chatId: _getChatId(), id, text, keywords: kw });
        form.remove();
      });
      form.querySelector('[data-ef-cancel]').addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        form.remove();
      });
    });
  });
  // Clear all chapter summaries (resets coverage so they can be regenerated).
  const clearBtn = host.querySelector('[data-mem-clear]');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    if (clearBtn._armed) {
      if (_ctx) _ctx.sendToBackend({ type: 'memory_clear', chatId: _getChatId() });
      clearBtn._armed = false;
    } else {
      clearBtn._armed = true;
      clearBtn.textContent = '\u2715 Click again to confirm';
      setTimeout(() => { clearBtn._armed = false; clearBtn.textContent = '\u2715 Clear all summaries'; }, 4000);
    }
  });
  host.querySelectorAll('[data-pg-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const key = btn.getAttribute('data-pg-key');
      const dir = parseInt(btn.getAttribute('data-pg-dir'), 10) || 0;
      _chronPage[key] = Math.max(0, (_chronPage[key] || 0) + dir);
      renderChronicle();
    });
  });
  // Knowledge reliability filter chips.
  host.querySelectorAll('[data-know-filter]').forEach((btn) => {
    btn.addEventListener('click', () => { _knowFilter = btn.getAttribute('data-know-filter') || 'all'; renderChronicle(); });
  });
  // Secret danger filter chips.
  host.querySelectorAll('[data-sec-filter]').forEach((btn) => {
    btn.addEventListener('click', () => { _secFilter = btn.getAttribute('data-sec-filter') || 'all'; renderChronicle(); });
  });
  // Sort direction (knowledge + secrets): newest/oldest by reveal turn.
  host.querySelectorAll('[data-sort]').forEach((btn) => {
    btn.addEventListener('click', () => { _sortDir = btn.getAttribute('data-sort') === 'asc' ? 'asc' : 'desc'; renderChronicle(); });
  });

  // ---- manual CRUD across all chronicle types (delegated; inline-form driven) ----
  if (!host._vlcCrudWired) {
    host._vlcCrudWired = true;
    const send = (msg) => { if (_ctx) _ctx.sendToBackend(Object.assign({ chatId: _getChatId() }, msg)); };
    const A = (el, n) => el.getAttribute(n) || '';
    const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : undefined; };
    host.addEventListener('click', (e) => {
      const t = e.target;
      // Arcs / threads
      let b = t.closest('[data-track-add]');
      if (b) { const g = A(b, 'data-group'); const noun = g === 'thread' ? 'Plot Thread' : 'Character Arc';
        vlcFormModal('New ' + noun, [
          { key: 'title', label: 'Title', type: 'text', placeholder: noun + ' title' },
          { key: 'status', label: 'Current status / beat', type: 'textarea', placeholder: 'What\u2019s happening with it now (optional)' },
        ], (v) => { if (v.title && v.title.trim()) send({ type: 'track_add', group: g, title: v.title.trim(), status: v.status || '' }); });
        return; }
      b = t.closest('[data-track-edit]');
      if (b) { e.preventDefault(); e.stopPropagation(); const g = A(b, 'data-group');
        vlcFormModal('Edit ' + (g === 'thread' ? 'Thread' : 'Arc'), [
          { key: 'title', label: 'Title', type: 'text', value: A(b, 'data-title') },
          { key: 'status', label: 'Current status / beat', type: 'textarea', value: A(b, 'data-status') },
        ], (v) => send({ type: 'track_edit', group: g, id: A(b, 'data-id'), title: (v.title || '').trim(), status: v.status }));
        return; }
      b = t.closest('[data-track-del]');
      if (b) { if (confirm('Delete this ' + (A(b, 'data-group') === 'thread' ? 'thread' : 'arc') + '?')) send({ type: 'track_delete', group: A(b, 'data-group'), id: A(b, 'data-id') }); return; }
      // Events / shifts
      b = t.closest('[data-log-add]');
      if (b) { const kind = A(b, 'data-kind'); const noun = kind === 'shift' ? 'Narrative Shift' : 'Event';
        vlcFormModal('New ' + noun, [
          { key: 'text', label: noun, type: 'textarea', placeholder: kind === 'shift' ? 'e.g. Cersei-Daeron: warming' : 'What happened off-screen / in parallel' },
          { key: 'day', label: 'Story day (number)', type: 'text', placeholder: 'optional' },
        ], (v) => { if (v.text && v.text.trim()) send({ type: 'log_add', kind, text: v.text.trim(), day: num(v.day) }); });
        return; }
      b = t.closest('[data-log-edit]');
      if (b) { e.preventDefault(); e.stopPropagation(); const kind = A(b, 'data-kind');
        vlcFormModal('Edit ' + (kind === 'shift' ? 'Shift' : 'Event'), [
          { key: 'text', label: 'Text', type: 'textarea', value: A(b, 'data-text') },
          { key: 'day', label: 'Story day (number)', type: 'text', value: A(b, 'data-day') },
        ], (v) => send({ type: 'log_edit', kind, id: A(b, 'data-id'), text: (v.text || '').trim(), day: num(v.day) }));
        return; }
      b = t.closest('[data-log-del]');
      if (b) { e.preventDefault(); e.stopPropagation(); if (confirm('Delete this entry?')) send({ type: 'log_delete', kind: A(b, 'data-kind'), id: A(b, 'data-id') }); return; }
      // Knowledge
      b = t.closest('[data-knowledge-add]');
      if (b) {
        vlcFormModal('New Knowledge', [
          { key: 'who', label: 'Who holds it', type: 'text', placeholder: 'character name' },
          { key: 'fact', label: 'What they know / believe', type: 'textarea', placeholder: 'the fact' },
          { key: 'reliability', label: 'Reliability', type: 'select', value: 'knows', options: REL_OPTS },
          { key: 'truth', label: 'Actual truth', type: 'select', value: 'unknown', options: TRUTH_OPTS },
          { key: 'source', label: 'Source', type: 'text', placeholder: 'how they got it (optional)' },
        ], (v) => { if (v.who && v.who.trim() && v.fact && v.fact.trim()) send({ type: 'knowledge_add', entry: v }); });
        return; }
      b = t.closest('[data-know-edit]');
      if (b) {
        vlcFormModal('Edit Knowledge', [
          { key: 'who', label: 'Who holds it', type: 'text', value: A(b, 'data-who') },
          { key: 'fact', label: 'Fact', type: 'textarea', value: A(b, 'data-fact') },
          { key: 'reliability', label: 'Reliability', type: 'select', value: A(b, 'data-reliability') || 'knows', options: REL_OPTS },
          { key: 'truth', label: 'Actual truth', type: 'select', value: A(b, 'data-truth') || 'unknown', options: TRUTH_OPTS },
          { key: 'source', label: 'Source', type: 'text', value: A(b, 'data-source') },
        ], (v) => send({ type: 'knowledge_edit', id: A(b, 'data-id'), entry: v }));
        return; }
      // Secrets
      b = t.closest('[data-secret-add]');
      if (b) {
        vlcFormModal('New Secret', [
          { key: 'secret', label: 'The concealed thing', type: 'textarea', placeholder: 'the secret' },
          { key: 'keeper', label: 'Who keeps it', type: 'text', placeholder: 'character name' },
          { key: 'from', label: 'Hidden from', type: 'text', placeholder: 'who must not find out (optional)' },
          { key: 'exposure', label: 'How it might surface', type: 'text', placeholder: 'optional' },
          { key: 'danger', label: 'Danger', type: 'select', value: 'major', options: DANGER_OPTS },
        ], (v) => { if (v.secret && v.secret.trim() && v.keeper && v.keeper.trim()) send({ type: 'secret_add', entry: v }); });
        return; }
      b = t.closest('[data-secret-edit]');
      if (b) {
        vlcFormModal('Edit Secret', [
          { key: 'secret', label: 'Secret', type: 'textarea', value: A(b, 'data-secret') },
          { key: 'keeper', label: 'Keeper', type: 'text', value: A(b, 'data-keeper') },
          { key: 'from', label: 'Hidden from', type: 'text', value: A(b, 'data-from') },
          { key: 'exposure', label: 'How it might surface', type: 'text', value: A(b, 'data-exposure') },
          { key: 'danger', label: 'Danger', type: 'select', value: A(b, 'data-danger') || 'major', options: DANGER_OPTS },
        ], (v) => send({ type: 'secret_edit', id: A(b, 'data-id'), entry: v }));
        return; }
      // Memory journal
      b = t.closest('[data-mj-add]');
      if (b) { const who = A(b, 'data-who');
        vlcFormModal('New Memory \u2014 ' + who, [
          { key: 'memory', label: 'Memory', type: 'textarea', placeholder: 'what ' + who + ' remembers' },
          { key: 'about', label: 'About whom', type: 'text', placeholder: 'who/what it concerns (optional)' },
          { key: 'weight', label: 'Weight', type: 'select', value: 'minor', options: WEIGHT_OPTS },
          { key: 'sentiment', label: 'Sentiment', type: 'select', value: 'neutral', options: SENT_OPTS },
        ], (v) => { if (v.memory && v.memory.trim()) send({ type: 'mem_add', entry: Object.assign({ who }, v) }); });
        return; }
      b = t.closest('[data-mj-edit]');
      if (b) { e.preventDefault(); e.stopPropagation();
        vlcFormModal('Edit Memory', [
          { key: 'memory', label: 'Memory', type: 'textarea', value: A(b, 'data-memory') },
          { key: 'about', label: 'About whom', type: 'text', value: A(b, 'data-about') },
          { key: 'weight', label: 'Weight', type: 'select', value: A(b, 'data-weight') || 'minor', options: WEIGHT_OPTS },
          { key: 'sentiment', label: 'Sentiment', type: 'select', value: A(b, 'data-sentiment') || 'neutral', options: SENT_OPTS },
        ], (v) => send({ type: 'mem_edit', charKey: A(b, 'data-key'), id: A(b, 'data-id'), entry: v }));
        return; }
      // Chapter memory add
      b = t.closest('[data-memory-add]');
      if (b) {
        vlcFormModal('New Chapter Memory', [
          { key: 'text', label: 'Summary', type: 'textarea', placeholder: 'a dense recap of this chapter' },
          { key: 'keywords', label: 'Keywords', type: 'text', placeholder: 'comma-separated (optional)' },
        ], (v) => { if (v.text && v.text.trim()) send({ type: 'memory_add', entry: v }); });
        return; }
      // ---- Memory Tree ----
      b = t.closest('[data-memtree-build]');
      if (b) { send({ type: 'build_memtree' }); return; }
      b = t.closest('[data-memtree-addarc]');
      if (b) { const title = ''; vlcFormModal('New Arc', [{ key: 'title', label: 'Arc name', type: 'text', placeholder: 'e.g. The Reluctant Betrothal' }], (v) => { if (v.title && v.title.trim()) send({ type: 'memtree_add_arc', title: v.title.trim() }); }); return; }
      b = t.closest('[data-mt-edit]');
      if (b) { e.preventDefault(); e.stopPropagation(); const id = A(b, 'data-id'); vlcFormModal('Edit Arc', [
          { key: 'title', label: 'Arc name', type: 'text', value: A(b, 'data-title') },
          { key: 'gist', label: 'Gist', type: 'textarea', value: A(b, 'data-gist') },
        ], (v) => send({ type: 'memtree_edit', arcId: id, patch: v })); return; }
      b = t.closest('[data-mt-del]');
      if (b) { e.preventDefault(); e.stopPropagation(); if (confirm('Delete this arc? Its chapters become unassigned.')) send({ type: 'memtree_delete_arc', arcId: A(b, 'data-id') }); return; }
      b = t.closest('[data-mt-move]');
      if (b) {
        const id = A(b, 'data-id');
        const opts = (_memTree && _memTree.arcs || []).map((a, i) => (i + 1) + '. ' + a.title);
        const pick = prompt('Move chapter to which arc?\n0. (Unassigned)\n' + opts.join('\n') + '\n\nEnter number:');
        if (pick === null) return;
        const n = parseInt(pick, 10);
        const arcId = (n >= 1 && _memTree.arcs[n - 1]) ? _memTree.arcs[n - 1].id : null;
        send({ type: 'memtree_move', chapterId: id, arcId });
        return; }
      b = t.closest('[data-mt-axis]');
      if (b) { _memTreeAxis = (_memTreeAxis === A(b, 'data-mt-axis')) ? '' : A(b, 'data-mt-axis'); const mh = host.querySelector('[data-vlc-memtree]'); if (mh) mh.innerHTML = memTreeHtml(_memTree); return; }
    });
  }
}
// Group every dated entry (arc beats, thread beats, events, shifts) by story day.
function groupByDate(ch) {
  const days = {};
  const ensure = (d) => (days[d] = days[d] || { arcs: [], threads: [], events: [], shifts: [] });
  Object.values(ch.arcs || {}).forEach((t) => {
    (t.history || []).forEach((h) => ensure(h.day || 0).arcs.push({ title: t.title, status: h.status }));
  });
  Object.values(ch.threads || {}).forEach((t) => {
    (t.history || []).forEach((h) => ensure(h.day || 0).threads.push({ title: t.title, status: h.status }));
  });
  (ch.events || []).forEach((e) => ensure(e.day || 0).events.push(e.text));
  (ch.shifts || []).forEach((s) => ensure(s.day || 0).shifts.push(s.text));
  return Object.keys(days).map(Number).sort((a, b) => b - a).map((d) => Object.assign({ day: d }, days[d]));
}

// Uniform date-row: every entry renders as [kind tag] · label · detail.
function dateRow(tag, label, detail) {
  const l = label ? '<span class="vlc-dr-l">' + escapeHtml(label) + '</span>' : '';
  const d = detail ? '<span class="vlc-dr-d">' + escapeHtml(detail) + '</span>' : '';
  return '<div class="vlc-dr"><span class="vlc-dr-t vlc-dr-' + tag + '">' + tag.toUpperCase() + '</span>' + l + d + '</div>';
}

// Paginated, uniform date-grouped timeline. Newest day expanded; older collapsed.
function byDateHtml(ch) {
  const groups = groupByDate(ch);
  if (!groups.length) return '<div class="vlc-empty">No dated entries yet.</div>';
  const { slice, pager, start } = paginate(groups, 'pg_date', PER_DATE);
  const body = slice.map((g, i) => {
    const open = (start + i === 0) ? ' open' : '';
    const count = g.arcs.length + g.threads.length + g.events.length + g.shifts.length;
    let rows = '';
    g.arcs.forEach((a) => { rows += dateRow('arc', a.title, a.status || '—'); });
    g.threads.forEach((a) => { rows += dateRow('thread', a.title, a.status || '—'); });
    g.events.forEach((t) => { rows += dateRow('event', '', t); });
    g.shifts.forEach((t) => { rows += dateRow('shift', '', t); });
    return '<details class="vlc-day"' + open + '><summary><span class="vlc-day-t">' + escapeHtml(dayLabel(g.day))
      + '</span><span class="vlc-day-c">' + count + '</span></summary><div class="vlc-day-body">' + rows + '</div></details>';
  }).join('');
  return body + pager;
}

const CHRONICLE_HTML =
  '<div class="vlc-head"><div class="vlc-title">The Chronicle</div>'
  + '<div class="vlc-sub">Long-term continuity — arcs, threads, events & shifts, and how they evolved</div></div>'
  + '<div class="vlc-bar">'
  + '<button class="vlc-btn on" data-vlc-filter="all" data-view-btn>All</button>'
    + '<button class="vlc-btn" data-vlc-filter="memories">Memories</button>'
    + '<button class="vlc-btn" data-vlc-filter="memtree">🌳 Tree</button>'
  + '<button class="vlc-btn" data-vlc-filter="arcs">Arcs</button>'
  + '<button class="vlc-btn" data-vlc-filter="threads">Threads</button>'
  + '<button class="vlc-btn" data-vlc-filter="events">Events</button>'
  + '<button class="vlc-btn" data-vlc-filter="shifts">Shifts</button>'
  + '<button class="vlc-btn" data-vlc-filter="date">By Date</button>'
  + '<button class="vlc-btn" data-vlc-filter="lore">Knowledge</button>'
  + '<button class="vlc-btn" data-vlc-filter="injection">Injection</button>'
  + '<button class="vlc-btn ghost" data-vlc-refresh title="Refresh">⟳</button>'
  + '</div>'
  + '<div class="vlc-body" data-vlc-body><div class="vlc-empty big">✦<br>Loading chronicle…</div></div>'
  + '<div class="vlc-actions">'
  + '<button class="vlc-rebuild" data-vlc-rebuild>⟲ Rescan tracker</button>'
  + '<button class="vlc-summ" data-vlc-summarize>✦ Summarize past turns</button>'
  + '</div>'
  + '<div class="vlc-actions vlc-actions-2">'
  + '<button class="vlc-open" data-vlc-open>✦ Open live ledger window</button>'
  + '</div>'
  + '<div class="vlc-actions vlc-actions-2">'
  + '<button class="vlc-import" data-vlc-import>⬆ Import chat history</button>'
  + '<button class="vlc-clear-all" data-vlc-clear-all>🗑 Clear all data</button>'
  + '</div>'
  + '<input type="file" data-vlc-import-file accept=".json,.jsonl,.txt,.md,.log,application/json,text/plain" style="display:none">';

const CAST_ICON_SVG = '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="7" cy="6.5" r="3" stroke="#cda84e" stroke-width="1.4"/><path d="M2 17c0-2.8 2.2-5 5-5s5 2.2 5 5" stroke="#cda84e" stroke-width="1.4" stroke-linecap="round"/><circle cx="14" cy="7" r="2.3" stroke="#cda84e" stroke-width="1.2" opacity=".7"/><path d="M12.5 16.5c0-2 1.4-3.7 3.3-4.1" stroke="#cda84e" stroke-width="1.2" stroke-linecap="round" opacity=".7"/></svg>';

const CAST_HTML =
  '<div class="vlc-head"><div class="vlc-title">The Cast</div>'
  + '<div class="vlc-sub">Characters in the narrative \u2014 present, active, mentioned & your own</div></div>'
  + '<div class="vlc-bar">'
  + '<button class="vlc-btn on" data-cast-filter="all">All</button>'
  + '<button class="vlc-btn" data-cast-filter="present">\u25C9 Present</button>'
  + '<button class="vlc-btn" data-cast-filter="active">\u25CB Active</button>'
  + '<button class="vlc-btn" data-cast-filter="mentioned">\u2027 Mentioned</button>'
    + '<button class="vlc-btn" data-cast-filter="added">\u2605 Added</button>'
    + '<button class="vlc-btn" data-cast-filter="relations">\u21CE Relations</button>'
    + '<button class="vlc-btn" data-cast-filter="journal">\uD83D\uDCD6 Journal</button>'
  + '<button class="vlc-btn ghost" data-cast-refresh title="Refresh">\u27F3</button>'
  + '<button class="vlc-btn" data-cast-scan>\u2756 Scan</button>'
  + '<button class="vlc-btn" data-cast-add>+ Add</button>'
  + '</div>'
  + '<div class="vlc-cast-form" data-cast-form hidden></div>'
  + '<div class="vlc-body" data-cast-body><div class="vlc-empty big">\u2726<br>Loading cast\u2026</div></div>';

function castInitials(name) {
  const p = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

function castCard(c, present) {
  const cls = present ? ' present' : (c.source === 'user' ? ' user' : (c.status === 'mentioned' ? ' mentioned' : ''));
  const stats = [];
  if (c.age) stats.push('<span class="vlc-cc-s"><i>Age</i>' + escapeHtml(c.age) + '</span>');
  if (c.appearance) stats.push('<span class="vlc-cc-s"><i>Looks</i>' + escapeHtml(c.appearance) + '</span>');
  if (c.role) stats.push('<span class="vlc-cc-s"><i>Role</i>' + escapeHtml(c.role) + '</span>');
  if (c.note) stats.push('<span class="vlc-cc-s"><i>Note</i>' + escapeHtml(c.note) + '</span>');
  const statsHtml = stats.length ? '<div class="vlc-cc-stats">' + stats.join('') + '</div>' : '<div class="vlc-cc-empty">No details yet \u2014 Scan or edit.</div>';
  const yours = c.source === 'user' ? '<span class="vlc-cc-badge" title="Your character">\u2605</span>' : '';
  const move = '<select class="vlc-cc-move" data-cc-move title="Move to category">'
    + '<option value="">Move\u2026</option>'
    + '<option value="present">\u25C9 Present</option>'
    + '<option value="active">\u25CB Active</option>'
    + '<option value="mentioned">\u2027 Mentioned</option>'
    + '<option value="added">\u2605 Added</option>'
    + '</select>';
  return '<div class="vlc-cc' + cls + '" data-cc-id="' + escapeHtml(c.id) + '">'
    + '<div class="vlc-cc-av">' + escapeHtml(castInitials(c.name)) + '</div>'
    + '<div class="vlc-cc-b"><div class="vlc-cc-n">' + yours + escapeHtml(c.name)
    + '<span class="vlc-cc-actions">' + move
    + '<button class="vlc-cc-edit" data-cc-edit title="Edit">\u270E</button>'
    + '<button class="vlc-cc-del" data-cc-del title="Remove">\u2715</button></span></div>'
    + ((c.aka && c.aka.length) ? '<div class="vlc-cc-aka">aka ' + escapeHtml(c.aka.join(' \u00B7 ')) + '</div>' : '')
    + statsHtml + '</div></div>';
}

function castGroup(grp, title, hint, arr, present) {
  const head = '<h3 class="vlc-h">' + title + ' <span class="vlc-h-n">' + arr.length + '</span></h3>';
  if (!arr.length) return '<section data-grp="' + grp + '">' + head + '<div class="vlc-empty">' + hint + '</div></section>';
  return '<section data-grp="' + grp + '">' + head + arr.map((c) => castCard(c, present)).join('') + '</section>';
}

// Relations panel: edges between cast members, grouped under each character,
// with category filter chips. Label is shown from the edge's `a` perspective;
// the reverse view shows the raw "A ↔ B" so wording stays accurate.
function relationsHtml(ch) {
  const rels = (ch && ch.relations) || [];
  if (!rels.length) {
    return '<div class="vlc-empty">No relations yet.<br><span style="opacity:.7;font-size:10px">Hit \u2756 Scan to auto-map bonds, or + Relation to add one (e.g. \u201cCersei \u2014 Tywin\u2019s daughter / familial\u201d).</span></div>';
  }
  const nameOf = (id) => (ch.cast && ch.cast[id] ? ch.cast[id].name : id);
  const catCls = { familial: 'r-fam', romantic: 'r-rom', alliance: 'r-all', rivalry: 'r-riv', social: 'r-soc', neutral: 'r-neu' };
  const sentCls = { warm: 'se-warm', hostile: 'se-host', strained: 'se-strain', complex: 'se-cx', neutral: 'se-neu' };
  const sentLbl = { warm: '\u2665 warm', hostile: '\u2694 hostile', strained: '\u26A1 strained', complex: '\u269C complex', neutral: '\u25CB neutral' };
  // The active category set of an edge (back-compat: fall back to single category).
  const catsOf = (r) => (Array.isArray(r.categories) && r.categories.length ? r.categories : [r.category || 'neutral']);
  // Count by EACH category an edge belongs to, so a familial+rivalry edge counts
  // under both filter chips.
  const cnt = rels.reduce((acc, r) => { catsOf(r).forEach((c) => { acc[c] = (acc[c] || 0) + 1; }); return acc; }, {});
  const order = ['familial', 'romantic', 'alliance', 'rivalry', 'social', 'neutral'];
  const chips = ['all'].concat(order.filter((c) => cnt[c])).map((c) =>
    '<button class="vlc-fchip' + (_relFilter === c ? ' on' : '') + '" data-rel-filter="' + c + '">'
    + (c === 'all' ? 'All' : escapeHtml(c)) + ' <span class="vlc-fchip-n">' + (c === 'all' ? rels.length : cnt[c]) + '</span></button>'
  ).join('');
  // an edge matches the filter if ANY of its categories matches
  const shown = _relFilter === 'all' ? rels : rels.filter((r) => catsOf(r).includes(_relFilter));
  // a -100..100 score bar centered at 0 (left = negative/red, right = positive/green)
  const scoreBar = (label, v) => {
    const n = Math.max(-100, Math.min(100, Number(v) || 0));
    const pct = Math.abs(n) / 2; // half-width max
    const pos = n >= 0;
    return '<div class="vlc-rel-score"><span class="vlc-rel-score-l">' + label + '</span>'
      + '<span class="vlc-rel-track"><span class="vlc-rel-mid"></span>'
      + '<span class="vlc-rel-fill ' + (pos ? 'pos' : 'neg') + '" style="' + (pos ? 'left:50%;width:' + pct + '%' : 'right:50%;width:' + pct + '%') + '"></span></span>'
      + '<span class="vlc-rel-score-v ' + (pos ? 'pos' : 'neg') + '">' + (n > 0 ? '+' : '') + n + '</span></div>';
  };
  // tiny sparkline of the affection history (last ~12 points)
  const spark = (r) => {
    const h = (r.history || []).slice(-12);
    if (h.length < 2) return '';
    const pts = h.map((x, i) => { const xx = (i / (h.length - 1)) * 100; const yy = 50 - ((Number(x.affection) || 0) / 100) * 45; return xx.toFixed(1) + ',' + yy.toFixed(1); }).join(' ');
    return '<svg class="vlc-rel-spark" viewBox="0 0 100 50" preserveAspectRatio="none"><polyline points="' + pts + '"/></svg>';
  };
  // Category-evolution trail: compact "+romantic" / "−alliance" steps so the user
  // can see how the bond's nature changed over time. Built from categoryHistory's
  // add/remove ops (skipping the seed row), capped to the last few transitions.
  const catTrail = (r) => {
    const hist = Array.isArray(r.categoryHistory) ? r.categoryHistory : [];
    const ops = hist.filter((h) => h && (h.op === 'add' || h.op === 'remove') && h.category);
    if (ops.length < 2) return ''; // nothing meaningful evolved yet
    const steps = ops.slice(-5).map((h) => {
      const sign = h.op === 'remove' ? '\u2212' : '+';
      const cls = h.op === 'remove' ? 'ev-rm' : 'ev-add';
      const tip = (h.day ? 'day ' + h.day : ('turn ' + (h.turn || 0))) + (h.reason ? ' \u2014 ' + h.reason : '');
      return '<span class="vlc-rel-ev ' + cls + '" title="' + escapeHtml(tip) + '">' + sign + escapeHtml(h.category) + '</span>';
    }).join('<span class="vlc-rel-ev-sep">\u203a</span>');
    return '<div class="vlc-rel-evtrail" title="how this bond evolved">' + steps + '</div>';
  };
  const rows = shown.length ? shown.slice().sort((a, b) => (b.lastTurn || 0) - (a.lastTurn || 0)).map((r) => {
    const aN = nameOf(r.a), bN = nameOf(r.b);
    const aff = (typeof r.affection === 'number') ? r.affection : 0;
    const tr = (typeof r.trust === 'number') ? r.trust : 0;
    const cats = catsOf(r);
    const sentChip = '<span class="vlc-rel-sent ' + (sentCls[r.sentiment] || 'se-neu') + '" title="' + escapeHtml(r.sentiment || 'neutral') + '">' + escapeHtml(sentLbl[r.sentiment] || (r.sentiment || 'neutral')) + '</span>';
    // ONE chip per active category — coexisting facets all show (familial + rivalry)
    const catChips = cats.map((c) => '<span class="vlc-rel-cat ' + (catCls[c] || 'r-neu') + '">' + escapeHtml(c) + '</span>').join('');
    const stChip = (r.status && r.status !== 'active') ? '<span class="vlc-rel-st">' + escapeHtml(r.status) + '</span>' : '';
    // header: A → B as a clear pair; the relationship label sits on its own line
    const pair = '<span class="vlc-rel-a">' + escapeHtml(aN) + '</span><span class="vlc-rel-arrow">\u2192</span><span class="vlc-rel-bn">' + escapeHtml(bN) + '</span>';
    const lbl = r.label ? '<div class="vlc-rel-label">\u201c' + escapeHtml(r.label) + '\u201d</div>' : '';
    const primaryCat = cats.slice().sort((x, y) => (REL_RANK[y] || 0) - (REL_RANK[x] || 0))[0] || 'neutral';
    return '<div class="vlc-rel-card ' + (sentCls[r.sentiment] || 'se-neu') + '" data-cat="' + escapeHtml(primaryCat) + '">'
      + '<div class="vlc-rel-top">'
        + '<div class="vlc-rel-pair">' + pair + '</div>'
        + '<div class="vlc-rel-ctl">'
          + '<button class="vlc-mini-edit" data-relation-edit data-id="' + escapeHtml(r.id || '') + '" data-a="' + escapeHtml(aN) + '" data-b="' + escapeHtml(bN) + '" data-label="' + escapeHtml(r.label || '') + '" data-category="' + escapeHtml(primaryCat) + '" data-categories="' + escapeHtml(cats.join(',')) + '" data-status="' + escapeHtml(r.status || 'active') + '" data-sentiment="' + escapeHtml(r.sentiment || 'neutral') + '" data-affection="' + aff + '" data-trust="' + tr + '" title="Edit">\u270E</button>'
          + '<button class="vlc-mini-del" data-relation-del data-id="' + escapeHtml(r.id || '') + '" title="Delete">\u2715</button>'
        + '</div>'
      + '</div>'
      + lbl
      + '<div class="vlc-rel-tags">' + sentChip + catChips + stChip + '</div>'
      + catTrail(r)
      + '<div class="vlc-rel-scores">' + scoreBar('Affection', aff) + scoreBar('Trust', tr) + '</div>'
      + (spark(r) ? '<div class="vlc-rel-sparkwrap">' + spark(r) + '</div>' : '')
      + '</div>';
  }).join('') : '<div class="vlc-empty" style="padding:8px">No \u201c' + escapeHtml(_relFilter) + '\u201d relations.</div>';
  return '<div class="vlc-fbar" data-rel-fbar>' + chips + '</div><div class="vlc-rel-grid">' + rows + '</div>';
}

function renderCast(host, ch) {
  if (!host) return;
  const cast = ch && ch.cast ? Object.values(ch.cast) : [];
  if (!cast.length) {
    const hasJournal = ch && ch.memJournal && Object.keys(ch.memJournal).length;
    host.innerHTML = '<div class="vlc-empty big">\u2726<br>No characters yet.<br><span>Play a few turns, hit \u2756 Scan, or + Add your own.</span></div>'
      + '<section data-grp="journal"><h3 class="vlc-h">\uD83D\uDCD6 Memory Journal <span class="vlc-h-n">' + (hasJournal || 0) + '</span></h3>'
      + '<div class="vlc-lore-bar"><button class="vlc-btn" data-scan-mem>\uD83D\uDCD6 Scan memories</button></div>'
      + memJournalHtml(ch || {}) + '</section>';
    return;
  }
  // Prefer the backend-resolved presentIds (strong matcher). Fall back to
  // name/alias key matching for older chronicles without presentIds.
  const presentIdSet = new Set(ch.presentIds || []);
  const presentKeys = new Set((ch.present || []).map((n) => castKeyFE(n)));
  const isPresent = (c) => {
    if (presentIdSet.size) return presentIdSet.has(c.id);
    if (presentKeys.has(c.id)) return true;
    return (c.aka || []).some((a) => presentKeys.has(castKeyFE(a)));
  };
  const present = [], active = [], mentioned = [], mine = [];
  cast.forEach((c) => {
    // User-added characters that have NOT yet appeared stay in "Added".
    // Once they appear in the narrative (c.appeared), they flow into the live
    // categories like any other character (still marked as yours via the badge).
    if (c.source === 'user' && !c.appeared) { mine.push(c); return; }
    if (isPresent(c)) present.push(c);
    else if (c.status === 'mentioned') mentioned.push(c);
    else active.push(c);
  });
  const byRecent = (a, b) => (b.lastTurn || 0) - (a.lastTurn || 0);
  present.sort(byRecent); active.sort(byRecent); mentioned.sort(byRecent); mine.sort((a, b) => a.name.localeCompare(b.name));
  host.innerHTML =
    castGroup('present', '\u25C9 Present', 'No one on stage this turn.', present, true)
    + '<div class="vlc-break"></div>'
    + castGroup('active', '\u25CB Active', 'No recurring characters yet.', active, false)
    + '<div class="vlc-break"></div>'
    + castGroup('mentioned', '\u2027 Mentioned', 'No off-page mentions yet.', mentioned, false)
    + '<div class="vlc-break"></div>'
    + castGroup('added', '\u2605 Added (not yet in story)', 'Add your own with + Add.', mine, false)
    + '<div class="vlc-break"></div>'
    + '<section data-grp="relations"><h3 class="vlc-h">\u21ce Relations <span class="vlc-h-n">' + ((ch.relations || []).length) + '</span><button class="vlc-add-btn" data-relation-add>+ Relation</button></h3>'
      + relationsHtml(ch) + '</section>'
    + '<div class="vlc-break"></div>'
    + '<section data-grp="journal"><h3 class="vlc-h">\uD83D\uDCD6 Memory Journal <span class="vlc-h-n">' + Object.keys(ch.memJournal || {}).length + '</span></h3>'
      + '<div class="vlc-lore-bar"><button class="vlc-btn" data-scan-mem>\uD83D\uDCD6 Scan memories</button></div>'
      + memJournalHtml(ch) + '</section>';
}

// Frontend mirror of backend castKey (must match for present-detection).
function castKeyFE(name) {
  return String(name).toLowerCase().replace(/^(ser|lord|lady|king|queen|prince|princess|maester|septa|septon)\s+/i, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}
function wireCastTab(ctx, root, body, getChatId, setChatId) {
  const refreshBtn = root.querySelector('[data-cast-refresh]');
  const scanBtn = root.querySelector('[data-cast-scan]');
  const addBtn = root.querySelector('[data-cast-add]');
  const form = root.querySelector('[data-cast-form]');

  if (refreshBtn) refreshBtn.addEventListener('click', () => ctx.sendToBackend({ type: 'get_chronicle', chatId: getChatId() }));
  if (scanBtn) scanBtn.addEventListener('click', () => {
    scanBtn.disabled = true; scanBtn.textContent = '\u23F3 Scanning\u2026';
    ctx.sendToBackend({ type: 'scan_cast', chatId: getChatId() });
    clearTimeout(scanBtn._t);
    scanBtn._t = setTimeout(() => { scanBtn.disabled = false; scanBtn.textContent = '\u2756 Scan'; }, 60000);
  });
  if (addBtn) addBtn.addEventListener('click', () => openCastForm(ctx, form, getChatId, null));

  // section filter tabs (jump to a category without scrolling)
  root.querySelectorAll('[data-cast-filter]').forEach((b) => {
    b.addEventListener('click', () => {
      root.querySelectorAll('[data-cast-filter]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      root.setAttribute('data-view', b.getAttribute('data-cast-filter'));
    });
  });

  // delegated edit/delete on cards
  body.addEventListener('click', (e) => {
    const card = e.target.closest('[data-cc-id]');
    if (!card) return;
    const id = card.getAttribute('data-cc-id');
    if (e.target.closest('[data-cc-del]')) {
      ctx.sendToBackend({ type: 'cast_delete', chatId: getChatId(), id });
    } else if (e.target.closest('[data-cc-edit]')) {
      const akaEl = card.querySelector('.vlc-cc-aka');
      const aka = akaEl ? akaEl.textContent.replace(/^aka\s*/i, '').split('\u00B7').map((x) => x.trim()).filter(Boolean).join(', ') : '';
      const data = {
        id,
        name: ccName(card),
        aka,
        age: pickStat(card, 'Age'), appearance: pickStat(card, 'Looks'), role: pickStat(card, 'Role'), note: pickStat(card, 'Note'),
      };
      openCastForm(ctx, form, getChatId, data);
    }
  });
  body.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-cc-move]');
    if (!sel) return;
    const card = e.target.closest('[data-cc-id]');
    const to = sel.value;
    if (card && to) {
      ctx.sendToBackend({ type: 'cast_promote', chatId: getChatId(), id: card.getAttribute('data-cc-id'), to });
      sel.value = '';
    }
  });

  root._scanBtn = scanBtn;
}

function pickStat(card, label) {
  const spans = card.querySelectorAll('.vlc-cc-s');
  for (const sp of spans) {
    const i = sp.querySelector('i');
    if (i && i.textContent.trim() === label) return sp.textContent.replace(label, '').trim();
  }
  return '';
}

// Extract the character name from a card, ignoring the optional badge span.
function ccName(card) {
  const n = card.querySelector('.vlc-cc-n');
  if (!n) return '';
  let out = '';
  n.childNodes.forEach((node) => { if (node.nodeType === 3) out += node.textContent; });
  return out.trim();
}

function openCastForm(ctx, form, getChatId, data) {
  const d = data || { id: '', name: '', aka: '', age: '', appearance: '', role: '', note: '' };
  const isEdit = !!d.id;
  const akaStr = Array.isArray(d.aka) ? d.aka.join(', ') : (d.aka || '');
  form.hidden = false;
  form.innerHTML =
    '<div class="vlc-cf-h">' + (isEdit ? 'Edit character' : 'Add character') + '</div>'
    + '<input class="vlc-cf-in" data-cf="name" placeholder="Name" value="' + escapeHtml(d.name || '') + '">'
    + '<input class="vlc-cf-in" data-cf="aka" placeholder="Also known as (comma-separated aliases)" value="' + escapeHtml(akaStr) + '">'
    + '<input class="vlc-cf-in" data-cf="age" placeholder="Age (e.g. 32, mid-30s)" value="' + escapeHtml(d.age || '') + '">'
    + '<input class="vlc-cf-in" data-cf="appearance" placeholder="Appearance" value="' + escapeHtml(d.appearance || '') + '">'
    + '<input class="vlc-cf-in" data-cf="role" placeholder="Role" value="' + escapeHtml(d.role || '') + '">'
    + '<textarea class="vlc-cf-in vlc-cf-ta" data-cf="note" placeholder="Notes (optional)">' + escapeHtml(d.note || '') + '</textarea>'
    + '<div class="vlc-cf-btns"><button class="vlc-cf-save">Save</button><button class="vlc-cf-cancel">Cancel</button></div>';
  const val = (k) => { const el = form.querySelector('[data-cf="' + k + '"]'); return el ? el.value.trim() : ''; };
  form.querySelector('.vlc-cf-save').addEventListener('click', () => {
    const name = val('name');
    if (!name) { form.querySelector('[data-cf="name"]').focus(); return; }
    const character = { name, aka: val('aka'), age: val('age'), appearance: val('appearance'), role: val('role'), note: val('note') };
    if (isEdit) character.id = d.id;
    ctx.sendToBackend({ type: isEdit ? 'cast_update' : 'cast_add', chatId: getChatId(), character });
    form.hidden = true; form.innerHTML = '';
  });
  form.querySelector('.vlc-cf-cancel').addEventListener('click', () => { form.hidden = true; form.innerHTML = ''; });
  const nm = form.querySelector('[data-cf="name"]'); if (nm) nm.focus();
}

function applyPermBanner(root, granted) {
  if (!root) return;
  const need = ['chats', 'chat_mutation', 'generation'];
  const missing = need.filter((p) => !granted.includes(p));
  let banner = root.querySelector('[data-perm-banner]');
  if (!missing.length) { if (banner) banner.remove(); return; }
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'vlc-perm';
    banner.setAttribute('data-perm-banner', '1');
    const head = root.querySelector('.vlc-head');
    if (head && head.nextSibling) root.insertBefore(banner, head.nextSibling);
    else root.insertBefore(banner, root.firstChild);
  }
  banner.innerHTML = '\u26A0 Missing permission' + (missing.length > 1 ? 's' : '') + ': <b>'
    + missing.map(escapeHtml).join(', ') + '</b>. Open the Extensions panel \u2192 VELLUM Tracker and grant '
    + (missing.length > 1 ? 'them' : 'it') + ' so memory, summaries, and cast scanning work.';
}

function handleCastDone(root, p) {
  const btn = root && root._scanBtn;
  if (!btn) return;
  clearTimeout(btn._t);
  btn.disabled = false;
  let label = '\u2756 Scan';
  if (!p.ok && p.reason === 'no_generation_permission') label = '\u26A0 Grant "generation"';
  else if (!p.ok && p.reason === 'no_chat_mutation_permission') label = '\u26A0 Grant "chat_mutation"';
  else if (!p.ok && p.reason === 'no_history') label = '\u26A0 No readable history';
  else if (!p.ok && p.reason === 'no_active_chat') label = '\u26A0 No active chat';
  else if (!p.ok && p.reason === 'parse') label = '\u26A0 Scan parse failed';
  else if (!p.ok && p.reason === 'busy') label = '\u23F3 Already running\u2026';
  else if (!p.ok) label = '\u26A0 Scan error';
  else label = '\u2713 +' + (p.added || 0) + ' / ' + (p.enriched || 0) + ' updated';
  btn.textContent = label;
  setTimeout(() => { btn.textContent = '\u2756 Scan'; }, 4000);
}

const ICON_SVG = '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 3.5h9l3 3V16.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Z" stroke="#cda84e" stroke-width="1.4"/><path d="M12.5 3.5V6.5H15.5" stroke="#cda84e" stroke-width="1.4"/><path d="M6 9.5h8M6 12h6M6 14.5h4" stroke="#cda84e" stroke-width="1.2" stroke-linecap="round"/></svg>';

const WINDOW_HTML = '<div class="vlm-titlebar" data-drag><span class="vlm-dot" data-dot></span><span class="vlm-title">Vellum</span>'
  + '<button class="vlm-btn" data-skin title="Skin">▦</button>'
  + '<button class="vlm-btn" data-color title="Custom color">✦</button>'
  + '<button class="vlm-btn" data-refresh title="Refresh">⟳</button>'
  + '<button class="vlm-btn" data-min title="Minimize">—</button>'
  + '<button class="vlm-btn" data-close title="Close">✕</button>'
  + '<div class="vlm-colorpop" data-colorpop hidden>'
  + '<div class="vlm-cp-h">Customize</div>'
  + '<div class="vlm-cp-field"><label>Accent</label><div class="vlm-cp-row"><input type="color" class="vlm-cp-wheel" data-cp-accent value="#cda84e"><input type="text" class="vlm-cp-hex" data-cp-accent-hex placeholder="default" maxlength="7"></div></div>'
  + '<div class="vlm-cp-field"><label>Background</label><div class="vlm-cp-row"><input type="color" class="vlm-cp-wheel" data-cp-bg value="#171511"><input type="text" class="vlm-cp-hex" data-cp-bg-hex placeholder="default" maxlength="7"></div></div>'
  + '<div class="vlm-cp-field"><label>Text</label><div class="vlm-cp-row"><input type="color" class="vlm-cp-wheel" data-cp-text value="#d8c9a8"><input type="text" class="vlm-cp-hex" data-cp-text-hex placeholder="default" maxlength="7"></div></div>'
  + '<div class="vlm-cp-field"><label>Font</label><select class="vlm-cp-font" data-cp-font><option value="">Skin default</option><option value="serif">Serif (Cormorant)</option><option value="sans">Sans (Inter)</option><option value="mono">Mono (JetBrains)</option><option value="rounded">Rounded (Quicksand)</option><option value="slab">Slab (Roboto Slab)</option></select></div>'
  + '<div class="vlm-cp-field"><label>Font size <span data-cp-size-val>100%</span></label><input type="range" class="vlm-cp-range" data-cp-size min="80" max="150" step="5" value="100"></div>'
  + '<div class="vlm-cp-h" style="margin-top:6px">Living tracker</div>'
  + '<div class="vlm-cp-living"><span class="vlm-cp-living-d">Auto-update relations, knowledge, secrets &amp; memories each turn, with notifications. Uses a background generation per turn.</span><button class="vlm-cp-living-btn" data-cp-living>OFF</button></div>'
  + '<div class="vlm-cp-h" style="margin-top:4px">Accent presets</div>'
  + '<div class="vlm-cp-sw" data-cp-swatches></div>'
  + '<div class="vlm-cp-btns"><button class="vlm-cp-apply" data-cp-apply>Done</button><button class="vlm-cp-reset" data-cp-reset>Reset all</button></div>'
  + '</div>'
  + '</div>'
  + '<div class="vlm-tabs" data-wintabs>'
  + '<button class="vlm-tab" data-wintab-btn="scene"><span class="vlm-tab-ico">◷</span><span class="vlm-tab-rn">I</span><span class="vlm-tab-lbl">Scene</span></button>'
  + '<button class="vlm-tab" data-wintab-btn="minds"><span class="vlm-tab-ico">💭</span><span class="vlm-tab-rn">II</span><span class="vlm-tab-lbl">Minds</span></button>'
  + '<button class="vlm-tab" data-wintab-btn="story"><span class="vlm-tab-ico">📜</span><span class="vlm-tab-rn">III</span><span class="vlm-tab-lbl">Story</span></button>'
  + '<button class="vlm-tab" data-wintab-btn="backstage"><span class="vlm-tab-ico">🎭</span><span class="vlm-tab-rn">IV</span><span class="vlm-tab-lbl">Backstage</span></button>'
  + '<button class="vlm-tab" data-wintab-btn="pulse"><span class="vlm-tab-ico">✦</span><span class="vlm-tab-rn">V</span><span class="vlm-tab-lbl">Pulse</span><span class="vlm-tab-badge" data-pulse-badge hidden></span></button>'
  + '</div>'
  + '<div class="vlm-body" data-body><div class="vlm-empty">Awaiting the first ledger…</div></div>'
  + '<div class="vlm-toasts" data-toasts></div>'
  + '<div class="vlm-resize" data-resize></div>';

const VELLUM_CSS = [
  "@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=JetBrains+Mono:wght@400;500&family=Inter:wght@400;600&family=Quicksand:wght@400;600&family=Roboto+Slab:wght@400;600&family=Spectral:ital,wght@0,400;0,500;0,600;1,400&display=swap');",
﻿  ".vlm-cp-range{width:100%;accent-color:var(--vsolid,#cda84e);cursor:pointer}",
  ".vlm-tabs{display:flex;gap:2px;padding:6px 8px 0;border-bottom:1px solid rgba(var(--vacc,205,168,78),.2);flex:none}",
  ".vlm-window.vlm-min .vlm-tabs{display:none}",
  ".vlm-tab{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;cursor:pointer;background:none;border:none;border-bottom:2px solid transparent;padding:8px 4px 9px;color:rgba(var(--vacc,205,168,78),.55);font-family:'Cormorant Garamond',Georgia,serif;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;transition:color .15s,border-color .15s}",
  ".vlm-tab:hover{color:rgba(var(--vacc,205,168,78),.85)}",
  ".vlm-tab.on{color:var(--vsolid,#cda84e);border-bottom-color:var(--vsolid,#cda84e)}",
  ".vlm-tab-ico{display:none}",
  ".vlm-tab-rn{display:none}",
  ".vlm-tab-lbl{display:inline}",
  ".vlm-panel{display:none}",
  ".vlm-window[data-wintab=scene] .vlm-panel[data-panel=scene]{display:block}",
  ".vlm-window[data-wintab=minds] .vlm-panel[data-panel=minds]{display:block}",
  ".vlm-window[data-wintab=story] .vlm-panel[data-panel=story]{display:block}",
  ".vlm-window[data-wintab=backstage] .vlm-panel[data-panel=backstage]{display:block}",
  ".vlm-window[data-wintab=pulse] .vlm-panel[data-panel=pulse]{display:block}",
﻿  ".vlm-toasts{position:absolute;left:10px;right:10px;bottom:10px;display:flex;flex-direction:column;gap:6px;pointer-events:none;z-index:40}",
  ".vlm-toast{pointer-events:auto;cursor:pointer;display:flex;gap:8px;align-items:flex-start;padding:9px 11px;border-radius:10px;background:linear-gradient(160deg,rgba(28,24,18,.97),rgba(20,17,12,.97));border:1px solid rgba(var(--vacc,205,168,78),.45);box-shadow:0 8px 26px rgba(0,0,0,.5);opacity:0;transform:translateY(10px);transition:opacity .25s,transform .25s;font-size:11px;line-height:1.4}",
  ".vlm-toast.in{opacity:1;transform:translateY(0)}",
  ".vlm-toast.big{border-color:rgba(var(--vacc,205,168,78),.8)}",
  ".vlm-toast-i{flex:none;color:var(--vsolid,#cda84e);font-size:13px}",
  ".vlm-toast-t{flex:1;color:#e6d9bd}",
  ".vlm-toast-relation{border-left:3px solid #c97a9a}",
  ".vlm-toast-secret{border-left:3px solid #c96a6a}",
  ".vlm-toast-knowledge{border-left:3px solid #7ea6b0}",
  ".vlm-toast-memory{border-left:3px solid #8fa67e}",
  ".vlm-tab{position:relative}",
  ".vlm-tab-badge{position:absolute;top:2px;right:6px;min-width:14px;height:14px;padding:0 3px;border-radius:8px;background:#c96a6a;color:#fff;font-size:8px;font-weight:700;line-height:14px;text-align:center;font-family:'JetBrains Mono',monospace}",
  ".vlm-pulse-bar{display:flex;justify-content:space-between;align-items:center;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:rgba(var(--vacc,205,168,78),.6);margin-bottom:8px}",
  ".vlm-pulse-clear{font:inherit;color:#c98a8a;background:rgba(201,138,138,.12);border:1px solid rgba(201,138,138,.3);border-radius:6px;padding:3px 8px;cursor:pointer}",
  ".vlm-pulse-row{display:flex;gap:9px;align-items:flex-start;padding:8px 2px;border-bottom:1px solid rgba(var(--vacc,205,168,78),.08)}",
  ".vlm-pulse-i{flex:none;width:20px;text-align:center;color:var(--vsolid,#cda84e);font-size:13px}",
  ".vlm-pulse-b{flex:1;min-width:0}",
  ".vlm-pulse-t{color:#e6d9bd;font-size:11px;line-height:1.45}",
  ".vlm-pulse-m{color:rgba(var(--vacc,205,168,78),.5);font-size:8.5px;letter-spacing:.5px;text-transform:uppercase;margin-top:2px;font-family:'JetBrains Mono',monospace}",
  ".vlm-pulse-row.pk-rel .vlm-pulse-i{color:#d8a0b4}",
  ".vlm-pulse-row.pk-sec .vlm-pulse-i{color:#e09090}",
  ".vlm-pulse-row.pk-know .vlm-pulse-i{color:#9ec4d0}",
  ".vlm-pulse-row.pk-mem .vlm-pulse-i{color:#a0c088}",
  ".vlm-cp-living{display:flex;gap:8px;align-items:flex-start}",
  ".vlm-cp-living-d{flex:1;font-family:'JetBrains Mono',monospace;font-size:8.5px;line-height:1.4;color:rgba(var(--vacc,205,168,78),.5)}",
  ".vlm-cp-living-btn{flex:none;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;color:var(--vsolid,#cda84e);background:rgba(var(--vacc,205,168,78),.12);border:1px solid rgba(var(--vacc,205,168,78),.35);border-radius:7px;padding:6px 12px;cursor:pointer}",
  ".vlm-cp-living-btn.on{color:#1a1610;background:var(--vsolid,#cda84e)}",
﻿  ".vls-parchment .vlm-tabs{border-bottom:1px solid rgba(90,70,40,.4)}",
  ".vls-parchment .vlm-tab{color:rgba(90,68,32,.6);font-family:'Cormorant Garamond',Georgia,serif;font-style:italic}",
  ".vls-parchment .vlm-tab.on{color:#5a4420;border-bottom-color:#5a4420}",
  ".vls-parchment .vlm-tab-lbl{display:none}",
  ".vls-parchment .vlm-tab-rn{display:inline;font-size:16px;font-style:normal;letter-spacing:0}",
  ".vls-phone .vlm-tabs{gap:6px;padding:8px 12px;border-bottom:1px solid rgba(var(--vacc,205,168,78),.16)}",
  ".vls-phone .vlm-tab{border:none;border-radius:14px;padding:8px;background:rgba(var(--vacc,205,168,78),.08);font-size:18px}",
  ".vls-phone .vlm-tab.on{background:rgba(var(--vacc,205,168,78),.22);border-bottom-color:transparent}",
  ".vls-phone .vlm-tab-ico{display:inline}",
  ".vls-phone .vlm-tab-lbl,.vls-phone .vlm-tab-rn{display:none}",
  ".vls-codex .vlm-tabs{gap:0;padding:4px 8px 0;border-bottom:1px dashed rgba(var(--vacc,205,168,78),.4)}",
  ".vls-codex .vlm-tab{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:1px;text-transform:lowercase}",
  ".vls-codex .vlm-tab-lbl{display:inline}",
  ".vls-codex .vlm-tab.on .vlm-tab-lbl::before{content:'['}",
  ".vls-codex .vlm-tab.on .vlm-tab-lbl::after{content:']'}",
  ".vls-grimoire .vlm-tab{font-family:'Cormorant Garamond',Georgia,serif;font-size:13px;letter-spacing:2px}",
  ".vls-grimoire .vlm-tab.on .vlm-tab-lbl::before{content:'\\2766 '}",
  ".vls-grimoire .vlm-tab.on{text-shadow:0 0 12px rgba(var(--vacc,205,168,78),.6)}",
  ".vls-vn .vlm-tabs{border-bottom:1px solid rgba(var(--vacc,205,168,78),.25)}",
  ".vls-vn .vlm-tab{font-style:italic;text-transform:none;letter-spacing:1px}",
  ".vlm-window{position:fixed;z-index:99990;width:360px;height:560px;min-width:280px;min-height:240px;top:90px;right:28px;display:flex;flex-direction:column;background:radial-gradient(130% 90% at 0% 0%,rgba(var(--vacc,205,168,78),.12),transparent 55%),linear-gradient(165deg,rgba(19,17,13,.985),rgba(28,24,19,.975));border:1px solid rgba(var(--vacc,205,168,78),.4);border-radius:16px;box-shadow:0 22px 70px rgba(0,0,0,.6),inset 0 0 70px rgba(var(--vacc,205,168,78),.05);color:#d8c9a8;overflow:hidden;backdrop-filter:blur(10px);transition:opacity .2s ease,transform .2s ease}",
  ".vlm-window.vlm-hidden{opacity:0;pointer-events:none;transform:translateY(10px) scale(.97)}",
  ".vlm-window.vlm-min{height:48px!important;min-height:48px}",
  ".vlm-window.vlm-min .vlm-body,.vlm-window.vlm-min .vlm-resize{display:none}",
  ".vlm-titlebar{display:flex;align-items:center;gap:9px;padding:12px 15px;cursor:grab;user-select:none;background:linear-gradient(90deg,rgba(var(--vacc,205,168,78),.18),rgba(var(--vacc,205,168,78),.02));border-bottom:1px solid rgba(var(--vacc,205,168,78),.26);font-family:'Cormorant Garamond',Georgia,serif}",
  ".vlm-titlebar:active{cursor:grabbing}",
  ".vlm-title{flex:1;font-size:17px;letter-spacing:4px;text-transform:uppercase;color:var(--vsolid,#cda84e);font-weight:600;text-shadow:0 0 14px rgba(var(--vacc,205,168,78),.3)}",
  ".vlm-dot{width:7px;height:7px;border-radius:50%;background:#7a8b6f;box-shadow:0 0 9px rgba(122,139,111,.8)}",
  ".vlm-btn{width:23px;height:23px;border:none;border-radius:7px;cursor:pointer;background:rgba(var(--vacc,205,168,78),.13);color:var(--vsolid,#cda84e);font-size:13px;line-height:1;display:grid;place-items:center;transition:background .15s}",
  ".vlm-btn:hover{background:rgba(var(--vacc,205,168,78),.32)}",
  "[data-refresh]{font-size:14px}",
  ".vlm-btn.vlm-spin{animation:vlmspin .6s ease}",
  "@keyframes vlmspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}",
  ".vlm-body{flex:1;overflow-y:auto;padding:16px 16px 18px;font-family:'JetBrains Mono',Consolas,monospace;font-size:11.5px;line-height:1.55}",
  ".vlm-body::-webkit-scrollbar{width:7px}",
  ".vlm-body::-webkit-scrollbar-thumb{background:rgba(var(--vacc,205,168,78),.33);border-radius:4px}",
  ".vlm-hero{text-align:center;margin-bottom:14px}",
  ".vlm-kicker{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:3px;text-transform:uppercase;color:rgba(var(--vacc,205,168,78),.6)}",
  ".vlm-title-lg{font-family:'Cormorant Garamond',Georgia,serif;font-size:24px;font-weight:600;color:#ecdcb6;margin:5px 0 2px;line-height:1.12;text-shadow:0 1px 10px rgba(0,0,0,.4)}",
  ".vlm-rule{height:1px;margin:11px auto 0;background:linear-gradient(to right,transparent,rgba(var(--vacc,205,168,78),.55),transparent)}",
  ".vlm-chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}",
  ".vlm-chip{flex:1 1 auto;min-width:46%;display:flex;align-items:baseline;gap:7px;background:rgba(0,0,0,.26);border:1px solid rgba(var(--vacc,205,168,78),.16);border-radius:9px;padding:8px 11px}",
  ".vlm-chip-l{font-size:13px;opacity:.9}",
  ".vlm-chip-v{font-size:11px;line-height:1.4;color:#e6d9bd;word-break:break-word}",
  ".vlm-meters{display:flex;gap:14px;margin-bottom:16px}",
﻿  ".vlm-rapport{margin-bottom:16px}",
  ".vlm-rap-h{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(var(--vacc,205,168,78),.6);margin-bottom:7px}",
  ".vlm-rap-row{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(var(--vacc,205,168,78),.07)}",
  ".vlm-rap-row:last-child{border-bottom:none}",
  ".vlm-rap-name{flex:none;min-width:74px;font-family:'Cormorant Garamond',Georgia,serif;font-size:15px;color:#ecdcb6}",
  ".vlm-rap-sent{flex:none;font-family:'JetBrains Mono',monospace;font-size:8px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;padding:2px 6px;border-radius:5px;border:1px solid transparent}",
  ".vlm-rap-bars{flex:1;display:flex;align-items:center;gap:5px;min-width:0}",
  ".vlm-rap-lbl{font-family:'JetBrains Mono',monospace;font-size:7.5px;letter-spacing:.5px;text-transform:uppercase;color:rgba(220,200,150,.5)}",
  ".vlm-rap-track{position:relative;flex:1;min-width:0;height:7px;border-radius:4px;background:rgba(120,110,90,.22);overflow:hidden}",
  ".vlm-rap-mid{position:absolute;left:50%;top:0;bottom:0;width:1px;background:rgba(255,255,255,.25)}",
  ".vlm-rap-fill{position:absolute;top:0;bottom:0}",
  ".vlm-rap-fill.pos{background:linear-gradient(90deg,rgba(143,166,126,.45),#8fa67e)}",
  ".vlm-rap-fill.neg{background:linear-gradient(270deg,rgba(201,106,106,.45),#c96a6a)}",
  ".vlm-m{flex:1}",
  ".vlm-m-top{display:flex;justify-content:space-between;align-items:baseline;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(var(--vacc,205,168,78),.7);margin-bottom:5px}",
  ".vlm-m-top i{font-style:normal;opacity:.5;font-size:8px}",
  ".vlm-track{height:8px;border-radius:5px;background:rgba(70,62,48,.5);overflow:hidden}",
  ".vlm-fill{height:100%;border-radius:5px;background:linear-gradient(90deg,#8a6b1f,var(--vsolid,#cda84e));box-shadow:0 0 10px rgba(var(--vacc,205,168,78),.5);transition:width .45s ease}",
  ".vlm-fill.bond{background:linear-gradient(90deg,#566b4c,var(--vsolid2,#8fa67e));box-shadow:0 0 10px rgba(var(--vsec,143,166,126),.45)}",
  ".vlm-card{background:rgba(0,0,0,.24);border:1px solid rgba(var(--vacc,205,168,78),.15);border-radius:11px;padding:12px 14px;margin-bottom:12px}",
  ".vlm-card-h{font-family:'Cormorant Garamond',Georgia,serif;font-size:12.5px;letter-spacing:2px;text-transform:uppercase;color:var(--vsolid,#cda84e);margin-bottom:9px;padding-bottom:6px;border-bottom:1px solid rgba(var(--vacc,205,168,78),.16)}",
  ".vlm-list{list-style:none;margin:0;padding:0}",
  ".vlm-list li{position:relative;padding:4px 0 4px 16px;font-size:11px;line-height:1.5;color:#d6c8a6;border-bottom:1px solid rgba(var(--vacc,205,168,78),.06)}",
  ".vlm-list li:last-child{border-bottom:none}",
  ".vlm-list li::before{content:'◦';position:absolute;left:2px;color:rgba(var(--vacc,205,168,78),.6)}",
  ".vlm-list.vlm-mind li::before{content:'“';font-family:'Cormorant Garamond',Georgia,serif;font-size:16px;top:2px;color:rgba(var(--vacc,205,168,78),.5)}",
  ".vlm-mind-i{padding-left:18px}",
  ".vlm-mind-n{display:block;font-size:9px;letter-spacing:1.2px;text-transform:uppercase;color:rgba(var(--vacc,205,168,78),.78);margin-bottom:2px}",
  ".vlm-mind-t{display:block;font-style:italic;color:#e3d6bb;line-height:1.5}",
  ".vlm-empty{opacity:.5;font-style:italic;text-align:center;padding:60px 12px;font-family:'Cormorant Garamond',serif;font-size:17px;line-height:2}",
    ".vlm-timenote{margin:-4px 0 12px;text-align:center;font-size:10px;letter-spacing:1px;color:var(--vsolid,#cda84e);opacity:.85;font-family:'JetBrains Mono',monospace}",
  ".vlm-bts-h{font-family:'Cormorant Garamond',Georgia,serif;font-size:14px;letter-spacing:3px;text-transform:uppercase;color:var(--vsolid,#cda84e);text-align:center;margin:0 0 12px}",
  ".vlm-bts-sec{margin-bottom:12px}",
  ".vlm-bts-l{font-size:9px;letter-spacing:2px;text-transform:uppercase;margin-bottom:7px;display:flex;align-items:center;gap:7px}",
  ".vlm-bts-l::after{content:'';flex:1;height:1px;background:linear-gradient(to right,currentColor,transparent);opacity:.4}",
  ".vlm-bts-l.on{color:var(--vsolid,#cda84e)}",
  ".vlm-bts-l.off{color:var(--vsolid2,#8fa67e)}",
  ".vlm-actor{display:flex;gap:10px;align-items:flex-start;background:rgba(0,0,0,.26);border:1px solid rgba(var(--vacc,205,168,78),.14);border-radius:11px;padding:10px 12px;margin-bottom:8px}",
  ".vlm-actor:last-child{margin-bottom:0}",
  ".vlm-av{flex:none;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font-family:'Cormorant Garamond',Georgia,serif;font-size:13px;font-weight:600;letter-spacing:.5px;color:#1a1610;background:linear-gradient(135deg,var(--vsolid,#cda84e),#8a6b1f);box-shadow:0 2px 10px rgba(var(--vacc,205,168,78),.35)}",
  ".vlm-av.off{background:linear-gradient(135deg,var(--vsolid2,#8fa67e),#566b4c);color:#13160f;box-shadow:0 2px 10px rgba(var(--vsec,143,166,126),.3)}",
  ".vlm-actor-b{flex:1;min-width:0}",
  ".vlm-actor-n{font-family:'Cormorant Garamond',Georgia,serif;font-size:15px;font-weight:600;color:#ecdcb6;line-height:1.1;margin-bottom:5px}",
  ".vlm-pills{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:5px}",
  ".vlm-pill{font-size:9.5px;line-height:1.3;padding:2px 8px;border-radius:20px;border:1px solid transparent}",
  ".vlm-pill.loc{background:rgba(var(--vacc,205,168,78),.1);border-color:rgba(var(--vacc,205,168,78),.25);color:#d8c08a}",
  ".vlm-pill.mood{background:rgba(var(--vsec,143,166,126),.12);border-color:rgba(var(--vsec,143,166,126),.3);color:#aebd9e;font-style:italic}",
  ".vlm-doing{font-size:10.5px;line-height:1.45;color:#bfb39a;margin-bottom:2px}",
  /* collapsible rich actor card */
  ".vlm-actor-dtls{background:rgba(0,0,0,.26);border:1px solid rgba(var(--vacc,205,168,78),.14);border-radius:11px;margin-bottom:8px;overflow:hidden}",
  ".vlm-actor-dtls[open]{border-color:rgba(var(--vacc,205,168,78),.28)}",
  ".vlm-actor-sum{list-style:none;cursor:pointer;display:flex;gap:10px;align-items:center;padding:10px 12px}",
  ".vlm-actor-sum::-webkit-details-marker{display:none}",
  ".vlm-actor-sum::after{content:'\\25B8';margin-left:auto;color:rgba(var(--vacc,205,168,78),.6);font-size:10px;transition:transform .15s}",
  ".vlm-actor-dtls[open] .vlm-actor-sum::after{transform:rotate(90deg)}",
  ".vlm-actor-x{padding:0 12px 11px 12px}",
  ".vlm-ag{margin-top:9px}",
  ".vlm-ag-l{font-size:8px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(var(--vacc,205,168,78),.7);margin-bottom:4px;padding-bottom:3px;border-bottom:1px solid rgba(var(--vacc,205,168,78),.1)}",
  ".vlm-ag-r{display:flex;flex-direction:column;gap:3px}",
  ".vlm-attr{display:flex;gap:8px;align-items:baseline;font-size:10.5px;line-height:1.4}",
  ".vlm-attr-k{flex:none;min-width:62px;color:rgba(var(--vacc,205,168,78),.75);text-transform:capitalize}",
  ".vlm-attr-v{flex:1;color:#d6c8a6;word-break:break-word}",
  ".vlm-up{color:#8fbf8f;font-weight:600}",
  ".vlm-dn{color:#cf8f8f;font-weight:600}",
  ".vlm-arr{color:var(--vsolid,#cda84e);font-weight:600}",
  ".vlm-inv{display:flex;flex-wrap:wrap;gap:4px}",
  ".vlm-ichip{font-size:9px;line-height:1.3;padding:2px 7px;border-radius:20px;background:rgba(var(--vacc,205,168,78),.1);border:1px solid rgba(var(--vacc,205,168,78),.22);color:#d8c08a}",
  ".vlm-bts-card{margin-bottom:10px}",
  ".vlm-list.thread li::before{content:'›';color:rgba(var(--vacc,205,168,78),.7)}",
  ".vlm-world{font-size:10px;line-height:1.6;color:#bdb293;background:rgba(0,0,0,.22);border:1px dashed rgba(var(--vacc,205,168,78),.22);border-radius:9px;padding:9px 12px;margin-top:4px}",
  ".vlm-foot{font-size:9px;opacity:.42;margin-top:6px;line-height:1.5;padding-top:10px;border-top:1px solid rgba(var(--vacc,205,168,78),.12)}",
  ".vlm-resize{position:absolute;right:2px;bottom:2px;width:16px;height:16px;cursor:nwse-resize;opacity:.5}",
  ".vlm-resize::after{content:'';position:absolute;right:3px;bottom:3px;width:8px;height:8px;border-right:2px solid var(--vsolid,#cda84e);border-bottom:2px solid var(--vsolid,#cda84e)}",
  /* ---- Chronicle (drawer tab) ---- */
  ".vlc-root{display:flex;flex-direction:column;height:100%;color:#e3d6ba;font-family:'Spectral',Georgia,serif;font-size:13.5px;line-height:1.55;background:radial-gradient(120% 60% at 100% 0%,rgba(var(--vacc,205,168,78),.07),transparent 60%)}",
  ".vlc-head{padding:16px 18px 10px}",
  ".vlc-title{font-family:'Cormorant Garamond',Georgia,serif;font-size:24px;font-weight:600;letter-spacing:1px;color:#ecdcb6}",
  ".vlc-sub{font-size:10px;opacity:.6;line-height:1.4;margin-top:2px}",
  ".vlc-bar{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 10px;border-bottom:1px solid rgba(var(--vacc,205,168,78),.16)}",
  ".vlc-btn{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--vsolid,#cda84e);background:rgba(var(--vacc,205,168,78),.1);border:1px solid rgba(var(--vacc,205,168,78),.22);border-radius:7px;padding:6px 11px;cursor:pointer;transition:background .15s}",
  ".vlc-btn:hover{background:rgba(var(--vacc,205,168,78),.24)}",
  ".vlc-btn.on{background:rgba(var(--vacc,205,168,78),.34);color:#1a1610;font-weight:600}",
  ".vlc-btn.ghost{margin-left:auto;padding:6px 9px;font-size:13px}",
  ".vlc-body{flex:1;overflow-y:auto;padding:14px 16px 8px}",
  ".vlc-body::-webkit-scrollbar{width:8px}",
  ".vlc-body::-webkit-scrollbar-thumb{background:rgba(var(--vacc,205,168,78),.33);border-radius:4px}",
  ".vlc-stat{display:flex;flex-wrap:wrap;gap:10px;font-size:9.5px;text-transform:uppercase;letter-spacing:1px;color:rgba(var(--vacc,205,168,78),.7);background:rgba(0,0,0,.24);border:1px solid rgba(var(--vacc,205,168,78),.14);border-radius:9px;padding:9px 12px;margin-bottom:14px}",
  ".vlc-stat b{color:#ecdcb6;font-size:12px}",
  ".vlc-h{font-family:'Cormorant Garamond',Georgia,serif;font-size:15px;font-weight:600;letter-spacing:1.5px;color:var(--vsolid,#cda84e);margin:18px 0 9px;padding-bottom:6px;border-bottom:1px solid rgba(var(--vacc,205,168,78),.18)}",
  ".vlc-track{background:rgba(0,0,0,.24);border:1px solid rgba(var(--vacc,205,168,78),.15);border-left:3px solid rgba(var(--vacc,205,168,78),.5);border-radius:9px;padding:11px 13px;margin-bottom:9px}",
  ".vlc-track-h{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:5px}",
  ".vlc-track-name{font-family:'Cormorant Garamond',Georgia,serif;font-size:15px;font-weight:600;color:#ecdcb6;line-height:1.15}",
  ".vlc-track-span{flex:none;font-size:8.5px;letter-spacing:1px;text-transform:uppercase;color:rgba(var(--vacc,205,168,78),.6)}",
  ".vlc-track-now{font-size:13px;line-height:1.5;color:#e3d6bb}",
  ".vlc-evo-toggle{margin-top:8px;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:rgba(var(--vacc,205,168,78),.78);background:none;border:none;cursor:pointer;padding:2px 0}",
  ".vlc-evo{margin-top:8px;padding-left:8px;border-left:1px dashed rgba(var(--vacc,205,168,78),.3)}",
  ".vlc-step{position:relative;padding:5px 0 5px 14px}",
  ".vlc-step::before{content:'';position:absolute;left:-4px;top:9px;width:7px;height:7px;border-radius:50%;background:rgba(var(--vacc,205,168,78),.4)}",
  ".vlc-step.now::before{background:var(--vsolid,#cda84e);box-shadow:0 0 7px rgba(var(--vacc,205,168,78),.7)}",
  ".vlc-step-d{display:block;font-size:8.5px;letter-spacing:1px;text-transform:uppercase;color:rgba(var(--vacc,205,168,78),.6)}",
  ".vlc-step-t{display:block;font-size:10.5px;line-height:1.45;color:#cabd9d}",
  ".vlc-step.now .vlc-step-t{color:#ecdcb6;font-style:italic}",
  ".vlc-log{display:flex;flex-direction:column;gap:0}",
  ".vlc-eg{border-bottom:1px solid rgba(var(--vacc,205,168,78),.07)}",
  ".vlc-eg:last-child{border-bottom:none}",
  ".vlc-eg-sum{display:flex;gap:9px;align-items:baseline;padding:6px 0;cursor:pointer;list-style:none;font-size:10.5px;line-height:1.45}",
  ".vlc-eg-sum::-webkit-details-marker{display:none}",
  ".vlc-eg-sum::before{content:'\\25B8';color:rgba(var(--vacc,205,168,78),.6);font-size:9px;transition:transform .15s}",
  ".vlc-eg[open] .vlc-eg-sum::before{transform:rotate(90deg)}",
  ".vlc-eg-l{flex:1;color:#ecdcb6;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".vlc-eg-n{flex:none;font-size:8px;color:#1a1610;background:rgba(var(--vacc,205,168,78),.7);border-radius:10px;padding:1px 7px}",
  ".vlc-eg-body{padding:2px 0 8px 14px;border-left:1px dashed rgba(var(--vacc,205,168,78),.28);margin-left:5px}",
  ".vlc-eg-step{display:flex;gap:9px;align-items:baseline;padding:3px 0;font-size:10px;line-height:1.45;opacity:.78}",
  ".vlc-eg-step.now{opacity:1}",
  ".vlc-eg-d{flex:none;width:50px;font-size:8.5px;letter-spacing:.5px;text-transform:uppercase;color:rgba(var(--vacc,205,168,78),.6)}",
  ".vlc-eg-t{flex:1;color:#cdbf9e}",
  ".vlc-eg-step.now .vlc-eg-t{color:#e3d6bb}",
  ".vlc-log-row{display:flex;gap:9px;align-items:baseline;padding:6px 0;border-bottom:1px solid rgba(var(--vacc,205,168,78),.07);font-size:10.5px;line-height:1.45}",
  ".vlc-log-row:last-child{border-bottom:none}",
  ".vlc-log-d{flex:none;width:54px;font-size:8.5px;letter-spacing:.5px;text-transform:uppercase;color:rgba(var(--vacc,205,168,78),.6)}",
  ".vlc-log-x{flex:none;color:rgba(var(--vacc,205,168,78),.7)}",
  ".vlc-log-t{flex:1;color:#d8c9a8;font-size:13px;line-height:1.5}",
  ".vlc-empty{opacity:.5;font-style:italic;font-size:11px;padding:8px 2px}",
  ".vlc-empty.big{text-align:center;padding:48px 12px;font-family:'Cormorant Garamond',serif;font-size:16px;line-height:1.9}",
  ".vlc-empty.big span{font-size:11px;opacity:.7}",
  ".vlc-actions{display:flex;gap:8px;padding:10px 16px 14px;border-top:1px solid rgba(var(--vacc,205,168,78),.16)}",
  ".vlc-rebuild,.vlc-open{flex:1;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;border-radius:8px;padding:9px 8px;cursor:pointer;transition:background .15s}",
  ".vlc-summ{flex:1;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;border-radius:8px;padding:9px 8px;cursor:pointer;transition:background .15s;color:#b48ed0;background:rgba(180,142,208,.14);border:1px solid rgba(180,142,208,.32)}",
  ".vlc-summ:hover{background:rgba(180,142,208,.26)}",
  ".vlc-summ:disabled{opacity:.55;cursor:default}",
  ".vlc-actions-2{border-top:none;padding-top:0}",
  ".vlc-rebuild{color:var(--vsolid,#cda84e);background:rgba(var(--vacc,205,168,78),.14);border:1px solid rgba(var(--vacc,205,168,78),.3)}",
  ".vlc-rebuild:hover{background:rgba(var(--vacc,205,168,78),.26)}",
  ".vlc-rebuild:disabled{opacity:.5;cursor:default}",
  ".vlc-open{color:var(--vsolid2,#8fa67e);background:rgba(var(--vsec,143,166,126),.12);border:1px solid rgba(var(--vsec,143,166,126),.3)}",
  ".vlc-open:hover{background:rgba(var(--vsec,143,166,126),.24)}",
  /* filter views */
  ".vlc-root[data-view='all'] [data-grp='date']{display:none}",
  ".vlc-root:not([data-view='all']) .vlc-break{display:none}",
  ".vlc-root[data-view='arcs'] [data-grp]:not([data-grp='arcs']){display:none}",
  ".vlc-root[data-view='threads'] [data-grp]:not([data-grp='threads']){display:none}",
  ".vlc-root[data-view='events'] [data-grp]:not([data-grp='events']){display:none}",
  ".vlc-root[data-view='shifts'] [data-grp]:not([data-grp='shifts']){display:none}",
  ".vlc-root[data-view='date'] [data-grp]:not([data-grp='date']){display:none}",
  ".vlc-root[data-view='lore'] [data-grp]:not([data-grp='lore']){display:none}",
  ".vlc-root[data-view='journal'] [data-grp]:not([data-grp='journal']){display:none}",
  ".vlc-root[data-view='memories'] [data-grp]:not([data-grp='memories']){display:none}",
  ".vlc-root[data-view='memtree'] [data-grp]:not([data-grp='memtree']){display:none}",
  ".vlc-root[data-view='injection'] [data-grp]:not([data-grp='injection']){display:none}",
  ".vlc-root[data-view='present'] [data-grp]:not([data-grp='present']){display:none}",
  ".vlc-root[data-view='active'] [data-grp]:not([data-grp='active']){display:none}",
  ".vlc-root[data-view='mentioned'] [data-grp]:not([data-grp='mentioned']){display:none}",
  ".vlc-root[data-view='added'] [data-grp]:not([data-grp='added']){display:none}",
  ".vlc-root[data-view='relations'] [data-grp]:not([data-grp='relations']){display:none}",
  /* chapter memories */
﻿  ".vlc-mt-meta{font-size:10px;opacity:.55;margin-bottom:8px;font-style:italic}",
  ".vlc-mt-arc{background:rgba(0,0,0,.2);border:1px solid rgba(205,168,78,.14);border-left:3px solid #8fa67e;border-radius:10px;margin-bottom:8px;overflow:hidden}",
  ".vlc-mt-arc.unassigned{border-left-color:#8c8478;opacity:.92}",
  ".vlc-mt-sum{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;padding:9px 11px;background:linear-gradient(90deg,rgba(143,166,126,.1),transparent)}",
  ".vlc-mt-sum::-webkit-details-marker{display:none}",".vlc-mt-sum::before{content:'\u25B8';color:rgba(205,168,78,.7);font-size:10px;transition:transform .15s}",
  ".vlc-mt-arc[open] .vlc-mt-sum::before{transform:rotate(90deg)}",
  ".vlc-mt-title{flex:1;font-family:'Cormorant Garamond',Georgia,serif;font-size:15px;font-weight:600;color:#ecdcb6}",
  ".vlc-mt-span{font-family:'JetBrains Mono',monospace;font-size:8.5px;opacity:.5;letter-spacing:.5px}",
  ".vlc-mt-n{font-family:'JetBrains Mono',monospace;font-size:9px;color:#1a1610;background:rgba(205,168,78,.7);border-radius:9px;padding:1px 7px}",
  ".vlc-mt-body{padding:8px 11px 10px}",
  ".vlc-mt-gist{font-size:12px;font-style:italic;color:#cdbf9e;margin-bottom:7px;line-height:1.45}",
  ".vlc-mt-chips{display:flex;flex-wrap:wrap;gap:5px}",
  ".vlc-mt-chip{display:inline-flex;align-items:center;gap:5px;background:rgba(205,168,78,.1);border:1px solid rgba(205,168,78,.2);border-radius:7px;padding:3px 4px 3px 8px;font-size:11px}",
  ".vlc-mt-chip-d{font-family:'JetBrains Mono',monospace;font-size:8px;color:#1a1610;background:rgba(205,168,78,.6);border-radius:4px;padding:1px 5px}",
  ".vlc-mt-chip-t{color:#e0d2b2;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".vlc-mt-move{border:none;background:rgba(205,168,78,.16);color:#cda84e;border-radius:4px;width:18px;height:16px;cursor:pointer;font-size:9px;line-height:1}",
  ".vlc-mt-move:hover{background:rgba(205,168,78,.34)}",
  ".vlc-mt-axes{margin-top:10px;border-top:1px solid rgba(205,168,78,.12);padding-top:8px}",
  ".vlc-mt-axislist{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}",
  ".vlc-mt-axitem{font-size:10.5px;color:#cdbf9e;background:rgba(0,0,0,.2);border:1px solid rgba(205,168,78,.12);border-radius:6px;padding:2px 7px}",
  ".vlc-mt-axitem em{font-style:normal;opacity:.5;font-size:9px}",
  ".vlc-mem{background:rgba(0,0,0,.24);border:1px solid rgba(var(--vacc,205,168,78),.16);border-left:3px solid #b48ed0;border-radius:9px;margin-bottom:9px;overflow:hidden}",
  ".vlc-mem-sum{cursor:pointer;list-style:none;display:flex;align-items:baseline;gap:9px;padding:10px 13px}",
  ".vlc-mem-sum::-webkit-details-marker{display:none}",
  ".vlc-mem-sum::before{content:'\\25B8';color:rgba(180,142,208,.9);font-size:10px;transition:transform .15s;flex:none}",
  ".vlc-mem[open] .vlc-mem-sum::before{transform:rotate(90deg)}",
  ".vlc-mem-prev{flex:1;font-size:10.5px;color:#bcaec6;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".vlc-mem[open] .vlc-mem-prev{display:none}",
  ".vlc-mem-body{padding:0 13px 12px}",
  ".vlc-mem-h{margin-bottom:5px}",
  ".vlc-mem-span{flex:none;font-size:8.5px;letter-spacing:1px;text-transform:uppercase;color:rgba(180,142,208,.85)}",
  ".vlc-mem-t{font-size:13px;line-height:1.55;color:#e3d6bb}",
  ".vlc-mem-kw{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}",
  ".vlc-mem-del{flex:none;margin-left:auto;width:18px;height:18px;border:none;border-radius:5px;cursor:pointer;background:rgba(201,138,138,.14);color:#c98a8a;font-size:9px;line-height:1;display:grid;place-items:center;transition:background .15s}",
  ".vlc-mem-edit{flex:none;margin-left:auto;width:18px;height:18px;border:none;border-radius:5px;cursor:pointer;background:rgba(var(--vacc,205,168,78),.14);color:var(--vsolid,#cda84e);font-size:9px;line-height:1;display:grid;place-items:center;transition:background .15s}",
  ".vlc-mem-edit:hover{background:rgba(var(--vacc,205,168,78),.32)}",
  ".vlc-mem-edit + .vlc-mem-del{margin-left:5px}",
  ".vlc-mem-editform{display:flex;flex-direction:column;gap:7px;margin-top:9px;padding-top:9px;border-top:1px solid rgba(var(--vacc,205,168,78),.16)}",
  ".vlc-mem-ta{resize:vertical;min-height:70px;font-family:'JetBrains Mono',monospace;line-height:1.5}",
  ".vlc-mem-del:hover{background:rgba(201,138,138,.34)}",
  ".vlc-mem-bar{display:flex;justify-content:center;margin-top:10px}",
  ".vlc-mem-clear{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.5px;color:#c98a8a;background:rgba(201,138,138,.1);border:1px solid rgba(201,138,138,.3);border-radius:7px;padding:6px 12px;cursor:pointer;transition:background .15s}",
  ".vlc-mem-clear:hover{background:rgba(201,138,138,.24)}",
  ".vlc-kw{font-size:8.5px;letter-spacing:.3px;color:#cdbf9e;background:rgba(180,142,208,.14);border:1px solid rgba(180,142,208,.3);border-radius:10px;padding:1px 7px}",
  /* date-grouped collapsibles */
  ".vlc-day{background:rgba(0,0,0,.22);border:1px solid rgba(var(--vacc,205,168,78),.14);border-radius:9px;margin-bottom:8px;overflow:hidden}",
  ".vlc-day>summary{cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 13px;background:linear-gradient(90deg,rgba(var(--vacc,205,168,78),.12),transparent)}",
  ".vlc-day>summary::-webkit-details-marker{display:none}",
  ".vlc-day>summary::before{content:'▸';color:rgba(var(--vacc,205,168,78),.7);font-size:11px;transition:transform .15s}",
  ".vlc-day[open]>summary::before{transform:rotate(90deg)}",
  ".vlc-day-t{flex:1;font-family:'Cormorant Garamond',Georgia,serif;font-size:15px;font-weight:600;letter-spacing:1px;color:#ecdcb6}",
  ".vlc-day-c{flex:none;font-size:9px;min-width:20px;text-align:center;color:#1a1610;background:rgba(var(--vacc,205,168,78),.7);border-radius:10px;padding:2px 7px}",
  ".vlc-day-body{padding:6px 13px 12px}",
  ".vlc-day-sub{margin-top:9px}",
  ".vlc-day-sub-h{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(var(--vacc,205,168,78),.7);margin-bottom:4px}",
  ".vlc-day-sub .vlc-list li b{color:#e3d6bb;font-weight:600}",
  /* section breaks between chronicle groups */
  ".vlc-break{height:1px;margin:18px 2px;background:linear-gradient(to right,transparent,rgba(var(--vacc,205,168,78),.4),transparent)}",
  /* inline edit/add form modal */
  ".vlc-formmodal{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:rgba(0,0,0,.55);backdrop-filter:blur(2px);padding:18px}",
  ".vlc-formmodal-panel{width:min(420px,94vw);max-height:88vh;overflow:auto;background:linear-gradient(165deg,rgba(28,22,15,.99),rgba(22,17,12,.99));border:1px solid rgba(var(--vacc,205,168,78),.4);border-radius:12px;padding:16px;box-shadow:0 18px 50px rgba(0,0,0,.6)}",
  ".vlc-formmodal-h{font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--vsolid,#cda84e);margin-bottom:12px}",
  ".vlc-formmodal-body{display:flex;flex-direction:column;gap:9px}",
  ".vlc-ff-l{display:flex;flex-direction:column;gap:4px;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.5px;text-transform:uppercase;color:rgba(230,217,189,.7)}",
  ".vlc-cf-sel{appearance:none;-webkit-appearance:none;cursor:pointer}",
  ".vlc-cf-sel option{background:#1c160f;color:#e6d9bd}",
  ".vlc-h-n{font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:400;color:#1a1610;background:rgba(var(--vacc,205,168,78),.7);border-radius:10px;padding:1px 7px;margin-left:6px;vertical-align:middle}",
  /* pagination */
  ".vlc-pager{display:flex;align-items:center;justify-content:center;gap:12px;margin:10px 0 2px}",
  ".vlc-pg{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.5px;color:var(--vsolid,#cda84e);background:rgba(var(--vacc,205,168,78),.12);border:1px solid rgba(var(--vacc,205,168,78),.28);border-radius:7px;padding:5px 12px;cursor:pointer;transition:background .15s}",
  ".vlc-pg:hover:not(:disabled){background:rgba(var(--vacc,205,168,78),.26)}",
  ".vlc-pg:disabled{opacity:.35;cursor:default}",
  ".vlc-pg-i{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:1px;color:rgba(var(--vacc,205,168,78),.7);min-width:54px;text-align:center}",
  /* uniform date rows */
  ".vlc-dr{display:flex;align-items:baseline;gap:8px;padding:5px 0;border-bottom:1px solid rgba(var(--vacc,205,168,78),.07);font-size:11px;line-height:1.45}",
  ".vlc-dr:last-child{border-bottom:none}",
  ".vlc-dr-t{flex:none;width:52px;font-size:8px;font-weight:600;letter-spacing:.8px;text-align:center;padding:2px 0;border-radius:5px;color:#1a1610}",
  ".vlc-dr-arc{background:var(--vsolid,#cda84e)}",
  ".vlc-dr-thread{background:#b48ed0}",
  ".vlc-dr-event{background:#7fa8c9}",
  ".vlc-dr-shift{background:var(--vsolid2,#8fa67e)}",
  ".vlc-dr-l{flex:none;max-width:40%;font-weight:600;color:#ecdcb6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".vlc-dr-d{flex:1;color:#cdbf9e}",
  /* cast tab */
  ".vlc-cc{display:flex;gap:11px;align-items:flex-start;background:rgba(0,0,0,.24);border:1px solid rgba(var(--vacc,205,168,78),.15);border-radius:11px;padding:11px 13px;margin-bottom:9px}",
  ".vlc-cc.present{border-left:3px solid var(--vsolid,#cda84e);background:rgba(var(--vacc,205,168,78),.07)}",
  ".vlc-cc.user{border-left:3px solid #7fa8c9}",
  ".vlc-cc.mentioned{opacity:.82}",
  ".vlc-cc-av{flex:none;width:38px;height:38px;border-radius:50%;display:grid;place-items:center;font-family:'Cormorant Garamond',Georgia,serif;font-size:14px;font-weight:600;color:#1a1610;background:linear-gradient(135deg,var(--vsolid,#cda84e),#8a6b1f);box-shadow:0 2px 10px rgba(var(--vacc,205,168,78),.3)}",
  ".vlc-cc.user .vlc-cc-av{background:linear-gradient(135deg,#7fa8c9,#4a6b86)}",
  ".vlc-cc.mentioned .vlc-cc-av{background:linear-gradient(135deg,#8c8478,#5a5048)}",
  ".vlc-cc-b{flex:1;min-width:0}",
  ".vlc-cc-n{display:flex;align-items:center;justify-content:space-between;gap:8px;font-family:'Cormorant Garamond',Georgia,serif;font-size:16px;font-weight:600;color:#ecdcb6;margin-bottom:5px}",
  ".vlc-cc-actions{display:flex;gap:4px;flex:none}",
  ".vlc-cc-edit,.vlc-cc-del{width:20px;height:20px;border:none;border-radius:5px;cursor:pointer;background:rgba(var(--vacc,205,168,78),.12);color:var(--vsolid,#cda84e);font-size:10px;line-height:1;display:grid;place-items:center;transition:background .15s}",
  ".vlc-cc-del{color:#c98a8a;background:rgba(201,138,138,.12)}",
  ".vlc-cc-edit:hover{background:rgba(var(--vacc,205,168,78),.3)}",
  ".vlc-cc-del:hover{background:rgba(201,138,138,.3)}",
  ".vlc-cc-badge{color:var(--vsolid,#cda84e);margin-right:5px;font-size:11px}",
  ".vlc-cc-aka{font-size:9.5px;font-style:italic;color:rgba(180,142,208,.85);margin:-2px 0 5px;letter-spacing:.3px}",
  ".vlc-cc-move{font-family:'JetBrains Mono',monospace;font-size:8.5px;color:var(--vsolid,#cda84e);background:rgba(var(--vacc,205,168,78),.1);border:1px solid rgba(var(--vacc,205,168,78),.25);border-radius:5px;padding:2px 4px;cursor:pointer;max-width:74px}",
  ".vlc-cc-move:hover{background:rgba(var(--vacc,205,168,78),.22)}",
  ".vlc-inj{background:rgba(0,0,0,.26);border:1px solid rgba(127,168,201,.28);border-left:3px solid #7fa8c9;border-radius:9px;padding:11px 13px;margin-bottom:9px}",
  ".vlc-inj-h{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:#9cc0dc;margin-bottom:6px;display:flex;justify-content:space-between}",
  ".vlc-why{display:flex;flex-direction:column;gap:5px}",
  ".vlc-why-row{display:grid;grid-template-columns:16px minmax(70px,28%) 1fr auto;gap:7px;align-items:baseline;font-size:10px;line-height:1.4}",
  ".vlc-why-i{color:#9cc0dc;text-align:center}",
  ".vlc-why-l{color:#ecdcb6;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".vlc-why-r{color:#bdc9d4}",
  ".vlc-why-s{color:#7fa8c9;font-family:'JetBrains Mono',monospace;font-size:9px;text-align:right}",
  ".vlc-inj-pre{font-size:10.5px;line-height:1.5;color:#cdd6df;white-space:pre-wrap;font-family:'JetBrains Mono',monospace;background:rgba(0,0,0,.3);border-radius:6px;padding:9px 11px;max-height:280px;overflow:auto}",
  ".vlc-inj-meta{font-size:9px;opacity:.6;margin-top:6px}",
  ".vlc-deep{display:flex;align-items:center;gap:10px;justify-content:space-between;background:rgba(180,142,208,.1);border:1px solid rgba(180,142,208,.3);border-radius:9px;padding:10px 12px;margin-bottom:10px}",
  ".vlc-deep-l{font-size:11px;color:#d8c9a8;line-height:1.4}",
  ".vlc-deep-l b{color:#c9a6e0}",
  ".vlc-deep-l span{display:block;font-size:9px;opacity:.6}",
  ".vlc-deep-btn{flex:none;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;letter-spacing:1px;color:#9b8aa8;background:rgba(0,0,0,.3);border:1px solid rgba(180,142,208,.3);border-radius:20px;padding:5px 14px;cursor:pointer;transition:all .15s}",
  ".vlc-deep-btn.on{color:#1a1610;background:#c9a6e0;border-color:#c9a6e0}",
  ".vlc-cc-stats{display:flex;flex-direction:column;gap:4px}",
  ".vlc-cc-s{font-size:11px;line-height:1.4;color:#d6c8a6}",
  ".vlc-cc-s i{display:inline-block;min-width:46px;font-style:normal;font-size:8.5px;letter-spacing:1px;text-transform:uppercase;color:rgba(var(--vacc,205,168,78),.7);margin-right:6px}",
  ".vlc-cc-empty{font-size:10.5px;font-style:italic;opacity:.5}",
  ".vlc-cast-form{display:flex;flex-direction:column;gap:7px;padding:13px 16px;margin:0 0 4px;background:rgba(0,0,0,.3);border-bottom:1px solid rgba(var(--vacc,205,168,78),.2)}",
  ".vlc-cf-h{font-family:'Cormorant Garamond',Georgia,serif;font-size:15px;letter-spacing:1px;color:var(--vsolid,#cda84e);margin-bottom:2px}",
  ".vlc-cf-in{font-family:'JetBrains Mono',monospace;font-size:11px;color:#e6d9bd;background:rgba(0,0,0,.35);border:1px solid rgba(var(--vacc,205,168,78),.25);border-radius:6px;padding:7px 9px;outline:none}",
  ".vlc-cf-in:focus{border-color:rgba(var(--vacc,205,168,78),.6)}",
  ".vlc-cf-ta{resize:vertical;min-height:42px;font-family:'JetBrains Mono',monospace}",
  ".vlc-cf-btns{display:flex;gap:7px;margin-top:3px}",
  ".vlc-cf-save,.vlc-cf-cancel{flex:1;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;border-radius:7px;padding:8px;cursor:pointer}",
  ".vlc-cf-save{color:#1a1610;background:var(--vsolid,#cda84e);border:1px solid var(--vsolid,#cda84e)}",
  ".vlc-cf-save:hover{background:#d8b75e}",
  ".vlc-cf-cancel{color:var(--vsolid,#cda84e);background:rgba(var(--vacc,205,168,78),.12);border:1px solid rgba(var(--vacc,205,168,78),.3)}",
  ".vlc-perm{margin:0 16px 10px;padding:9px 12px;background:rgba(201,138,138,.12);border:1px solid rgba(201,138,138,.4);border-radius:8px;font-size:10.5px;line-height:1.5;color:#e0c2c2}",
  ".vlc-perm b{color:#f0d8a8}",
  /* CATEGORY FILTER CHIPS (knowledge / secrets / memory journal) */
  ".vlc-fbar{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0 9px}",
  ".vlc-sortbar{display:flex;align-items:center;gap:5px;margin:2px 0 10px}",
  ".vlc-sort-l{font-family:'JetBrains Mono',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:rgba(205,168,78,.5);margin-right:2px}",
  ".vlc-fchip{font:600 9px/1 'JetBrains Mono',monospace;letter-spacing:.5px;text-transform:uppercase;color:var(--vsolid,#cda84e);background:rgba(var(--vacc,205,168,78),.08);border:1px solid rgba(var(--vacc,205,168,78),.25);border-radius:20px;padding:5px 9px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;transition:background .15s,border-color .15s}",
  ".vlc-fchip:hover{background:rgba(var(--vacc,205,168,78),.16)}",
  ".vlc-fchip.on{color:#1a1610;background:var(--vsolid,#cda84e);border-color:var(--vsolid,#cda84e)}",
  ".vlc-fchip-n{font-size:8px;opacity:.7;font-weight:700}",
  ".vlc-fchip.on .vlc-fchip-n{opacity:.85}",
  /* IMPORT + CLEAR ALL action buttons */
  ".vlc-import,.vlc-clear-all{flex:1;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;border-radius:8px;padding:9px;cursor:pointer;transition:background .15s,border-color .15s}",
  ".vlc-import{color:var(--vsolid2,#8fa67e);background:rgba(var(--vsec,143,166,126),.12);border:1px solid rgba(var(--vsec,143,166,126),.35)}",
  ".vlc-import:hover{background:rgba(var(--vsec,143,166,126),.22)}",
  ".vlc-import:disabled{opacity:.6;cursor:default}",
  ".vlc-clear-all{color:#c98a8a;background:rgba(201,138,138,.1);border:1px solid rgba(201,138,138,.3)}",
  ".vlc-clear-all:hover{background:rgba(201,138,138,.2)}",
  ".vlc-clear-all.armed{color:#1a1610;background:#c96a6a;border-color:#c96a6a}",
  ".vlc-clear-all:disabled{opacity:.6;cursor:default}",
  /* THEME PALETTES */
  ".vlc-root.vlt-gilt{--vacc:205,168,78;--vsolid:#cda84e;--vsec:143,166,126;--vsolid2:#8fa67e;color:#d8c9a8}",
  ".vlm-window.vlt-gilt{--vacc:205,168,78;--vsolid:#cda84e;--vsec:143,166,126;--vsolid2:#8fa67e;color:#d8c9a8;background:radial-gradient(130% 90% at 0% 0%,rgba(205,168,78,.12),transparent 55%),linear-gradient(165deg,rgba(19,17,13,.985),rgba(28,24,19,.975))}",
  ".vlc-root.vlt-moonlit{--vacc:150,180,220;--vsolid:#9bc0e6;--vsec:120,200,190;--vsolid2:#86c8bc;color:#c4d2e0}",
  ".vlm-window.vlt-moonlit{--vacc:150,180,220;--vsolid:#9bc0e6;--vsec:120,200,190;--vsolid2:#86c8bc;color:#c4d2e0;background:radial-gradient(130% 90% at 0% 0%,rgba(150,180,220,.12),transparent 55%),linear-gradient(165deg,rgba(13,16,22,.985),rgba(18,23,32,.975))}",
  ".vlc-root.vlt-rose{--vacc:210,130,150;--vsolid:#e89bb0;--vsec:200,150,170;--vsolid2:#d8a0b4;color:#e6c8d0}",
  ".vlm-window.vlt-rose{--vacc:210,130,150;--vsolid:#e89bb0;--vsec:200,150,170;--vsolid2:#d8a0b4;color:#e6c8d0;background:radial-gradient(130% 90% at 0% 0%,rgba(210,130,150,.12),transparent 55%),linear-gradient(165deg,rgba(24,14,18,.985),rgba(32,18,24,.975))}",
  ".vlc-root.vlt-emerald{--vacc:110,190,150;--vsolid:#7fd0a0;--vsec:150,200,120;--vsolid2:#a0d088;color:#c2e0cc}",
  ".vlm-window.vlt-emerald{--vacc:110,190,150;--vsolid:#7fd0a0;--vsec:150,200,120;--vsolid2:#a0d088;color:#c2e0cc;background:radial-gradient(130% 90% at 0% 0%,rgba(110,190,150,.12),transparent 55%),linear-gradient(165deg,rgba(12,20,16,.985),rgba(16,28,22,.975))}",
  ".vlc-root.vlt-mono{--vacc:170,180,195;--vsolid:#c4ccd8;--vsec:150,160,175;--vsolid2:#aab4c0;color:#cdd2da}",
  ".vlm-window.vlt-mono{--vacc:170,180,195;--vsolid:#c4ccd8;--vsec:150,160,175;--vsolid2:#aab4c0;color:#cdd2da;background:radial-gradient(130% 90% at 0% 0%,rgba(170,180,195,.1),transparent 55%),linear-gradient(165deg,rgba(18,19,22,.985),rgba(26,28,32,.975))}",
  ".vlc-root.vlt-ember{--vacc:225,140,80;--vsolid:#f0a05a;--vsec:210,110,90;--vsolid2:#e09070;color:#e8cdb8}",
  ".vlm-window.vlt-ember{--vacc:225,140,80;--vsolid:#f0a05a;--vsec:210,110,90;--vsolid2:#e09070;color:#e8cdb8;background:radial-gradient(130% 90% at 0% 0%,rgba(225,140,80,.12),transparent 55%),linear-gradient(165deg,rgba(22,14,10,.985),rgba(30,20,14,.975))}",
  ".vlm-colorpop{position:absolute;top:42px;right:10px;z-index:30;width:228px;max-height:74vh;overflow-y:auto;padding:12px;background:linear-gradient(165deg,rgba(24,21,16,.99),rgba(18,16,12,.99));border:1px solid rgba(var(--vacc,205,168,78),.4);border-radius:12px;box-shadow:0 14px 40px rgba(0,0,0,.6)}",
  ".vlm-cp-h{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(var(--vacc,205,168,78),.7);margin-bottom:8px}",
  ".vlm-cp-field{margin-bottom:8px}",
  ".vlm-cp-field>label{display:block;font-family:'JetBrains Mono',monospace;font-size:8.5px;letter-spacing:1px;text-transform:uppercase;color:rgba(var(--vacc,205,168,78),.55);margin-bottom:3px}",
  ".vlm-cp-row{display:flex;gap:7px;align-items:center}",
  ".vlm-cp-wheel{flex:none;width:30px;height:30px;padding:0;border:1px solid rgba(var(--vacc,205,168,78),.3);border-radius:8px;background:none;cursor:pointer}",
  ".vlm-cp-hex{flex:1;min-width:0;font-family:'JetBrains Mono',monospace;font-size:12px;color:#e6d9bd;background:rgba(0,0,0,.4);border:1px solid rgba(var(--vacc,205,168,78),.28);border-radius:8px;padding:7px 9px;outline:none}",
  ".vlm-cp-hex:focus{border-color:rgba(var(--vacc,205,168,78),.6)}",
  ".vlm-cp-font{width:100%;font-family:'JetBrains Mono',monospace;font-size:11px;color:#e6d9bd;background:rgba(0,0,0,.4);border:1px solid rgba(var(--vacc,205,168,78),.28);border-radius:8px;padding:7px 9px;outline:none;cursor:pointer}",
  ".vlm-cp-font option{background:#1c1812;color:#e6d9bd}",
  ".vlm-cp-sw{display:grid;grid-template-columns:repeat(5,1fr);gap:5px;margin-bottom:10px}",
  ".vlm-cp-s{height:20px;border:1px solid rgba(255,255,255,.18);border-radius:5px;cursor:pointer;padding:0}",
  ".vlm-cp-s:hover{outline:2px solid rgba(var(--vacc,205,168,78),.7);outline-offset:1px}",
  ".vlm-cp-btns{display:flex;flex-direction:column;gap:6px}",
  ".vlm-cp-apply,.vlm-cp-reset{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.5px;text-transform:uppercase;border-radius:7px;padding:7px;cursor:pointer}",
  ".vlm-cp-apply{color:#1a1610;background:var(--vsolid,#cda84e);border:1px solid var(--vsolid,#cda84e)}",
  ".vlm-cp-reset{color:var(--vsolid,#cda84e);background:rgba(var(--vacc,205,168,78),.1);border:1px solid rgba(var(--vacc,205,168,78),.3)}",
﻿  ".vlm-window.vls-parchment{border-radius:4px;border:1px solid #6b5836;background:linear-gradient(160deg,#efe2c4,#e4d2a8 55%,#d8c290);color:#42351c;box-shadow:0 18px 50px rgba(0,0,0,.5)}",
  ".vls-parchment .vlm-titlebar{background:linear-gradient(90deg,rgba(120,90,40,.18),transparent);border-bottom:1px solid rgba(90,70,40,.35)}",
  ".vls-parchment .vlm-title,.vls-parchment .vlm-card-h,.vls-parchment .vlm-actor-n,.vls-parchment .vlm-title-lg{color:#5a4420;text-shadow:none}",
  ".vls-parchment .vlm-card,.vls-parchment .vlm-chip,.vls-parchment .vlm-actor,.vls-parchment .vlm-actor-dtls{background:rgba(255,250,235,.5);border:1px solid rgba(110,88,54,.3);border-radius:3px}",
  ".vls-parchment .vlm-body{color:#42351c}",
  ".vls-parchment .vlm-btn{color:#5a4420;background:rgba(110,88,54,.16)}",
  ".vls-parchment .vlm-chip-v,.vls-parchment .vlm-attr-v,.vls-parchment .vlm-doing{color:#4a3c22}",
  ".vlm-window.vls-phone{border-radius:34px;border:7px solid #1a1c22;background:linear-gradient(170deg,#15171d,#1d2027);box-shadow:0 20px 60px rgba(0,0,0,.7),inset 0 0 0 1px rgba(var(--vacc,205,168,78),.2)}",
  ".vls-phone .vlm-titlebar{padding:16px 14px 9px;border-bottom:1px solid rgba(var(--vacc,205,168,78),.16);position:relative}",
  ".vls-phone .vlm-title{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:3px}",
  ".vls-phone .vlm-titlebar::before{content:'';position:absolute;top:6px;left:50%;transform:translateX(-50%);width:58px;height:5px;border-radius:3px;background:rgba(255,255,255,.18)}",
  ".vls-phone .vlm-card,.vls-phone .vlm-actor,.vls-phone .vlm-actor-dtls,.vls-phone .vlm-chip{border-radius:18px}",
  ".vls-phone .vlm-body{padding:14px 13px 20px}",
  ".vls-phone .vlm-btn{border-radius:50%}",
  ".vlm-window.vls-vn{border-radius:14px;border:1px solid rgba(var(--vacc,205,168,78),.5);background:linear-gradient(0deg,rgba(10,8,14,.985) 60%,rgba(28,20,40,.97));box-shadow:0 22px 70px rgba(0,0,0,.65)}",
  ".vls-vn .vlm-body{display:block}",
  ".vls-vn .vlm-actor{background:linear-gradient(90deg,rgba(var(--vacc,205,168,78),.14),rgba(0,0,0,.3));border-left:3px solid var(--vsolid,#cda84e);border-radius:0 14px 14px 0}",
  ".vls-vn .vlm-actor-n{font-size:17px}",
  ".vls-vn .vlm-card{background:rgba(0,0,0,.45);border:1px solid rgba(var(--vacc,205,168,78),.22);border-radius:14px;backdrop-filter:blur(4px)}",
  ".vls-vn .vlm-title{font-family:'Cormorant Garamond',serif;font-style:italic;letter-spacing:2px;text-transform:none;font-size:20px}",
﻿  ".vlm-window.vls-codex{border-radius:6px;border:1px solid rgba(var(--vacc,205,168,78),.5);background:#0b0e0c;box-shadow:0 18px 50px rgba(0,0,0,.7),inset 0 0 60px rgba(var(--vacc,205,168,78),.04);font-family:'JetBrains Mono',monospace}",
  ".vls-codex .vlm-titlebar{background:rgba(var(--vacc,205,168,78),.08);border-bottom:1px dashed rgba(var(--vacc,205,168,78),.4)}",
  ".vls-codex .vlm-title{font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:2px}",
  ".vls-codex .vlm-title::before{content:'> '}",
  ".vls-codex .vlm-card,.vls-codex .vlm-actor,.vls-codex .vlm-actor-dtls,.vls-codex .vlm-chip{border-radius:2px;border:1px solid rgba(var(--vacc,205,168,78),.25);background:rgba(var(--vacc,205,168,78),.04)}",
  ".vls-codex .vlm-card-h,.vls-codex .vlm-bts-h{font-family:'JetBrains Mono',monospace;letter-spacing:1.5px}",
  ".vls-codex .vlm-card-h::before{content:'// '}",
  ".vls-codex .vlm-title-lg,.vls-codex .vlm-actor-n{font-family:'JetBrains Mono',monospace;font-size:15px}",
  ".vls-codex .vlm-av{border-radius:3px}",
  ".vls-codex .vlm-btn{border-radius:2px}",
  ".vlm-window.vls-grimoire{border-radius:18px 18px 14px 14px;border:2px solid #4a2f1a;background:radial-gradient(120% 80% at 50% 0%,rgba(var(--vacc,205,168,78),.16),transparent 60%),linear-gradient(165deg,#1a120c,#241810);box-shadow:0 22px 70px rgba(0,0,0,.7),inset 0 0 0 2px rgba(120,80,40,.3)}",
  ".vls-grimoire .vlm-titlebar{background:linear-gradient(90deg,rgba(120,80,40,.3),transparent);border-bottom:2px solid rgba(120,80,40,.4)}",
  ".vls-grimoire .vlm-title{font-family:'Cormorant Garamond',serif;font-size:19px;letter-spacing:3px;text-shadow:0 0 16px rgba(var(--vacc,205,168,78),.5)}",
  ".vls-grimoire .vlm-card,.vls-grimoire .vlm-actor,.vls-grimoire .vlm-actor-dtls{border:1px solid rgba(150,100,50,.35);border-radius:10px;background:rgba(10,6,3,.4)}",
  ".vls-grimoire .vlm-card-h{font-family:'Cormorant Garamond',serif;font-size:14px;text-align:center;border-bottom:1px solid rgba(150,100,50,.4)}",
  ".vls-grimoire .vlm-card-h::before{content:'\\2766  '}",
  ".vls-grimoire .vlm-card-h::after{content:'  \\2766'}",
  ".vls-grimoire .vlm-av{box-shadow:0 0 14px rgba(var(--vacc,205,168,78),.5)}",
  ".vlc-lore-bar{display:flex;gap:6px;margin-bottom:10px}",
  ".vlc-know-h{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(205,168,78,.7);margin:4px 0 6px}",
  ".vlc-know-grid{display:flex;flex-direction:column;gap:7px;margin-bottom:4px}",
  ".vlc-know{background:rgba(0,0,0,.2);border:1px solid rgba(205,168,78,.12);border-left:3px solid #8c8478;border-radius:9px;padding:8px 11px;overflow-wrap:anywhere}",
  ".vlc-know.k-knows{border-left-color:#8fa67e}",".vlc-know.k-believes{border-left-color:#7fa8c9}",".vlc-know.k-suspects{border-left-color:#cda84e}",".vlc-know.k-wrong{border-left-color:#c98a8a}",".vlc-know.k-unaware{border-left-color:#8c8478}",
  ".vlc-know-top{display:flex;gap:7px;align-items:center;margin-bottom:4px}",
  ".vlc-know-who{font-family:'Cormorant Garamond',Georgia,serif;font-size:15px;font-weight:600;color:#ecdcb6;line-height:1.1}",
  ".vlc-know-rel{font-family:'JetBrains Mono',monospace;font-size:8px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;padding:2px 7px;border-radius:5px;color:#1a1610}",
  ".k-knows .vlc-know-rel{background:#8fa67e}",".k-believes .vlc-know-rel{background:#7fa8c9}",".k-suspects .vlc-know-rel{background:#cda84e}",".k-wrong .vlc-know-rel{background:#c98a8a}",".k-unaware .vlc-know-rel{background:#8c8478}",
  ".vlc-know-x{font-family:'JetBrains Mono',monospace;font-size:8px;letter-spacing:.5px;text-transform:uppercase;color:#1a1610;background:#c96a6a;padding:2px 6px;border-radius:5px}",
  ".vlc-know-ctl{margin-left:auto;display:inline-flex;gap:3px;flex:none}",
  ".vlc-know-fact{font-size:13px;line-height:1.5;color:#e3d6bb}",
  ".vlc-know-src{font-size:10px;font-style:italic;opacity:.55;margin-top:3px}",
  ".vlc-sec-grid{display:flex;flex-direction:column;gap:7px}",
  ".vlc-secret{background:rgba(0,0,0,.24);border:1px solid rgba(201,138,138,.2);border-left:3px solid #c98a8a;border-radius:9px;padding:9px 12px;overflow-wrap:anywhere}",
  ".vlc-secret.s-minor{border-left-color:#8c8478}",".vlc-secret.s-major{border-left-color:#cda84e}",".vlc-secret.s-explosive{border-left-color:#c96a6a}",
  ".vlc-secret-top{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:11px;margin-bottom:5px}",
  ".vlc-secret-keeper{font-family:'Cormorant Garamond',Georgia,serif;font-size:15px;font-weight:600;color:#ecdcb6}",".vlc-secret-arrow{opacity:.55;font-size:10px;font-style:italic}",".vlc-secret-from{font-family:'Cormorant Garamond',Georgia,serif;font-size:15px;color:#bdc9d4}",
  ".vlc-secret-danger{margin-left:auto;font-family:'JetBrains Mono',monospace;font-size:8px;text-transform:uppercase;letter-spacing:.5px;font-weight:600;color:#1a1610;background:#c98a8a;padding:2px 6px;border-radius:5px}",".s-minor .vlc-secret-danger{background:#8c8478}",".s-major .vlc-secret-danger{background:#cda84e}",".s-explosive .vlc-secret-danger{background:#c96a6a}",
  ".vlc-secret-body{font-size:13px;line-height:1.5;color:#e3d6bb}",".vlc-secret-exp{font-size:11px;opacity:.65;margin-top:5px;font-style:italic}",
  ".vlc-mj{background:rgba(0,0,0,.22);border:1px solid rgba(205,168,78,.14);border-radius:9px;margin-bottom:8px;overflow:hidden}",
  ".vlc-mj-sum{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;padding:9px 12px;background:linear-gradient(90deg,rgba(205,168,78,.1),transparent)}",
  ".vlc-mj-sum::-webkit-details-marker{display:none}",".vlc-mj-sum::before{content:'\u25B8';color:rgba(205,168,78,.7);font-size:10px;transition:transform .15s}",
  ".vlc-mj[open] .vlc-mj-sum::before{transform:rotate(90deg)}",
  ".vlc-mj-name{flex:1;font-family:'Cormorant Garamond',Georgia,serif;font-size:15px;font-weight:600;color:#ecdcb6}",
  ".vlc-mj-body{padding:4px 12px 10px}",
  ".vlc-mj-row{display:flex;gap:8px;align-items:baseline;padding:7px 0;border-bottom:1px solid rgba(205,168,78,.06);font-size:13px;line-height:1.5}",
  ".vlc-mj-row:last-child{border-bottom:none}",
  ".vlc-mj-w{flex:none;font-family:'JetBrains Mono',monospace;font-size:8px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;padding:2px 6px;border-radius:4px;color:#1a1610;background:#8c8478}",
  ".w-trivial{background:#6c6c6c}",".w-minor{background:#8c8478}",".w-sig{background:#cda84e}",".w-def{background:#c96a6a}",
  ".vlc-mj-t{flex:1;color:#e0d2b2}",".vlc-mj-about{opacity:.6;font-style:italic}",
  ".vlc-mj-row.s-pos{border-left:2px solid rgba(143,166,126,.5);padding-left:6px}",".vlc-mj-row.s-neg{border-left:2px solid rgba(201,138,138,.5);padding-left:6px}",".vlc-mj-row.s-cx{border-left:2px solid rgba(180,142,208,.5);padding-left:6px}",".vlc-mj-row.s-neu{border-left:2px solid rgba(140,132,120,.4);padding-left:6px}",
  ".vlc-mini-del{flex:none;margin-left:auto;width:16px;height:16px;border:none;border-radius:4px;cursor:pointer;background:rgba(201,138,138,.14);color:#c98a8a;font-size:8px;line-height:1;display:grid;place-items:center}",
  ".vlc-mini-del:hover{background:rgba(201,138,138,.34)}",
  /* relations */
﻿  ".vlc-rel-grid{display:flex;flex-direction:column;gap:9px}",
  ".vlc-rel-card{background:rgba(0,0,0,.22);border:1px solid rgba(205,168,78,.14);border-left:3px solid #8c8478;border-radius:11px;padding:10px 12px;overflow:hidden}",
  ".vlc-rel-card.se-warm{border-left-color:#d8a05a}",".vlc-rel-card.se-host{border-left-color:#c96a6a}",".vlc-rel-card.se-strain{border-left-color:#cda84e}",".vlc-rel-card.se-cx{border-left-color:#b48ed0}",".vlc-rel-card.se-neu{border-left-color:#8c8478}",
  ".vlc-rel-top{display:flex;align-items:flex-start;gap:8px}",
  ".vlc-rel-pair{flex:1;min-width:0;display:flex;align-items:center;gap:7px;flex-wrap:wrap}",
  ".vlc-rel-a{font-family:'Cormorant Garamond',Georgia,serif;font-size:16px;font-weight:600;color:#ecdcb6}",
  ".vlc-rel-arrow{color:var(--vsolid,#cda84e);font-size:13px;opacity:.8}",
  ".vlc-rel-bn{font-family:'Cormorant Garamond',Georgia,serif;font-size:16px;font-weight:600;color:#cbb78a}",
  ".vlc-rel-ctl{flex:none;display:inline-flex;gap:3px}",
  ".vlc-rel-label{font-size:12.5px;font-style:italic;color:#cdbf9e;margin:5px 0 7px;line-height:1.45}",
  ".vlc-rel-tags{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:9px}",
  ".vlc-rel-sent{font-family:'JetBrains Mono',monospace;font-size:8px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;padding:2px 7px;border-radius:5px;border:1px solid transparent}",
  ".se-warm{color:#e6b89a;background:rgba(216,160,90,.16);border-color:rgba(216,160,90,.4)}",
  ".se-host{color:#e09090;background:rgba(201,106,106,.18);border-color:rgba(201,106,106,.45)}",
  ".se-strain{color:#d8c98a;background:rgba(205,168,78,.16);border-color:rgba(205,168,78,.4)}",
  ".se-cx{color:#c9a8e0;background:rgba(180,142,208,.16);border-color:rgba(180,142,208,.4)}",
  ".se-neu{color:#9aa0a6;background:rgba(140,132,120,.16);border-color:rgba(140,132,120,.35)}",
  ".vlc-rel-cat{font-family:'JetBrains Mono',monospace;font-size:8px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;padding:2px 7px;border-radius:5px;color:#1a1610;background:#8c8478}",
  ".r-fam{background:#cda84e}",".r-rom{background:#c97a9a}",".r-all{background:#8fa67e}",".r-riv{background:#c96a6a}",".r-soc{background:#7ea6b0}",".r-neu{background:#8c8478}",
  ".vlc-rel-st{font-family:'JetBrains Mono',monospace;font-size:8px;letter-spacing:.5px;text-transform:uppercase;padding:2px 6px;border-radius:5px;color:#cda84e;background:rgba(205,168,78,.14);border:1px solid rgba(205,168,78,.25)}",
  ".vlc-rel-scores{display:flex;flex-direction:column;gap:6px}",
  ".vlc-rel-score{display:flex;gap:8px;align-items:center;font-family:'JetBrains Mono',monospace;font-size:9px}",
  ".vlc-rel-score-l{flex:none;width:62px;color:rgba(220,200,150,.7);text-transform:uppercase;letter-spacing:.5px}",
  ".vlc-rel-track{position:relative;flex:1;min-width:0;height:8px;border-radius:5px;background:rgba(120,110,90,.22);overflow:hidden}",
  ".vlc-rel-mid{position:absolute;left:50%;top:0;bottom:0;width:1px;background:rgba(255,255,255,.28)}",
  ".vlc-rel-fill{position:absolute;top:0;bottom:0}",
  ".vlc-rel-fill.pos{background:linear-gradient(90deg,rgba(143,166,126,.45),#8fa67e)}",
  ".vlc-rel-fill.neg{background:linear-gradient(270deg,rgba(201,106,106,.45),#c96a6a)}",
  ".vlc-rel-score-v{flex:none;width:34px;text-align:right;font-weight:600}",".vlc-rel-score-v.pos{color:#a9c089}",".vlc-rel-score-v.neg{color:#e09090}",
  ".vlc-rel-sparkwrap{margin-top:8px;border-top:1px solid rgba(205,168,78,.1);padding-top:6px}",
  ".vlc-rel-spark{width:100%;height:24px;display:block}",
  ".vlc-rel-spark polyline{fill:none;stroke:var(--vsolid,#cda84e);stroke-width:2;opacity:.75}",
  ".vlc-rel-evtrail{display:flex;flex-wrap:wrap;align-items:center;gap:3px;margin-top:6px;font-family:'JetBrains Mono',monospace;font-size:8px;letter-spacing:.5px}",
  ".vlc-rel-ev{padding:1px 5px;border-radius:6px;border:1px solid rgba(205,168,78,.22);opacity:.85}",
  ".vlc-rel-ev.ev-add{color:#a9c089;border-color:rgba(143,166,126,.4)}",
  ".vlc-rel-ev.ev-rm{color:#e09090;border-color:rgba(201,106,106,.4);text-decoration:line-through}",
  ".vlc-rel-ev-sep{opacity:.4}",
  ".vlc-ff-chkrow{display:flex;flex-wrap:wrap;gap:8px 12px;padding:2px 0}",
  ".vlc-ff-chk{display:inline-flex;align-items:center;gap:5px;font-family:'JetBrains Mono',monospace;font-size:11px;cursor:pointer;text-transform:none;letter-spacing:0}",
  ".vlc-ff-chk input{accent-color:var(--vsolid,#cda84e);cursor:pointer}",
  ".vlc-mini-edit{flex:none;width:16px;height:16px;border:none;border-radius:4px;cursor:pointer;background:rgba(205,168,78,.14);color:#cda84e;font-size:9px;line-height:1;display:grid;place-items:center;margin-left:4px}",
  ".vlc-mini-edit:hover{background:rgba(205,168,78,.34)}",
  ".vlc-row-ctl{flex:none;margin-left:auto;display:inline-flex;gap:3px;align-items:center}",
  ".vlc-add-btn{margin-left:8px;font:600 9px/1 'JetBrains Mono',monospace;letter-spacing:.5px;text-transform:uppercase;color:var(--vsolid2,#8fa67e);background:rgba(143,166,126,.14);border:1px solid rgba(143,166,126,.3);border-radius:6px;padding:3px 8px;cursor:pointer;vertical-align:middle}",
  ".vlc-add-btn:hover{background:rgba(143,166,126,.28)}",
].join("\n");
