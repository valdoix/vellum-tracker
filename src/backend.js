/**
 * VELLUM Tracker — backend worker
 * @type {import('lumiverse-spindle-types').SpindleAPI}
 *
 * Responsibilities:
 *  1. Context-filter interceptor — strips <reverie>, <ledger>, [BTS], and VTK
 *     blocks from OLDER assistant turns so long chats stay lean, while keeping
 *     the most recent few intact for continuity.
 *  2. Parser — extracts structured fields from the latest <ledger> and [BTS].
 *  3. Chat-var sync — writes parsed fields to vellum_* chat variables that the
 *     preset's Arc Memory block reads back in.
 *  4. Frontend broadcast — pushes the parsed state to the floating window.
 */
const spindle = globalThis.spindle;

/* ---------- permission helpers ---------- */
function isPermDenied(e) {
  return !!(e && typeof e.message === 'string' && e.message.startsWith('PERMISSION_DENIED:'));
}
// Synchronous, zero-cost check (seeded at startup, kept in sync by the host).
function hasPerm(name) {
  try { return !!(spindle.permissions && spindle.permissions.has && spindle.permissions.has(name)); }
  catch (e) { return true; } // if the check itself is unavailable, attempt the op
}

/* ---------- internal LLM helper ----------
 * CRITICAL: we use generate.RAW, not quiet. quiet applies the user's active
 * PRESET (incl. VELLUM's assistant prefill "<reverie>…"), which makes the model
 * write a reverie instead of our requested JSON — breaking summary + cast scan.
 * raw uses only the connection's provider/model/key, with our own messages.
 */
let _connCache = { at: 0, conn: null };
async function resolveConnection(userId) {
  if (_connCache.conn && Date.now() - _connCache.at < 30000) return _connCache.conn;
  try {
    if (spindle.connections && spindle.connections.list) {
      const list = await spindle.connections.list(userId);
      if (Array.isArray(list) && list.length) {
        const pick = list.find((c) => c.is_default) || list[0];
        if (pick && pick.id) { _connCache = { at: Date.now(), conn: pick }; return pick; }
      }
      try { spindle.toast.warning('VELLUM: no connection profiles found — set one up in Connections.'); } catch (e2) {}
    }
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    try { spindle.toast.error('VELLUM: connections.list failed: ' + msg.slice(0, 140), { title: 'VELLUM Tracker' }); } catch (e2) {}
    spindle.log.warn(`[vellum_tracker] connections.list: ${msg}`);
  }
  return null;
}

// Run an internal JSON-producing generation. Returns the content string, or
// throws (permDenied flagged) so callers can report an honest reason.
// Pull usable text from a generation response, trying every channel a reasoning
// model might use: content, message.content, text, the flat reasoning string,
// and OpenRouter-style reasoning_details[].text/.summary.
function extractGenContent(r) {
  if (!r) return '';
  const pick = (v) => (typeof v === 'string' && v.trim() ? v : '');
  let c = pick(r.content) || pick(r.message && r.message.content) || pick(r.text);
  if (c) return c;
  // flat reasoning channel
  c = pick(r.reasoning);
  if (c) return c;
  // structured reasoning details (array of {text|summary|content})
  const rd = r.reasoning_details || r.reasoningDetails;
  if (Array.isArray(rd)) {
    const joined = rd.map((d) => (d && (d.text || d.summary || d.content)) || '').filter(Boolean).join('\n');
    if (joined.trim()) return joined;
  }
  return '';
}

async function internalGenerate(messages, params, userId) {
  const conn = await resolveConnection(userId);
  const req = { messages, parameters: params || {} };
  if (userId) req.userId = userId;
  if (conn && conn.id) req.connection_id = conn.id;
  // Some hosts require provider/model alongside connection_id for raw.
  if (conn && conn.provider) req.provider = conn.provider;
  if (conn && conn.model) req.model = conn.model;
  // Ask the host to disable extended thinking. NOTE: the off-switch only covers
  // some providers (anthropic/bedrock/deepseek/nanogpt). For others (e.g.
  // OpenRouter), the model still reasons — so we ALSO budget generously and
  // extract the JSON from whichever channel it lands in (content/reasoning/
  // reasoning_details), below.
  req.reasoning = { source: 'off' };
  try {
    let r = null;
    if (spindle.generate && spindle.generate.raw) {
      r = await spindle.generate.raw(req);
    } else if (spindle.generate && spindle.generate.quiet) {
      r = await spindle.generate.quiet(req);
    } else {
      throw new Error('no generate API');
    }
    const content = extractGenContent(r);
    if (!content || !content.trim()) {
      const keys = JSON.stringify(Object.keys(r || {})).slice(0, 90);
      const fin = r && r.finish_reason ? (' finish=' + r.finish_reason) : '';
      try { spindle.toast.warning('VELLUM: empty generation (' + keys + fin + ')', { title: 'VELLUM Tracker' }); } catch (e2) {}
    }
    return content || '';
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    try { spindle.toast.error('VELLUM gen failed: ' + msg.slice(0, 160), { title: 'VELLUM Tracker', duration: 12000 }); } catch (e2) {}
    spindle.log.warn(`[vellum_tracker] internalGenerate error: ${msg}`);
    if (isPermDenied(e)) { const err = new Error('PERMISSION_DENIED:generation'); err.permDenied = true; throw err; }
    throw e;
  }
}


/* ---------- depth thresholds (turns from the end that stay un-stripped) ---------- */
const KEEP = {
  reverie: 1,   // planning is only useful for the very last turn
  ledger: 2,    // keep two ledgers for short-term continuity
  bts: 5,       // backstage state is cheap and valuable; keep more
  vtk: 3,
  html: 3,
};

const HTML_TAGS = ['span', 'b', 'i', 'u', 'em', 'strong', 's', 'strike', 'sub', 'sup', 'mark', 'small', 'big', 'font', 'div', 'style'];

/* ---------- strippers ---------- */
const stripReverie = (s) => s.replace(/<reverie>[\s\S]*?<\/\s*rever[a-z]*\s*>?/gi, '');
const stripLedger = (s) => s.replace(/<ledger>[\s\S]*?<\/ledger>/gi, '');
const stripBts = (s) => s.replace(/<!--\s*\[BTS(?:\|CP)?\][\s\S]*?\[\/BTS(?:\|CP)?\]\s*-->/gi, '');
const stripVtk = (s) => s.replace(/<!--\s*VIS_START\s*-->[\s\S]*?<!--\s*VIS_END\s*-->/gi, '');

function stripHtml(s) {
  let out = s;
  for (const tag of HTML_TAGS) {
    out = out.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'gi'), '');
    out = out.replace(new RegExp(`</${tag}>`, 'gi'), '');
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function applyDepthFilters(content, assistantDepth) {
  let out = content;
  if (assistantDepth > KEEP.reverie) out = stripReverie(out);
  if (assistantDepth > KEEP.ledger) out = stripLedger(out);
  if (assistantDepth > KEEP.bts) out = stripBts(out);
  if (assistantDepth > KEEP.vtk) out = stripVtk(out);
  if (assistantDepth > KEEP.html) out = stripHtml(out);
  return out;
}

/* ---------- parsing ---------- */
function field(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

function parseLedger(content) {
  const m = content.match(/<ledger>([\s\S]*?)<\/ledger>/i);
  if (!m) return null;
  const g = m[1];
  // New delimited format: [time]..[/time]. Fall back to legacy label/emoji format.
  const tag = (name) => {
    const re = new RegExp('\\[' + name + '\\]([\\s\\S]*?)\\[\\/' + name + '\\]', 'i');
    const t = g.match(re);
    return t ? t[1].trim() : '';
  };
  return {
    raw: g.trim(),
    time: tag('time') || field(g, [/⏱\s*Time:\s*(.+)/i, /\bTime:\s*(.+)/i]),
    location: tag('place') || field(g, [/📍\s*Location:\s*(.+)/i, /\bLocation:\s*(.+)/i]),
    weather: tag('weather') || field(g, [/🌤\s*Weather:\s*(.+)/i, /\bWeather:\s*(.+)/i]),
    present: tag('present') || field(g, [/👥\s*Present:\s*(.+)/i, /\bPresent:\s*(.+)/i]),
    thoughts: tag('mind') || field(g, [/💭\s*Inner Landscape:?\s*([\s\S]*?)(?:📜|🌊|⚡|┗|$)/i]),
    arcs: tag('arcs') || field(g, [/📜\s*Active Arcs:?\s*([\s\S]*?)(?:🌊|⚡|┗|$)/i]),
    offscreen: tag('under') || field(g, [/🌊\s*Undercurrents:?\s*([\s\S]*?)(?:⚡|┗|$)/i]),
    sceneTension: tag('scene') || field(g, [/Scene\s*\[[^\]]*\]\s*(\d+)\s*\/\s*10/i, /Scene tension[:\s]*(\d+)/i]),
    bondTension: tag('bond') || field(g, [/Bond\s*\[[^\]]*\]\s*(\d+)\s*\/\s*10/i, /Bond[:\s]*(\d+)\s*\/\s*10/i]),
  };
}

function parseBts(content) {
  const m = content.match(/<!--\s*\[BTS(?:\|CP)?\]([\s\S]*?)\[\/BTS(?:\|CP)?\]\s*-->/i);
  return m ? m[1].trim() : '';
}

/* ---------- chat-var sync (feeds the preset's Arc Memory block) ---------- */
async function syncChatVars(chatId, parsed, btsRaw) {
  if (!chatId || !parsed) return;
  const pairs = [
    ['vellum_time', parsed.time],
    ['vellum_location', parsed.location],
    ['vellum_weather', parsed.weather],
    ['vellum_present', parsed.present],
    ['vellum_thoughts', parsed.thoughts],
    ['vellum_arcs', parsed.arcs],
    ['vellum_offscreen', parsed.offscreen],
    ['vellum_ledger_raw', parsed.raw],
    ['vellum_bts_raw', btsRaw],
  ];
  for (const [key, val] of pairs) {
    if (val) await spindle.variables.chat.set(chatId, key, String(val).slice(0, 2000));
  }
  if (parsed.sceneTension) await spindle.variables.chat.set(chatId, 'vellum_scene_tension', parsed.sceneTension);
  if (parsed.bondTension) await spindle.variables.chat.set(chatId, 'vellum_bond_tension', parsed.bondTension);
  // Persist the full window state so it survives the backend worker idle-unloading
  // (the in-memory lastStateByChat Map is wiped when the worker restarts).
  try {
    await spindle.variables.chat.set(chatId, 'vellum_state_json',
      JSON.stringify({ ledger: parsed, bts: btsRaw, updatedAt: Date.now() }).slice(0, 60000));
  } catch (e) { /* memory only */ }
  // Authoritative day counter: pull "Day N" straight out of the [time] field and
  // persist it. This makes the count survive even if the model forgets to emit
  // the {{incchatvar}} / {{setchatvar}} macros — the next Arc Memory read picks
  // this value up as Day {{@vellum_day}}.
  const dayNum = extractDay(parsed.time);
  if (dayNum) await spindle.variables.chat.set(chatId, 'vellum_day', String(dayNum));
}

// Parse "Day 12" / "Day 12 · ..." / "Day Twelve" out of a time string.
const DAY_WORDS = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };
function extractDay(timeStr) {
  if (!timeStr) return null;
  const m = String(timeStr).match(/\bDay\s+(\d+)\b/i);
  if (m) return parseInt(m[1], 10);
  const w = String(timeStr).match(/\bDay\s+([A-Za-z]+)\b/i);
  if (w) return DAY_WORDS[w[1].toLowerCase()] || null;
  return null;
}

function broadcast(chatId, parsed, btsRaw) {
  spindle.sendToFrontend({
    type: 'vellum_tracker_update',
    chatId,
    ledger: parsed,
    bts: btsRaw,
    updatedAt: Date.now(),
  });
}

/* ============================================================================
 * NAME CONTEXT — resolve the REAL persona ({{user}}) and character ({{char}})
 * names for a chat, so the LLM scanners (cast / memory / knowledge) never have
 * to guess who "{{user}}" is and never mislabel the user's persona.
 *
 * Two permission-free sources, combined:
 *   1. spindle.macros.resolve('{{user}} | {{char}}', { chatId }) — the engine's
 *      own resolution (free tier, needs no extra permission).
 *   2. The `name` field already present on every stored message (persona name
 *      on user turns, character name on assistant turns) — see readStoredMessages.
 * The result is cached briefly per chat so repeated scans stay cheap.
 * ========================================================================== */
const _nameCtxCache = new Map(); // chatId -> { at, ctx }
const NAME_CTX_TTL = 30000;

function _cleanName(s) {
  const n = String(s == null ? '' : s).trim();
  if (!n) return '';
  // Reject unresolved macro tokens and obvious non-names.
  if (/\{\{|\}\}/.test(n)) return '';
  if (n.length > 60) return n.slice(0, 60).trim();
  return n;
}

async function resolveNameContext(chatId, messages) {
  if (!chatId) return { user: '', char: '', userAliases: [], charAliases: [], names: [] };
  const cached = _nameCtxCache.get(chatId);
  if (cached && Date.now() - cached.at < NAME_CTX_TTL) return cached.ctx;

  let user = '', char = '';
  // 1) macro engine (authoritative for {{user}}/{{char}})
  try {
    if (spindle.macros && spindle.macros.resolve) {
      const r = await spindle.macros.resolve('{{user}}\u0001{{char}}', { chatId, commit: false });
      const txt = (r && (r.text || r.result || r)) || '';
      const parts = String(txt).split('\u0001');
      user = _cleanName(parts[0]);
      char = _cleanName(parts[1]);
    }
  } catch (e) { /* fall back to message names */ }

  // 2) message `name` fields — fill any gaps and gather observed speaker names.
  const userNames = new Map(); // cleaned -> count
  const charNames = new Map();
  for (const m of (messages || [])) {
    const nm = _cleanName(m && m.name);
    if (!nm) continue;
    const bucket = (m.isUser || m.role === 'user') ? userNames : charNames;
    bucket.set(nm, (bucket.get(nm) || 0) + 1);
  }
  const topOf = (map) => { let best = '', n = -1; for (const [k, v] of map) if (v > n) { best = k; n = v; } return best; };
  if (!user) user = topOf(userNames);
  if (!char) char = topOf(charNames);

  const userAliases = Array.from(userNames.keys()).filter((n) => n && n !== user);
  const charAliases = Array.from(charNames.keys()).filter((n) => n && n !== char);
  const names = Array.from(new Set([user, char, ...userNames.keys(), ...charNames.keys()].filter(Boolean)));

  const ctx = { user, char, userAliases, charAliases, names };
  _nameCtxCache.set(chatId, { at: Date.now(), ctx });
  return ctx;
}

// Build the instruction block that tells a scanner who the speakers really are.
function namesBlock(nc) {
  if (!nc) return '';
  const lines = [];
  if (nc.user) lines.push('- The human player\u2019s character (referred to as {{user}}) is named: ' + nc.user + (nc.userAliases.length ? ' (also: ' + nc.userAliases.join(', ') + ')' : ''));
  if (nc.char) lines.push('- The primary AI character ({{char}}) is named: ' + nc.char + (nc.charAliases.length ? ' (also: ' + nc.charAliases.join(', ') + ')' : ''));
  if (!lines.length) return '';
  return 'KNOWN SPEAKERS (authoritative \u2014 use these exact names, never the placeholders "{{user}}"/"User"/"{{char}}"):\n' + lines.join('\n') + '\nWhen a memory, fact, or secret concerns the player, write "' + (nc.user || 'the player') + '", not "{{user}}".\n\n';
}

// Substitute real names into the labels + any literal {{user}}/{{char}} in a
// transcript line, so the model reads real names instead of role placeholders.
function applyNamesToText(s, nc) {
  let out = String(s == null ? '' : s);
  if (nc && nc.user) out = out.replace(/\{\{\s*user\s*\}\}/gi, nc.user);
  if (nc && nc.char) out = out.replace(/\{\{\s*char\s*\}\}/gi, nc.char);
  return out;
}

// Canonicalize a name the LLM produced: turn "{{user}}"/"user"/"you" into the
// real persona name, "{{char}}" into the real character name. Leaves other
// names untouched. Used on every who/about/keeper/from field the scanners emit.
function canonName(raw, nc) {
  let n = String(raw == null ? '' : raw).trim();
  if (!n) return n;
  if (nc) {
    if (/^\{\{\s*user\s*\}\}$/i.test(n) || /^(the\s+)?user$/i.test(n) || /^you$/i.test(n)) return nc.user || n;
    if (/^\{\{\s*char\s*\}\}$/i.test(n)) return nc.char || n;
  }
  // Strip a stray surrounding macro if the model wrapped a real name.
  n = n.replace(/\{\{\s*user\s*\}\}/gi, (nc && nc.user) || '').replace(/\{\{\s*char\s*\}\}/gi, (nc && nc.char) || '').trim();
  return n || raw;
}

/* ============================================================================
 * CHRONICLE — long-term continuity ledger.
 * Catalogs every character arc, plot thread, parallel event, and narrative
 * shift across the whole chat, and records how each one evolves turn to turn.
 *  - Built incrementally as each turn arrives (survives the context window).
 *  - Can be fully re-scanned from visible history via rebuild_chronicle.
 *  - Persisted per chat in the vellum_chronicle chat variable.
 * ========================================================================== */
const chronicleByChat = new Map();

function freshChronicle() {
  return { version: 3, updatedAt: 0, turns: 0, lastDay: 1, arcs: {}, threads: {}, events: [], shifts: [], memories: [], cast: {}, present: [], memJournal: {}, knowledge: [], secrets: [], covered: 0, tombstones: { mem: [], know: [], sec: [] }, _sig: '' };
}

function normKey(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}

function chronicleLines(raw) {
  return String(raw || '').split('\n').map((l) => l.replace(/^[\s•▸◉◆›\-]+/, '').trim()).filter(Boolean);
}

function upsertTrack(map, name, status, turn, day) {
  const title = String(name || '').trim();
  const key = normKey(title);
  if (!key) return;
  let t = map[key];
  if (!t) { t = map[key] = { id: key, title, firstTurn: turn, firstDay: day, lastTurn: turn, lastDay: day, status: '', history: [] }; }
  const st = String(status || '').trim();
  const last = t.history[t.history.length - 1];
  if (!last || last.status !== st) {
    t.history.push({ turn, day, status: st });
    if (t.history.length > 14) t.history.shift();
  }
  t.status = st || t.status;
  t.title = title;
  t.lastTurn = turn; t.lastDay = day;
}

function pushLog(arr, entry, cap) {
  const last = arr[arr.length - 1];
  if (last && last.text === entry.text) return;
  arr.push(entry);
  if (arr.length > cap) arr.shift();
}

// Record a deleted-entry signature so re-imports / future scans don't resurrect
// it. Bounded ring buffer per kind.
function addTombstone(ch, kind, sig) {
  if (!sig) return;
  if (!ch.tombstones) ch.tombstones = { mem: [], know: [], sec: [] };
  const arr = ch.tombstones[kind] || (ch.tombstones[kind] = []);
  if (!arr.includes(sig)) { arr.push(sig); if (arr.length > 400) arr.shift(); }
}
function isTombstoned(ch, kind, sig) {
  return !!(ch.tombstones && Array.isArray(ch.tombstones[kind]) && ch.tombstones[kind].includes(sig));
}

function parseArcLine(line) {
  const m = line.match(/^([^:：]{2,60})[:：]\s*(.+)$/);
  if (m) return { name: m[1].trim(), status: m[2].trim() };
  return { name: line.trim(), status: line.trim() };
}

function parseThreadLine(line) {
  let s = line.replace(/^\+?\s*thread\s*[:→\s]*/i, '').trim();
  let title = s.split(/[=—:]/)[0].trim();
  const words = title.split(/\s+/);
  if (words.length > 8) title = words.slice(0, 8).join(' ');
  if (!title) title = s.slice(0, 40);
  return { name: title, detail: s };
}

function foldTurn(ch, turn, day, led, bts) {
  // Character arcs <- ledger [arcs]
  if (led && led.arcs) {
    chronicleLines(led.arcs).forEach((line) => {
      const a = parseArcLine(line);
      upsertTrack(ch.arcs, a.name, a.status, turn, day);
    });
  }
  // Parallel events <- ledger [under]
  if (led && led.offscreen) {
    chronicleLines(led.offscreen).forEach((text) => pushLog(ch.events, { turn, day, text }, 60));
  }
  // Cast presence <- ledger [present]. Free auto-tracking, no LLM needed.
  if (ch.cast) {
    const names = parsePresentNames(led && led.present);
    ch.present = names.slice(0, 12);
    // Resolve each present name to its canonical card id using the strong
    // matcher (handles aliases + first/last-name overlap), so the UI can mark
    // "present" reliably even when the ledger spelling differs from the card.
    const ids = [];
    names.forEach((n) => {
      const c = touchCast(ch, n, turn, day, 'active');
      if (c && c.id) ids.push(c.id);
    });
    ch.presentIds = ids.slice(0, 12);
  }
  // Plot threads / shifts / world events <- [BTS]
  if (bts) {
    String(bts).split('\n').map((l) => l.trim()).filter(Boolean).forEach((line) => {
      if (/^\+?\s*thread\s*[:→]/i.test(line) || /^thread→/i.test(line)) {
        const th = parseThreadLine(line);
        upsertTrack(ch.threads, th.name, th.detail, turn, day);
      } else if (/^rel→/i.test(line)) {
        pushLog(ch.shifts, { turn, day, text: line.replace(/^rel→\s*/i, '').trim(), kind: 'rel' }, 50);
      } else if (/^world\b/i.test(line)) {
        const t = line.replace(/^world[:\s]*/i, '').trim();
        if (t) pushLog(ch.events, { turn, day, text: t }, 60);
      } else {
        // Off-screen / present cast mentioned in BTS actor lines: ":: Name ::" or ":: OFF :: Name"
        const off = line.match(/^::\s*OFF\s*::\s*([^|>]+)/i);
        const on = line.match(/^::\s*([^:|>]+?)\s*::/);
        if (off && off[1]) touchCast(ch, off[1].trim(), turn, day, 'active');
        else if (on && on[1] && !/^OFF$/i.test(on[1].trim())) touchCast(ch, on[1].trim(), turn, day, 'active');
      }
    });
  }
  ch.lastDay = day;
}

// Split a [present] field into clean character names.
function parsePresentNames(raw) {
  if (!raw) return [];
  return String(raw)
    .replace(/\([^)]*\)/g, '')
    .split(/[,;]|\band\b|\&/i)
    .map((s) => s.replace(/^[\s•\-]+|[\s.]+$/g, '').trim())
    .filter((s) => s && s.length <= 40 && /[a-z]/i.test(s) && !/^(the|a|an|no one|nobody|none|various|others?|everyone|crowd|guards?|soldiers?)$/i.test(s));
}

function castKey(name) {
  return String(name).toLowerCase().replace(/^(ser|lord|lady|king|queen|prince|princess|maester|septa|septon)\s+/i, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}

// Find an existing cast member that this name refers to — by key match, by any
// recorded alias (aka), or by first-name overlap (so "Cersei" finds "Cersei
// Lannister" and vice versa). Returns the member or null.
function findCastMember(ch, name) {
  const key = castKey(name);
  if (!key) return null;
  if (ch.cast[key]) return ch.cast[key];
  const akaKey = key;
  for (const k of Object.keys(ch.cast)) {
    const c = ch.cast[k];
    if (k === akaKey) return c;
    if (Array.isArray(c.aka) && c.aka.some((a) => castKey(a) === akaKey)) return c;
  }
  // First-token overlap, BOTH directions: a single-word name matching the first
  // or last word of a fuller name, or a fuller name whose first/last word matches
  // an existing single-word card. ("Cersei" <-> "Cersei Lannister" either order.)
  const tokens = key.split('_').filter(Boolean);
  for (const k of Object.keys(ch.cast)) {
    const parts = k.split('_').filter(Boolean);
    // incoming single-token vs existing multi-token
    if (tokens.length === 1 && parts.length > 1 && (parts[0] === tokens[0] || parts[parts.length - 1] === tokens[0])) return ch.cast[k];
    // incoming multi-token vs existing single-token
    if (parts.length === 1 && tokens.length > 1 && (tokens[0] === parts[0] || tokens[tokens.length - 1] === parts[0])) return ch.cast[k];
  }
  return null;
}

// Record a spelling/alias of a character if it differs from the canonical name.
function addAlias(c, name) {
  const n = String(name || '').trim();
  if (!n) return;
  if (!Array.isArray(c.aka)) c.aka = [];
  const nk = castKey(n);
  if (nk === castKey(c.name)) return;             // same as canonical
  if (c.aka.some((a) => castKey(a) === nk)) return; // already known
  c.aka.push(n);
  if (c.aka.length > 8) c.aka.shift();
}

// Create or update a cast member's presence bookkeeping (never overwrites stats).
function touchCast(ch, name, turn, day, status) {
  const title = String(name || '').trim();
  if (!title || castKey(title).length < 2) return null;
  let c = findCastMember(ch, title);
  if (!c) {
    const key = castKey(title);
    c = ch.cast[key] = { id: key, name: title, aka: [], source: 'auto', status: status || 'active', age: '', appearance: '', role: '', note: '', firstTurn: turn, lastTurn: turn, firstDay: day, lastDay: day, appeared: status === 'active' };
  } else if (castKey(title) !== castKey(c.name)) {
    // Matched an existing character under a different spelling. Promote the fuller
    // name to canonical and keep the other as an alias — either way both spellings
    // now resolve to this one card (kills duplicates).
    if (title.length > (c.name || '').length) {
      const old = c.name;
      c.name = title;
      addAlias(c, old);
    } else {
      addAlias(c, title);
    }
    // Drop any alias that now equals the canonical name.
    c.aka = (c.aka || []).filter((a) => castKey(a) !== castKey(c.name));
  }
  if (status === 'active') {
    if (c.source === 'user') c.appeared = true;
    else c.status = 'active';
    c.lastTurn = turn; c.lastDay = day;
  }
  return c;
}



function sigOf(led, bts) { return (led ? led.raw : '') + '|' + (bts || ''); }

function pruneChronicle(ch) {
  for (const grp of ['arcs', 'threads']) {
    const keys = Object.keys(ch[grp]);
    if (keys.length > 60) {
      keys.sort((a, b) => (ch[grp][a].lastTurn || 0) - (ch[grp][b].lastTurn || 0));
      keys.slice(0, keys.length - 60).forEach((k) => delete ch[grp][k]);
    }
  }
}

async function loadChronicle(chatId) {
  if (chronicleByChat.has(chatId)) return chronicleByChat.get(chatId);
  let ch = freshChronicle();
  try {
    const stored = spindle.variables.chat.get ? await spindle.variables.chat.get(chatId, 'vellum_chronicle') : null;
    if (stored) { const p = JSON.parse(stored); if (p && p.arcs) ch = p; }
  } catch (e) { /* fall back to fresh */ }
  // migrate older chronicles missing the memory fields
  if (!Array.isArray(ch.memories)) ch.memories = [];
  if (typeof ch.covered !== 'number') ch.covered = 0;
  if (!ch.cast || typeof ch.cast !== 'object') ch.cast = {};
  if (!Array.isArray(ch.present)) ch.present = [];
  if (!Array.isArray(ch.presentIds)) ch.presentIds = [];
  if (typeof ch.deepRecall !== 'boolean') ch.deepRecall = false;
  if (!ch.memJournal || typeof ch.memJournal !== 'object') ch.memJournal = {};
  if (!Array.isArray(ch.knowledge)) ch.knowledge = [];
  if (!Array.isArray(ch.secrets)) ch.secrets = [];
  // Tombstones: signatures of entries the user deleted, so a re-import or a
  // future scan never resurrects them. Capped to stay bounded.
  if (!ch.tombstones || typeof ch.tombstones !== 'object') ch.tombstones = { mem: [], know: [], sec: [] };
  if (!Array.isArray(ch.tombstones.mem)) ch.tombstones.mem = [];
  if (!Array.isArray(ch.tombstones.know)) ch.tombstones.know = [];
  if (!Array.isArray(ch.tombstones.sec)) ch.tombstones.sec = [];
  // ensure every cast member has an aka (also-known-as) list
  for (const k of Object.keys(ch.cast)) { if (!Array.isArray(ch.cast[k].aka)) ch.cast[k].aka = []; }
  chronicleByChat.set(chatId, ch);
  return ch;
}

async function saveChronicle(chatId, ch) {
  ch.updatedAt = Date.now();
  pruneChronicle(ch);
  chronicleByChat.set(chatId, ch);
  // NEVER store truncated JSON — a sliced blob is invalid and makes the next
  // load throw and reset the whole chronicle (this is what made summaries
  // vanish). Instead, shrink the heaviest arrays until the JSON fits whole.
  const LIMIT = 90000;
  try {
    let json = JSON.stringify(ch);
    if (json.length > LIMIT) {
      const slim = JSON.parse(json); // structured-clone copy to trim safely
      // 1) drop bulky raw text first
      delete slim.vellum_ledger_raw;
      for (const k of Object.keys(slim.arcs || {})) { delete slim.arcs[k].rawHistory; }
      // 2) progressively trim arrays until it fits
      const trims = [
        () => { if (slim.events && slim.events.length > 40) slim.events = slim.events.slice(-40); },
        () => { if (slim.shifts && slim.shifts.length > 30) slim.shifts = slim.shifts.slice(-30); },
        () => { for (const k of Object.keys(slim.arcs || {})) if (slim.arcs[k].history && slim.arcs[k].history.length > 6) slim.arcs[k].history = slim.arcs[k].history.slice(-6); },
        () => { for (const k of Object.keys(slim.threads || {})) if (slim.threads[k].history && slim.threads[k].history.length > 6) slim.threads[k].history = slim.threads[k].history.slice(-6); },
        () => { if (slim.memories && slim.memories.length > 40) slim.memories = slim.memories.slice(-40); },
        () => { if (slim.events) slim.events = slim.events.slice(-20); if (slim.shifts) slim.shifts = slim.shifts.slice(-20); },
        () => { if (slim.memories && slim.memories.length > 20) slim.memories = slim.memories.slice(-20); },
      ];
      for (const t of trims) { json = JSON.stringify(slim); if (json.length <= LIMIT) break; t(); }
      json = JSON.stringify(slim);
      if (json.length <= LIMIT) {
        // keep the in-memory copy authoritative; only the persisted blob is slimmed
      } else {
        // last resort: keep memories + cast, drop logs, but still valid JSON
        slim.events = []; slim.shifts = [];
        json = JSON.stringify(slim);
      }
    }
    await spindle.variables.chat.set(chatId, 'vellum_chronicle', json);
  } catch (e) { spindle.log.warn(`[vellum_tracker] saveChronicle persist: ${e?.message || e}`); }
  // Compact prose digest the preset injects for LLM recall.
  try { await spindle.variables.chat.set(chatId, 'vellum_chronicle_digest', buildDigest(ch)); } catch (e) { /* memory only */ }
}

// Render the chronicle into a tight, model-facing recall block. Bounded length.
// PINNED BASELINE only: the currently-active arcs & threads, headline form,
// hard-capped. Scene-relevant DEPTH (matched events, shifts, dormant threads)
// is added separately by the interceptor, scored against the live scene — so
// this stays small and never blows the context budget. (LoreRecall pattern.)
function buildDigest(ch) {
  if (!ch) return '';
  const lines = [];
  const dl = (d) => (d ? 'D' + d : '—');
  const arcs = Object.values(ch.arcs || {}).sort((a, b) => (b.lastTurn || 0) - (a.lastTurn || 0)).slice(0, 6);
  const threads = Object.values(ch.threads || {}).sort((a, b) => (b.lastTurn || 0) - (a.lastTurn || 0)).slice(0, 6);
  if (arcs.length) { lines.push('Active arcs:'); arcs.forEach((t) => lines.push('• ' + t.title + ' [' + dl(t.lastDay) + ']: ' + (t.status || ''))); }
  if (threads.length) { lines.push('Active threads:'); threads.forEach((t) => lines.push('• ' + t.title + ': ' + (t.status || ''))); }
  let out = lines.join('\n');
  if (out.length > 700) out = out.slice(0, 700) + '…';
  return out;
}

/* ---------------------------------------------------------------------------
 * SCENE-RELEVANT RECALL (LoreRecall-style retrieval, no embeddings needed).
 * Scores chronicle entries by keyword overlap with the recent conversation and
 * injects only the matches that fit a char budget — surfacing dormant arcs,
 * old events, and past shifts precisely when the scene calls for them.
 * ------------------------------------------------------------------------- */
const RECALL = {
  queryMessages: 4,   // how many recent messages form the retrieval query
  budgetChars: 1400,  // max chars of scene-relevant recall injected per turn
  minScore: 3,        // min scene-weighted score to inject (newest-turn hit or phrase, or 2+ shared tokens)
  maxItems: 12,
};

const RECALL_STOP = new Set(['the','and','for','with','that','this','her','his','him','she','they','them','their','was','were','are','you','your','from','into','but','not','had','has','have','will','would','could','should','what','when','where','who','why','how','all','any','out','off','over','then','there','about','said','says','like','just','its','also','been','being','because','around','before','after','still','than','too','very','more','most','some','such','only','even','onto','upon','while','here','now','one','two']);

function recallTokens(text) {
  const m = String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9''-]{2,}/g) || [];
  return m;
}

function uniqTokens(arr) {
  const seen = new Set();
  const out = [];
  for (const t of arr) { if (!RECALL_STOP.has(t) && !seen.has(t)) { seen.add(t); out.push(t); } }
  return out;
}

function queryFromMessages(messages, n) {
  const parts = [];
  let taken = 0;
  for (let i = messages.length - 1; i >= 0 && taken < n; i--) {
    const m = messages[i];
    let c = typeof m.content === 'string' ? m.content : '';
    if (!c) continue;
    c = stripReverie(stripLedger(stripBts(c)));
    if (c.trim()) { parts.push(c); taken++; }
  }
  return parts.join('\n');
}

// LoreRecall-style scene signals: the LATEST exchange weighs far more than older
// context. Returns a layered query so retrieval favors what's happening NOW.
function sceneSignals(messages, n) {
  const layers = []; // [{text, weight}] newest first
  let taken = 0;
  for (let i = messages.length - 1; i >= 0 && taken < n; i--) {
    const m = messages[i];
    let c = typeof m.content === 'string' ? m.content : '';
    if (!c) continue;
    c = stripReverie(stripLedger(stripBts(c))).trim();
    if (!c) continue;
    // newest message ×3, second ×2, the rest ×1 — recency-weighted scene focus
    const weight = taken === 0 ? 3 : (taken === 1 ? 2 : 1);
    layers.push({ tokens: uniqTokens(recallTokens(c)), text: normForPhrase(c), weight });
    taken++;
  }
  return layers;
}

function normForPhrase(s) {
  return ' ' + String(s).toLowerCase().replace(/[^a-z0-9'’ ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
}

// Weighted token overlap across the scene layers (recent turns matter more).
function layeredScore(entryText, layers) {
  const etoks = new Set(recallTokens(entryText));
  if (!etoks.size) return 0;
  let s = 0;
  for (const L of layers) {
    let hit = 0;
    for (const t of L.tokens) if (etoks.has(t)) hit++;
    s += hit * L.weight;
  }
  return s;
}

// Phrase bonus: a multi-word fragment of the entry appearing verbatim in the
// recent scene is a much stronger signal than scattered shared tokens.
function phraseBonus(entryTitle, layers) {
  const title = normForPhrase(entryTitle).trim();
  if (title.length < 4) return 0;
  let b = 0;
  for (const L of layers) {
    if (title.length >= 6 && L.text.includes(' ' + title + ' ')) b += 6 * L.weight;
  }
  // also reward any 2-word shingle of the title found in the latest layer,
  // but only when BOTH words are distinctive (not stopwords) — otherwise common
  // pairs like "the serving" / "serving girl" cause false phrase matches.
  if (layers.length) {
    const words = title.split(' ').filter((w) => w.length > 2 && !RECALL_STOP.has(w));
    for (let i = 0; i + 1 < words.length; i++) {
      const sh = ' ' + words[i] + ' ' + words[i + 1] + ' ';
      if (layers[0].text.includes(sh)) { b += 3; break; }
    }
  }
  return b;
}

function overlapScore(entryText, qtokens) {
  const eset = new Set(recallTokens(entryText));
  if (!eset.size) return 0;
  let s = 0;
  for (const t of qtokens) if (eset.has(t)) s++;
  return s;
}

// Select scene-relevant entries, excluding the arcs/threads already pinned.
function selectRelevant(ch, queryText, pinnedArcIds, pinnedThreadIds, opts) {
  const o = Object.assign({}, RECALL, opts || {});
  const qtokens = uniqTokens(recallTokens(queryText));
  if (qtokens.length < 2) return { lines: [], trace: [] };
  const cands = gatherCandidates(ch, queryText, pinnedArcIds, pinnedThreadIds);
  const approved = o.approved instanceof Map ? o.approved : null;
  const lines = [];
  const trace = [];
  let used = 0;
  for (const c of cands) {
    // Deep Recall mode: inject only what the controller-LLM approved (with its
    // reason). Lexical mode: gate by score. Either way honor budget + cap.
    if (approved) { if (!approved.has(c.id)) continue; }
    else if (c.score < o.minScore) continue;
    if (lines.length >= o.maxItems) break;
    if (used + c.line.length + 1 > o.budgetChars) continue;
    lines.push(c.line);
    const why = approved ? (approved.get(c.id) || 'LLM judged relevant') : (c.why || 'relevance ' + Math.round(c.score));
    trace.push({ kind: c.kind, label: c.label, score: approved ? '✓' : Math.round(c.score * 10) / 10, why });
    used += c.line.length + 1;
  }
  return { lines, trace };
}

// Stable id for a candidate so the controller can approve specific entries.
function vhash(s) { let h = 0; const t = String(s); for (let i = 0; i < t.length; i++) { h = (h * 31 + t.charCodeAt(i)) | 0; } return (h >>> 0).toString(36); }

// Gather all scene-scored candidates (no gating); each has a stable id.
function gatherCandidates(ch, queryText, pinnedArcIds, pinnedThreadIds) {
  const layers = buildLayersFromQuery(queryText);
  const dl = (d) => (d ? 'D' + d : '—');
  const rate = (title, statusText, bodyText) => {
    const tok = layeredScore((title + ' ' + (statusText || '') + ' ' + (bodyText || '')), layers);
    const ph = phraseBonus(title, layers);
    const why = [];
    if (ph > 0) why.push('names "' + title.slice(0, 40) + '" in the recent scene');
    if (tok > 0) why.push(tok + ' scene-weighted keyword hit' + (tok === 1 ? '' : 's'));
    return { score: tok + ph, why: why.join('; ') };
  };
  const cands = [];
  Object.values(ch.arcs || {}).forEach((t) => {
    if (pinnedArcIds.has(t.id)) return;
    const r = rate(t.title, t.status, '');
    if (r.score > 0) cands.push({ id: 'arc:' + t.id, score: r.score + 0.5, recency: t.lastTurn || 0, kind: 'arc', label: t.title, why: r.why, line: '◉ ' + t.title + ' [' + dl(t.lastDay) + ']: ' + (t.status || '') });
  });
  Object.values(ch.threads || {}).forEach((t) => {
    if (pinnedThreadIds.has(t.id)) return;
    const r = rate(t.title, t.status, '');
    if (r.score > 0) cands.push({ id: 'thread:' + t.id, score: r.score + 0.5, recency: t.lastTurn || 0, kind: 'thread', label: t.title, why: r.why, line: '🧵 ' + t.title + ' [' + dl(t.lastDay) + ']: ' + (t.status || '') });
  });
  (ch.events || []).forEach((e, i) => {
    const r = rate(e.text, '', '');
    if (r.score > 0) cands.push({ id: 'event:' + vhash(e.text), score: r.score, recency: i, kind: 'event', label: e.text.slice(0, 48), why: r.why, line: '▸ ' + dl(e.day) + ': ' + e.text });
  });
  (ch.shifts || []).forEach((s, i) => {
    const r = rate(s.text, '', '');
    if (r.score > 0) cands.push({ id: 'shift:' + vhash(s.text), score: r.score, recency: i, kind: 'shift', label: s.text.slice(0, 48), why: r.why, line: '⚲ ' + dl(s.day) + ': ' + s.text });
  });
  (ch.memories || []).forEach((m, i) => {
    const kw = (m.keywords || []).join(' ');
    const kwScore = layeredScore(kw, layers) * 2;
    const bodyScore = layeredScore(m.text, layers);
    const ph = phraseBonus(kw, layers);
    const score = kwScore + bodyScore + ph;
    if (score > 0) {
      const why = [];
      if (kwScore > 0) why.push('memory keyword match');
      if (ph > 0) why.push('keyword phrase in scene');
      if (bodyScore > 0 && !why.length) why.push('summary keyword hit');
      cands.push({ id: 'mem:' + (m.id || ('t' + m.fromTurn)), score: score + 0.25, recency: 1000 + i, kind: 'memory', label: 't' + m.fromTurn + '-' + m.toTurn, why: why.join('; '), line: '✦ ' + dl(m.day) + ' (t' + m.fromTurn + '-' + m.toTurn + '): ' + m.text });
    }
  });
  cands.sort((a, b) => (b.score - a.score) || (b.recency - a.recency));
  return cands;
}

// Build weighted scene layers from a flat query string (newest content weighs
// more). Used when callers pass plain text instead of a message array.
function buildLayersFromQuery(queryText) {
  const blocks = String(queryText || '').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (!blocks.length) return [{ tokens: uniqTokens(recallTokens(queryText)), text: normForPhrase(queryText), weight: 1 }];
  // last block = newest = highest weight
  return blocks.reverse().map((b, idx) => ({
    tokens: uniqTokens(recallTokens(b)),
    text: normForPhrase(b),
    weight: idx === 0 ? 3 : (idx === 1 ? 2 : 1),
  }));
}

function pinnedIdSets(ch) {
  const arcIds = new Set(Object.values(ch.arcs || {}).sort((a, b) => (b.lastTurn || 0) - (a.lastTurn || 0)).slice(0, 6).map((t) => t.id));
  const threadIds = new Set(Object.values(ch.threads || {}).sort((a, b) => (b.lastTurn || 0) - (a.lastTurn || 0)).slice(0, 6).map((t) => t.id));
  return { arcIds, threadIds };
}

function findLastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return i;
  return -1;
}

function chronicleHasContent(ch) {
  return ch && (Object.keys(ch.arcs || {}).length || Object.keys(ch.threads || {}).length || (ch.events || []).length || (ch.shifts || []).length || (ch.memories || []).length || Object.keys(ch.cast || {}).length);
}

// Compact cast roster for recall: present characters always included, plus any
// whose name/role/appearance matches the scene query. Bounded char budget.
function buildCastDigest(ch, query) {
  const cast = ch.cast || {};
  const keys = Object.keys(cast);
  if (!keys.length) return '';
  // Present-detection: prefer the backend-resolved presentIds; fall back to
  // resolving names with the strong matcher for older chronicles.
  const presentIds = new Set(ch.presentIds || []);
  if (!presentIds.size) {
    (ch.present || []).forEach((n) => { const m = findCastMember(ch, n); if (m) presentIds.add(m.id); });
  }
  const qtokens = uniqTokens(recallTokens(query || ''));
  const qphrase = normForPhrase(query || '');

  const present = [];
  const relevant = [];
  for (const k of keys) {
    const c = cast[k];
    if (presentIds.has(c.id)) { present.push({ c, s: 1000, recent: c.lastTurn || 0 }); continue; }
    // Relevance for NON-present characters must be NAME/ALIAS driven — that's the
    // real signal a character is in play. Role/appearance words (guard, tall,
    // woman…) are common and cause false matches, so they barely count.
    const nameHit = nameSignal(c, qtokens, qphrase);
    if (nameHit <= 0) continue;                       // hard gate: no name/alias hit → skip
    let s = nameHit;
    if (c.source === 'user') s += 2;                  // gently favor authored cards
    if (c.status === 'mentioned') s -= 1;
    relevant.push({ c, s, recent: c.lastTurn || 0 });
  }
  relevant.sort((a, b) => (b.s - a.s) || (b.recent - a.recent));

  // Inject ALL present characters, then at most a few genuinely-named others.
  const MAX_RELEVANT = 3;
  const RELEVANT_MIN = 2; // must clear a real bar, not a single stray token
  const chosen = present.concat(relevant.filter((r) => r.s >= RELEVANT_MIN).slice(0, MAX_RELEVANT));

  const out = [];
  const trace = [];
  let used = 0;
  for (const { c, s } of chosen) {
    if (out.length >= 10) break;
    const bits = [c.name];
    if (c.aka && c.aka.length) bits.push('aka ' + c.aka.join('/'));
    if (c.age) bits.push('age ' + c.age);
    if (c.appearance) bits.push(c.appearance);
    if (c.role) bits.push('— ' + c.role);
    const line = '• ' + bits.join(', ');
    if (used + line.length + 1 > 800) continue;
    out.push(line);
    trace.push({ kind: 'cast', label: c.name, score: s >= 1000 ? '∞' : Math.round(s * 10) / 10, why: s >= 1000 ? 'present in the current scene' : 'named in the recent scene' });
    used += line.length + 1;
  }
  return { text: out.join('\n'), trace };
}

// Scene-relevant knowledge/secrets for injection (dramatic irony). Surfaces the
// facts and secrets whose subjects/keepers/content the current scene touches.
function buildKnowledgeDigest(ch, query) {
  const qtokens = uniqTokens(recallTokens(query || ''));
  if (qtokens.length < 2) return '';
  const score = (txt) => { const e = new Set(recallTokens(txt)); let n = 0; for (const t of qtokens) if (e.has(t)) n++; return n; };
  const out = [];
  const kn = (ch.knowledge || []).map((k) => ({ k, s: score(k.who + ' ' + k.fact) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 5);
  for (const { k } of kn) {
    let tag = k.reliability;
    if (k.reliability === 'wrong') tag = 'WRONGLY believes';
    else if (k.reliability === 'unaware') tag = 'does NOT know';
    out.push('\u25C7 ' + k.who + ' ' + tag + ': ' + k.fact + (k.reliability === 'wrong' && k.truth === 'false' ? ' (it is not true)' : ''));
  }
  const sc = (ch.secrets || []).filter((x) => !x.revealed).map((x) => ({ x, s: score(x.secret + ' ' + x.keeper + ' ' + (x.from || '')) })).filter((y) => y.s > 0).sort((a, b) => b.s - a.s).slice(0, 4);
  for (const { x } of sc) {
    out.push('\u26BF ' + x.keeper + ' hides from ' + (x.from || 'others') + ': ' + x.secret + ' [' + x.danger + ']');
  }
  let used = 0; const kept = [];
  for (const line of out) { if (used + line.length + 1 > 700) continue; kept.push(line); used += line.length + 1; }
  return kept.join('\n');
}

// How strongly the SCENE names this character (not just shares a common word).
// Full-name phrase in scene = strong; an alias/first-name token hit = moderate.
function nameSignal(c, qtokens, qphrase) {
  let s = 0;
  const full = normForPhrase(c.name).trim();
  if (full.length >= 3 && qphrase.includes(' ' + full + ' ')) s += 6;       // exact name in scene
  // distinctive name tokens (skip generic titles)
  const GENERIC = new Set(['the', 'a', 'an', 'ser', 'lord', 'lady', 'king', 'queen', 'prince', 'princess', 'maester', 'septa', 'septon', 'man', 'woman', 'girl', 'boy', 'guard', 'soldier', 'stranger']);
  const ntoks = recallTokens(c.name).filter((t) => t.length >= 3 && !GENERIC.has(t));
  const qset = new Set(qtokens);
  for (const t of ntoks) if (qset.has(t)) s += 3;                            // a real name token in scene
  for (const a of (c.aka || [])) {
    const at = normForPhrase(a).trim();
    if (at.length >= 3 && qphrase.includes(' ' + at + ' ')) { s += 4; break; }
  }
  return s;
}

/* ============================================================================
 * AUTO-SUMMARY MEMORY (LumiBooks-style, no lorebook required).
 * As older turns accumulate beyond the live context window, a background
 * generation distills each window into a compact, keyworded "chapter memory".
 * These memories then feed the same scene-relevance retrieval as the chronicle,
 * so the model recalls distilled prose history the structured tracker can't hold.
 * ------------------------------------------------------------------------- */
const SUMMARY = {
  windowTurns: 8,     // summarize this many uncovered assistant-turns at once
  triggerLead: 4,     // only summarize turns this far behind the newest (keep recent raw)
  maxChars: 1600,     // cap on a single memory's prose (compact but complete)
  maxMemories: 80,    // ring-buffer cap
  minToSummarize: 6,  // need at least this many uncovered turns to bother
};

const summarizing = new Set(); // chatIds with an in-flight summary (no overlap)

function assistantTurns(messages) {
  // Flatten to ordered {role, content} keeping only ledger-bearing assistant turns
  // plus their preceding user turn, so a memory has both sides of the exchange.
  // Also carry the real speaker `name` on each side when the host provides it.
  const turns = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant') {
      const prev = i > 0 && messages[i - 1].role === 'user' ? messages[i - 1] : null;
      turns.push({
        idx: i,
        user: prev ? prev.content : '',
        userName: prev ? (prev.name || '') : '',
        ai: m.content,
        aiName: m.name || '',
      });
    }
  }
  return turns;
}

function cleanForSummary(s) {
  return stripVtk(stripBts(stripLedger(stripReverie(String(s || ''))))).replace(/\n{3,}/g, '\n\n').trim();
}

const SUMMARY_SYS = 'You are a story archivist compressing a roleplay excerpt into one dense, factual chapter-memory for long-term recall. Output STRICT JSON only, no prose outside it: {"summary":"3-6 tight past-tense sentences covering EVERYTHING that matters from the excerpt — who was involved, where, key actions, decisions, revelations, emotional turns, and what changed by the end; pack facts, drop atmosphere and filler","keywords":["8-14 lowercase names/places/objects/topics a future scene might key on"],"day":<integer story-day if stated else null>}. Rules: ALWAYS use the real character names provided — never write "{{user}}", "User", "{{char}}", or "you"; be comprehensive but compact (no repetition, no vibes, no commentary); every distinct beat in the excerpt should be recoverable from the summary.';

function parseSummaryJson(text) {
  let t = String(text || '').replace(/<think[\s\S]*?<\/think>/gi, '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  let obj = null;
  try { obj = JSON.parse(t); } catch (e) {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch (e2) { obj = null; } }
  }
  if (!obj || typeof obj !== 'object') return null;
  const summary = String(obj.summary || '').trim();
  if (!summary) return null;
  const keywords = Array.isArray(obj.keywords) ? obj.keywords.map((k) => String(k).toLowerCase().trim()).filter(Boolean).slice(0, 14) : [];
  const day = Number.isFinite(obj.day) ? obj.day : null;
  return { summary: summary.slice(0, SUMMARY.maxChars), keywords, day };
}

// Try to summarize the next uncovered window. Background, best-effort, no overlap.
// Summarize ONE next uncovered window. Returns 'done' | 'none' | 'error'.
// `forceFull` ignores the triggerLead/min thresholds so a manual backfill can
// catch up the entire history on demand (the "rescan"-style behavior).
async function summarizeOneWindow(chatId, opts, userId) {
  const o = opts || {};
  const ch = await loadChronicle(chatId);
  const msgs = await readStoredMessages(chatId);
  if (!msgs || !msgs.length) return 'none';
  const turns = assistantTurns(msgs);
  let covered = ch.covered || 0;
  // Self-heal: coverage must never exceed the real stored-turn count. An older
  // build could leave it stuck high (e.g. counting swipe-inflated turns), which
  // would make every backfill falsely report "already up to date".
  if (covered > turns.length) { covered = ch.covered = turns.length; }
  const lead = o.forceFull ? 1 : SUMMARY.triggerLead;
  const available = turns.length - lead;
  const uncovered = available - covered;
  const minNeeded = o.forceFull ? 1 : SUMMARY.minToSummarize;
  if (uncovered < minNeeded) return 'none';

  const windowTurns = turns.slice(covered, covered + Math.min(SUMMARY.windowTurns, uncovered));
  if (!windowTurns.length) return 'none';

  const nc = await resolveNameContext(chatId, msgs);
  const excerpt = windowTurns.map((t) => {
    const uName = (t.userName && t.userName.trim()) || (nc && nc.user) || 'USER';
    const aName = (t.aiName && t.aiName.trim()) || (nc && nc.char) || 'STORY';
    const u = applyNamesToText(cleanForSummary(t.user), nc);
    const a = applyNamesToText(cleanForSummary(t.ai), nc);
    return (u ? uName + ': ' + u + '\n' : '') + aName + ': ' + a;
  }).join('\n\n').slice(0, 16000);

  let content = '';
  try {
    content = await internalGenerate([
      { role: 'system', content: SUMMARY_SYS + (namesBlock(nc) ? ('\n\n' + namesBlock(nc)).trimEnd() : '') },
      { role: 'user', content: 'Excerpt to archive:\n\n' + excerpt },
    ], { temperature: 0.3, max_tokens: 2000 }, userId);
  } catch (e) {
    spindle.log.warn(`[vellum_tracker] summary gen failed: ${e?.message || e}`);
    return e && e.permDenied ? 'perm' : 'error';
  }
  const parsed = parseSummaryJson(content);
  if (!parsed) { spindle.log.warn('[vellum_tracker] summary parse failed'); return 'error'; }

  // Day for this memory = the day of the FIRST turn in the window, read from its
  // own [time] ledger. The model's parsed.day is a fallback; ch.lastDay (the
  // CURRENT day) must never be used — that's what made old memories show "today".
  let windowDay = null;
  for (const t of windowTurns) {
    const d = extractDay((parseLedger(t.ai) || {}).time);
    if (d) { windowDay = d; break; }
  }
  const fromTurn = covered + 1;
  const toTurn = covered + windowTurns.length;
  ch.memories.push({
    id: 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36),
    fromTurn, toTurn,
    day: windowDay || parsed.day || null,
    text: parsed.summary,
    keywords: parsed.keywords,
  });
  if (ch.memories.length > SUMMARY.maxMemories) ch.memories.shift();
  ch.covered = toTurn;
  await saveChronicle(chatId, ch);
  broadcastChronicle(chatId, ch);
  spindle.log.info(`[vellum_tracker] archived memory turns ${fromTurn}-${toTurn} (${parsed.keywords.length} keywords)`);
  return 'done';
}

/* ============================================================================
 * DEEP RECALL — async controller-LLM relevance cache (Option B).
 * After each turn, a BACKGROUND generation judges which lexical candidates are
 * genuinely relevant to the current scene and caches the approved ids+reasons.
 * The interceptor then injects only the cached approvals — instant, zero added
 * latency, with the lexical scorer as fallback when no cache exists.
 * ------------------------------------------------------------------------- */
const DEEP = { maxCandidates: 24, ttlTurns: 1 };
const deepCacheByChat = new Map(); // chatId -> { turnKey, approved:Map(id->reason) }
const deepRunning = new Set();

function deepEnabled(ch) {
  // opt-in: enabled when chat var vellum_deep_recall is truthy, OR the chronicle
  // flag ch.deepRecall is set. Default off (lexical-only) to avoid surprise cost.
  return !!(ch && ch.deepRecall);
}

const DEEP_SYS = 'You are a story continuity filter. Given the CURRENT SCENE and a numbered list of CANDIDATE memory entries, choose ONLY the entries that are genuinely relevant to what is happening right now — the people present, the immediate situation, threads/events the scene actually touches. Reject anything off-topic, stale, or merely sharing a common word. Output STRICT JSON only: {"keep":[{"n":<number>,"why":"<=8 words"}]}. Keep it tight: usually 0–6 entries. No prose outside the JSON.';

function parseDeepJson(text) {
  let t = String(text || '').replace(/<think[\s\S]*?<\/think>/gi, '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  let obj = null;
  try { obj = JSON.parse(t); } catch (e) { const m = t.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch (e2) { obj = null; } } }
  if (!obj || !Array.isArray(obj.keep)) return null;
  return obj.keep.map((k) => ({ n: parseInt(k.n, 10), why: String(k.why || '').slice(0, 60) })).filter((k) => Number.isFinite(k.n));
}

// Run the controller for the latest scene; cache approved candidate ids.
async function runDeepRecall(chatId, messages, userId) {
  if (!chatId || deepRunning.has(chatId)) return;
  if (!(spindle.generate && (spindle.generate.raw || spindle.generate.quiet))) return;
  try {
    const ch = await loadChronicle(chatId);
    if (!deepEnabled(ch) || !chronicleHasContent(ch)) return;
    const query = queryFromMessages(messages, RECALL.queryMessages);
    const { arcIds, threadIds } = pinnedIdSets(ch);
    const cands = gatherCandidates(ch, query, arcIds, threadIds).slice(0, DEEP.maxCandidates);
    const turnKey = ch.turns || 0;
    if (!cands.length) { deepCacheByChat.set(chatId, { turnKey, approved: new Map() }); return; }
    deepRunning.add(chatId);

    const sceneText = query.slice(-2000);
    const list = cands.map((c, i) => (i + 1) + '. ' + c.line.replace(/\s+/g, ' ').slice(0, 160)).join('\n');
    let raw = '';
    try {
      raw = await internalGenerate(
        [{ role: 'system', content: DEEP_SYS },
         { role: 'user', content: 'CURRENT SCENE:\n' + sceneText + '\n\nCANDIDATES:\n' + list + '\n\nReturn the relevant ones as JSON.' }],
        { temperature: 0.1, max_tokens: 600 }, userId);
    } catch (e) { spindle.log.warn(`[vellum_tracker] deep recall gen: ${e?.message || e}`); deepRunning.delete(chatId); return; }

    const keep = parseDeepJson(raw);
    if (!keep) { deepRunning.delete(chatId); return; }
    const approved = new Map();
    for (const k of keep) { const c = cands[k.n - 1]; if (c) approved.set(c.id, k.why || 'LLM judged relevant'); }
    deepCacheByChat.set(chatId, { turnKey, approved });
    spindle.log.info(`[vellum_tracker] deep recall: ${approved.size}/${cands.length} approved`);
  } catch (err) {
    spindle.log.warn(`[vellum_tracker] runDeepRecall: ${err?.message || err}`);
  } finally {
    deepRunning.delete(chatId);
  }
}

// Get a still-fresh approved map for the interceptor (or null to use lexical).
function deepApproved(chatId, ch) {
  if (!deepEnabled(ch)) return null;
  const c = deepCacheByChat.get(chatId);
  if (!c) return null;
  if ((ch.turns || 0) - c.turnKey > DEEP.ttlTurns) return null; // too old; fall back to lexical
  return c.approved;
}


// Background trigger after a turn: summarize at most one window.
async function maybeSummarize(chatId, userId) {
  if (!chatId || summarizing.has(chatId)) return;
  if (!(spindle.generate && (spindle.generate.raw || spindle.generate.quiet)) || !(spindle.chat && spindle.chat.getMessages)) return;
  summarizing.add(chatId);
  try { await summarizeOneWindow(chatId, { forceFull: false }, userId); }
  catch (err) { spindle.log.warn(`[vellum_tracker] maybeSummarize: ${err?.message || err}`); }
  finally { summarizing.delete(chatId); }
}

// On-demand backfill: summarize ALL uncovered past windows in one pass, like the
// rescan feature does for the structured tracker. Bounded by a window cap so a
// huge chat can't fire unbounded LLM calls; re-run to continue if it caps out.
async function summarizeAll(chatId, userId) {
  if (!chatId) { spindle.sendToFrontend({ type: 'vellum_summary_done', ok: false, reason: 'no_active_chat' }, userId); return; }
  if (!hasPerm('generation') || !(spindle.generate && (spindle.generate.raw || spindle.generate.quiet))) { spindle.sendToFrontend({ type: 'vellum_summary_done', ok: false, reason: 'no_generation_permission' }, userId); return; }
  if (!hasPerm('chat_mutation')) { spindle.sendToFrontend({ type: 'vellum_summary_done', ok: false, reason: 'no_chat_mutation_permission' }, userId); return; }
  if (summarizing.has(chatId)) { spindle.sendToFrontend({ type: 'vellum_summary_done', ok: false, reason: 'busy' }, userId); return; }
  summarizing.add(chatId);
  let made = 0;
  const MAX_WINDOWS = 40; // safety cap per backfill run
  try {
    // Probe: confirm there is actually readable history before claiming success.
    const probe = await readStoredMessages(chatId);
    if (!probe || !probe.length) {
      spindle.sendToFrontend({ type: 'vellum_summary_done', ok: false, reason: 'no_history' }, userId);
      return;
    }
    for (let i = 0; i < MAX_WINDOWS; i++) {
      const r = await summarizeOneWindow(chatId, { forceFull: true }, userId);
      if (r === 'done') { made++; spindle.sendToFrontend({ type: 'vellum_summary_progress', made }, userId); }
      else if (r === 'perm') { spindle.sendToFrontend({ type: 'vellum_summary_done', ok: false, reason: 'no_generation_permission', made }, userId); return; }
      else if (r === 'error' && made === 0) { spindle.sendToFrontend({ type: 'vellum_summary_done', ok: false, reason: 'gen_failed', made }, userId); return; }
      else break; // 'none' (caught up) or error after some progress
    }
    const ch = await loadChronicle(chatId);
    // Report the real counts so "up to date" is verifiable: stored assistant
    // turns vs how far coverage reached. (The ledger's turn number counts every
    // generation incl. swipes/regens, so it runs ahead of stored message count.)
    const storedTurns = probe.filter((m) => m.role === 'assistant').length;
    spindle.sendToFrontend({
      type: 'vellum_summary_done', ok: true, made,
      total: (ch.memories || []).length,
      covered: ch.covered || 0,
      storedTurns,
      capped: made >= MAX_WINDOWS,
    }, userId);
  } catch (err) {
    const reason = (err && err.permDenied) ? 'no_chat_mutation_permission' : 'error';
    spindle.log.warn(`[vellum_tracker] summarizeAll: ${err?.message || err}`);
    spindle.sendToFrontend({ type: 'vellum_summary_done', ok: false, reason, made }, userId);
  } finally {
    summarizing.delete(chatId);
  }
}




/* ============================================================================
 * CAST SCAN (LLM) — enrich the auto-tracked roster with age/appearance/role and
 * discover characters only *mentioned* (named but not yet on-page). Best-effort,
 * background, on-demand. Never overwrites user-authored fields.
 * ========================================================================== */
const scanningCast = new Set();

const CAST_SYS = 'You are a meticulous story-bible archivist reading a roleplay transcript. Extract EVERY named or distinctly-referenced character (including those only spoken about, and including the human player\u2019s own character). For each, infer their details from the WHOLE excerpt, not one line. Output STRICT JSON only: {"characters":[{"name":"Canonical Full Name","aka":["other names/nicknames/titles used"],"age":"e.g. 32 / mid-30s / unknown","appearance":"distinguishing looks, terse","role":"their function/relationship in the story","mentioned_only":true|false}]}. Rules: ALWAYS use the real names given to you \u2014 never output "{{user}}", "User", "{{char}}", or "you" as a name; pick the fullest form as the canonical name and list shorter spellings/nicknames/titles in aka; set mentioned_only=true only if they never appear or act on-page; keep age/appearance/role under ~14 words; never invent unsupported details (use "unknown"); merge obvious duplicates into one entry. No prose outside the JSON.';

function parseCastJson(text) {
  let t = String(text || '').replace(/<think[\s\S]*?<\/think>/gi, '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  let obj = null;
  try { obj = JSON.parse(t); } catch (e) {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch (e2) { obj = null; } }
  }
  if (!obj || !Array.isArray(obj.characters)) return null;
  return obj.characters.map((c) => ({
    name: String(c.name || '').trim().slice(0, 60),
    aka: Array.isArray(c.aka) ? c.aka.map((a) => String(a).trim()).filter(Boolean).slice(0, 8) : [],
    age: String(c.age || '').trim().slice(0, 40),
    appearance: String(c.appearance || '').trim().slice(0, 120),
    role: String(c.role || '').trim().slice(0, 120),
    mentionedOnly: !!c.mentioned_only,
  })).filter((c) => c.name && /[a-z]/i.test(c.name));
}

// Smarter history sampler for the LLM scanners. Instead of only head+tail,
// walk the WHOLE transcript and pick evenly-spaced turns plus the opening and
// the most recent ones, so a scan reflects the entire story, not just the ends.
function sampleHistory(turns, opts) {
  const o = Object.assign({ maxTurns: 22, headN: 3, tailN: 9, charBudget: 16000, nameCtx: null }, opts || {});
  if (!turns.length) return '';
  const nc = o.nameCtx;
  const userLabel = (t) => _cleanName(t.userName) || (nc && nc.user) || 'USER';
  const aiLabel = (t) => _cleanName(t.aiName) || (nc && nc.char) || 'STORY';
  const n = turns.length;
  const idx = new Set();
  for (let i = 0; i < Math.min(o.headN, n); i++) idx.add(i);
  for (let i = Math.max(0, n - o.tailN); i < n; i++) idx.add(i);
  // evenly distribute the remaining budget across the middle
  const remaining = Math.max(0, o.maxTurns - idx.size);
  if (remaining > 0 && n > o.headN + o.tailN) {
    const lo = o.headN, hi = n - o.tailN;
    const step = (hi - lo) / (remaining + 1);
    for (let k = 1; k <= remaining; k++) idx.add(Math.round(lo + step * k));
  }
  const picked = Array.from(idx).filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
  const parts = picked.map((i) => {
    const t = turns[i];
    const u = applyNamesToText(cleanForSummary(t.user), nc);
    const a = applyNamesToText(cleanForSummary(t.ai), nc);
    return '[turn ' + (i + 1) + '] ' + (u ? userLabel(t) + ': ' + u + '\n' : '') + aiLabel(t) + ': ' + a;
  });
  // trim to budget from the FRONT (keep most recent if over)
  let out = parts.join('\n\n');
  if (out.length > o.charBudget) out = out.slice(out.length - o.charBudget);
  return out;
}

// Apply a parsed cast list to the chronicle (shared by live scan + import).
// Returns { added, enriched }. Canonicalizes {{user}}/{{char}} via nameCtx.
function applyCastList(ch, list, nc) {
  let added = 0, enriched = 0;
  const turnNow = ch.turns || 0;
  for (const c of list) {
    c.name = canonName(c.name, nc);
    if (Array.isArray(c.aka)) c.aka = c.aka.map((a) => canonName(a, nc)).filter(Boolean);
    if (!c.name || castKey(c.name).length < 2) continue;
    let m = findCastMember(ch, c.name);
    if (!m) {
      const key = castKey(c.name);
      m = ch.cast[key] = { id: key, name: c.name, aka: [], source: 'auto', status: c.mentionedOnly ? 'mentioned' : 'active', age: '', appearance: '', role: '', note: '', firstTurn: turnNow, lastTurn: turnNow, firstDay: ch.lastDay, lastDay: ch.lastDay };
      added++;
    } else {
      addAlias(m, c.name); // record this spelling so it resolves to the same card
    }
    if (Array.isArray(c.aka)) c.aka.forEach((a) => addAlias(m, a));
    if (m.source === 'user') continue; // never overwrite user-authored cards
    let touched = false;
    if (c.age && !m.age) { m.age = c.age; touched = true; }
    if (c.appearance && (!m.appearance || m.appearance.length < c.appearance.length)) { m.appearance = c.appearance; touched = true; }
    if (c.role && (!m.role || m.role.length < c.role.length)) { m.role = c.role; touched = true; }
    if (m.status !== 'active' && !c.mentionedOnly) m.status = 'active';
    if (touched) enriched++;
  }
  return { added, enriched };
}

// Run the cast LLM extraction over a turns array. Returns the parsed list or null.
async function castExtract(turns, nc, userId) {
  const excerpt = sampleHistory(turns, { maxTurns: 22, headN: 3, tailN: 9, charBudget: 15000, nameCtx: nc });
  const sys = CAST_SYS + (namesBlock(nc) ? ('\n\n' + namesBlock(nc)).trimEnd() : '');
  const castContent = await internalGenerate(
    [{ role: 'system', content: sys }, { role: 'user', content: 'Excerpt:\n\n' + excerpt }],
    { temperature: 0.2, max_tokens: 2200 }, userId);
  return parseCastJson(castContent);
}

async function scanCast(chatId, userId) {
  if (!chatId) { spindle.sendToFrontend({ type: 'vellum_cast_done', ok: false, reason: 'no_active_chat' }, userId); return; }
  if (!hasPerm('generation') || !(spindle.generate && (spindle.generate.raw || spindle.generate.quiet))) { spindle.sendToFrontend({ type: 'vellum_cast_done', ok: false, reason: 'no_generation_permission' }, userId); return; }
  if (!hasPerm('chat_mutation')) { spindle.sendToFrontend({ type: 'vellum_cast_done', ok: false, reason: 'no_chat_mutation_permission' }, userId); return; }
  if (scanningCast.has(chatId)) { spindle.sendToFrontend({ type: 'vellum_cast_done', ok: false, reason: 'busy' }, userId); return; }
  scanningCast.add(chatId);
  let added = 0, enriched = 0;
  try {
    const ch = await loadChronicle(chatId);
    let msgs;
    try { msgs = await readStoredMessages(chatId); }
    catch (e) { if (e && e.permDenied) { spindle.sendToFrontend({ type: 'vellum_cast_done', ok: false, reason: 'no_chat_mutation_permission' }, userId); return; } throw e; }
    if (!msgs || !msgs.length) { spindle.sendToFrontend({ type: 'vellum_cast_done', ok: false, reason: 'no_history' }, userId); return; }
    const nc = await resolveNameContext(chatId, msgs);
    const turns = assistantTurns(msgs);

    let list;
    try { list = await castExtract(turns, nc, userId); }
    catch (e) {
      spindle.log.warn(`[vellum_tracker] cast scan gen failed: ${e?.message || e}`);
      spindle.sendToFrontend({ type: 'vellum_cast_done', ok: false, reason: (e && e.permDenied) ? 'no_generation_permission' : 'error' }, userId); return;
    }
    if (!list) { spindle.sendToFrontend({ type: 'vellum_cast_done', ok: false, reason: 'parse' }, userId); return; }

    const res = applyCastList(ch, list, nc);
    added = res.added; enriched = res.enriched;
    await saveChronicle(chatId, ch);
    broadcastChronicle(chatId, ch);
    spindle.sendToFrontend({ type: 'vellum_cast_done', ok: true, added, enriched, total: Object.keys(ch.cast).length }, userId);
    spindle.log.info(`[vellum_tracker] cast scan: +${added} new, ${enriched} enriched`);
  } catch (err) {
    spindle.log.warn(`[vellum_tracker] scanCast: ${err?.message || err}`);
    spindle.sendToFrontend({ type: 'vellum_cast_done', ok: false, reason: 'error' }, userId);
  } finally {
    scanningCast.delete(chatId);
  }
}

/* ============================================================================
 * MEMORY JOURNAL + KNOWLEDGE/SECRETS scanners (extract from chat history).
 * ========================================================================== */
const scanningMem = new Set();
const scanningKnow = new Set();

// ---- MEMORY JOURNAL: what each character remembers about {{user}} & key moments ----
const MEM_SYS = 'You are a story archivist building each character\u2019s MEMORY JOURNAL from a roleplay transcript \u2014 the moments they would personally remember about the player and about each other. Read the whole excerpt and output STRICT JSON only: {"entries":[{"who":"the exact name of the character who holds this memory","about":"the exact name of who/what it concerns","memory":"one vivid sentence in the character\u2019s perspective of what happened, using real names","kind":"interaction|promise|betrayal|gift|shared|wound|observation","weight":"trivial|minor|significant|defining","sentiment":"positive|negative|neutral|complex","day":<story-day integer if known else null>}]}. Rules: ALWAYS use the real character names given to you \u2014 never write "{{user}}", "User", "{{char}}", or "you"; only record moments a character would actually carry; favor turning points over small talk; one sentence per memory; never invent unsupported events; 6\u201318 entries max, the most meaningful. No prose outside the JSON.';

function parseMemJson(text) {
  let t = String(text || '').replace(/<think[\s\S]*?<\/think>/gi, '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  let obj = null;
  try { obj = JSON.parse(t); } catch (e) { const m = t.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch (e2) { obj = null; } } }
  if (!obj || !Array.isArray(obj.entries)) return null;
  const KINDS = new Set(['interaction', 'promise', 'betrayal', 'gift', 'shared', 'wound', 'observation']);
  const W = new Set(['trivial', 'minor', 'significant', 'defining']);
  const S = new Set(['positive', 'negative', 'neutral', 'complex']);
  return obj.entries.map((e) => ({
    who: String(e.who || '').trim().slice(0, 60),
    about: String(e.about || '').trim().slice(0, 60),
    memory: String(e.memory || '').trim().slice(0, 400),
    kind: KINDS.has(String(e.kind)) ? e.kind : 'interaction',
    weight: W.has(String(e.weight)) ? e.weight : 'minor',
    sentiment: S.has(String(e.sentiment)) ? e.sentiment : 'neutral',
    day: Number.isFinite(e.day) ? e.day : null,
  })).filter((e) => e.who && e.memory);
}

function memSig(e) { return (e.who + '|' + e.memory).toLowerCase().replace(/[^a-z0-9|]+/g, ' ').trim().slice(0, 120); }
// Bucket-scoped signature (journal entries are keyed by character, and stored
// entries don't carry `who`), used for dedupe + tombstones so re-scans/imports
// never duplicate or resurrect a memory.
function mjSig(key, memory) { return (String(key) + '|' + String(memory || '')).toLowerCase().replace(/[^a-z0-9|]+/g, ' ').trim().slice(0, 140); }

async function scanMemJournal(chatId, userId) {
  const done = (ok, extra) => spindle.sendToFrontend(Object.assign({ type: 'vellum_mem_done', ok }, extra || {}), userId);
  if (!chatId) { done(false, { reason: 'no_active_chat' }); return; }
  if (!hasPerm('generation') || !(spindle.generate && (spindle.generate.raw || spindle.generate.quiet))) { done(false, { reason: 'no_generation_permission' }); return; }
  if (!hasPerm('chat_mutation')) { done(false, { reason: 'no_chat_mutation_permission' }); return; }
  if (scanningMem.has(chatId)) { done(false, { reason: 'busy' }); return; }
  scanningMem.add(chatId);
  let added = 0;
  try {
    const ch = await loadChronicle(chatId);
    let msgs; try { msgs = await readStoredMessages(chatId); } catch (e) { if (e && e.permDenied) { done(false, { reason: 'no_chat_mutation_permission' }); return; } throw e; }
    if (!msgs || !msgs.length) { done(false, { reason: 'no_history' }); return; }
    const nc = await resolveNameContext(chatId, msgs);
    const turns = assistantTurns(msgs);
    // Scan the WHOLE transcript in windows so early days are covered too, not
    // just a recency-biased sample. applyMemList dedupes across windows.
    const wins = scanWindows(turns, 14);
    let got = false, permErr = false;
    for (let wi = 0; wi < wins.length; wi++) {
      let list;
      try { list = await memExtract(wins[wi], nc, userId); }
      catch (e) { if (e && e.permDenied) { permErr = true; break; } spindle.log.warn('[vellum_tracker] mem window ' + wi + ': ' + (e && e.message)); continue; }
      if (list) { got = true; added += applyMemList(ch, list, nc); }
      if (wins.length > 1) spindle.sendToFrontend({ type: 'vellum_mem_progress', chunk: wi + 1, chunks: wins.length }, userId);
    }
    if (permErr) { done(false, { reason: 'no_generation_permission' }); return; }
    if (!got) { done(false, { reason: 'parse' }); return; }
    await saveChronicle(chatId, ch);
    broadcastChronicle(chatId, ch);
    done(true, { added, characters: Object.keys(ch.memJournal).length });
    spindle.log.info('[vellum_tracker] memory journal: +' + added + ' entries (' + wins.length + ' windows)');
  } catch (err) {
    spindle.log.warn('[vellum_tracker] scanMemJournal: ' + (err && err.message));
    done(false, { reason: 'error' });
  } finally { scanningMem.delete(chatId); }
}

// Run the memory-journal LLM extraction over a turns array. Returns list or null.
async function memExtract(turns, nc, userId) {
  const excerpt = sampleHistory(turns, { maxTurns: 26, headN: 4, tailN: 10, charBudget: 17000, nameCtx: nc });
  const sys = MEM_SYS + (namesBlock(nc) ? ('\n\n' + namesBlock(nc)).trimEnd() : '');
  const raw = await internalGenerate([{ role: 'system', content: sys }, { role: 'user', content: 'Transcript excerpt:\n\n' + excerpt }], { temperature: 0.2, max_tokens: 2200 }, userId);
  return parseMemJson(raw);
}

// Split a turns array into sequential windows so a scan covers the WHOLE story
// (early days included), not just a recency-biased sample. Returns array of
// turn-slices; a short story yields a single window (behaves like before).
function scanWindows(turns, size) {
  const w = size || 14;
  if (turns.length <= w) return [turns];
  const out = [];
  for (let i = 0; i < turns.length; i += w) out.push(turns.slice(i, i + w));
  return out;
}

// Fold a parsed memory list into the chronicle. Returns count added.
function applyMemList(ch, list, nc) {
  if (!ch.memJournal) ch.memJournal = {};
  const turnNow = ch.turns || 0;
  let added = 0;
  for (const e of list) {
    e.who = canonName(e.who, nc);
    e.about = canonName(e.about, nc);
    e.memory = applyNamesToText(e.memory, nc);
    if (!e.who || !e.memory) continue;
    // resolve the holder to a cast member if possible, else key by name
    const m = findCastMember(ch, e.who);
    const key = m ? m.id : castKey(e.who);
    if (!key) continue;
    if (!ch.memJournal[key]) ch.memJournal[key] = { name: m ? m.name : e.who, entries: [] };
    const arr = ch.memJournal[key].entries;
    const sig = mjSig(key, e.memory);
    if (isTombstoned(ch, 'mem', sig)) continue; // user deleted this — never re-add
    if (arr.some((x) => mjSig(key, x.memory) === sig)) continue; // dedupe
    arr.push({ id: 'mj' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36), about: e.about, memory: e.memory, kind: e.kind, weight: e.weight, sentiment: e.sentiment, day: e.day, turn: turnNow });
    if (arr.length > 40) arr.shift();
    added++;
  }
  return added;
}

// ---- KNOWLEDGE / SECRETS: who knows / believes / suspects what (dramatic irony) ----
const KNOW_SYS = 'You are a continuity analyst mapping the INFORMATION STATE of a roleplay \u2014 the engine of dramatic irony. From the whole transcript, extract (a) notable knowledge each character holds and (b) secrets being kept. Output STRICT JSON only: {"knowledge":[{"who":"exact character name","fact":"the thing, one clause","reliability":"knows|believes|suspects|wrong|unaware","truth":"true|false|unknown","source":"how they got it, brief"}],"secrets":[{"secret":"the concealed thing, one clause","keeper":"exact name of who hides it","from":"exact name(s) of who it is hidden from","method":"lie|omission|misdirection|disguise","exposure":"how it might surface, brief","danger":"minor|major|explosive"}]}. Rules: ALWAYS use the real character names given to you \u2014 never write "{{user}}", "User", "{{char}}", or "you"; focus on facts that create tension or irony (someone believes something false, someone hides something, asymmetric knowledge); reliability=wrong means they believe something untrue; truth is the actual state regardless of belief; never invent \u2014 only what the text supports; up to ~12 knowledge + ~8 secrets, the most dramatically charged. No prose outside the JSON.';

function parseKnowJson(text) {
  let t = String(text || '').replace(/<think[\s\S]*?<\/think>/gi, '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  let obj = null;
  try { obj = JSON.parse(t); } catch (e) { const m = t.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch (e2) { obj = null; } } }
  if (!obj || (!Array.isArray(obj.knowledge) && !Array.isArray(obj.secrets))) return null;
  const REL = new Set(['knows', 'believes', 'suspects', 'wrong', 'unaware']);
  const TR = new Set(['true', 'false', 'unknown']);
  const DG = new Set(['minor', 'major', 'explosive']);
  const knowledge = (Array.isArray(obj.knowledge) ? obj.knowledge : []).map((k) => ({
    who: String(k.who || '').trim().slice(0, 60),
    fact: String(k.fact || '').trim().slice(0, 240),
    reliability: REL.has(String(k.reliability)) ? k.reliability : 'knows',
    truth: TR.has(String(k.truth)) ? k.truth : 'unknown',
    source: String(k.source || '').trim().slice(0, 100),
  })).filter((k) => k.who && k.fact);
  const secrets = (Array.isArray(obj.secrets) ? obj.secrets : []).map((s) => ({
    secret: String(s.secret || '').trim().slice(0, 240),
    keeper: String(s.keeper || '').trim().slice(0, 60),
    from: String(s.from || '').trim().slice(0, 80),
    method: String(s.method || '').trim().slice(0, 30),
    exposure: String(s.exposure || '').trim().slice(0, 160),
    danger: DG.has(String(s.danger)) ? s.danger : 'major',
  })).filter((s) => s.secret);
  return { knowledge, secrets };
}

function knowSig(k) { return (k.who + '|' + k.fact).toLowerCase().replace(/[^a-z0-9|]+/g, ' ').trim().slice(0, 120); }
function secSig(s) { return (s.keeper + '|' + s.secret).toLowerCase().replace(/[^a-z0-9|]+/g, ' ').trim().slice(0, 120); }

async function scanKnowledge(chatId, userId) {
  const done = (ok, extra) => spindle.sendToFrontend(Object.assign({ type: 'vellum_know_done', ok }, extra || {}), userId);
  if (!chatId) { done(false, { reason: 'no_active_chat' }); return; }
  if (!hasPerm('generation') || !(spindle.generate && (spindle.generate.raw || spindle.generate.quiet))) { done(false, { reason: 'no_generation_permission' }); return; }
  if (!hasPerm('chat_mutation')) { done(false, { reason: 'no_chat_mutation_permission' }); return; }
  if (scanningKnow.has(chatId)) { done(false, { reason: 'busy' }); return; }
  scanningKnow.add(chatId);
  let addedK = 0, addedS = 0;
  try {
    const ch = await loadChronicle(chatId);
    let msgs; try { msgs = await readStoredMessages(chatId); } catch (e) { if (e && e.permDenied) { done(false, { reason: 'no_chat_mutation_permission' }); return; } throw e; }
    if (!msgs || !msgs.length) { done(false, { reason: 'no_history' }); return; }
    const nc = await resolveNameContext(chatId, msgs);
    const turns = assistantTurns(msgs);
    // Window the whole transcript so early-day knowledge/secrets are captured
    // too. applyKnowResult dedupes + honors tombstones across windows.
    const wins = scanWindows(turns, 14);
    let got = false, permErr = false;
    for (let wi = 0; wi < wins.length; wi++) {
      let res;
      try { res = await knowExtract(wins[wi], nc, userId); }
      catch (e) { if (e && e.permDenied) { permErr = true; break; } spindle.log.warn('[vellum_tracker] know window ' + wi + ': ' + (e && e.message)); continue; }
      if (res) { got = true; const r = applyKnowResult(ch, res, nc); addedK += r.addedK; addedS += r.addedS; }
      if (wins.length > 1) spindle.sendToFrontend({ type: 'vellum_know_progress', chunk: wi + 1, chunks: wins.length }, userId);
    }
    if (permErr) { done(false, { reason: 'no_generation_permission' }); return; }
    if (!got) { done(false, { reason: 'parse' }); return; }
    await saveChronicle(chatId, ch);
    broadcastChronicle(chatId, ch);
    done(true, { addedK, addedS, totalK: ch.knowledge.length, totalS: ch.secrets.length });
    spindle.log.info('[vellum_tracker] knowledge scan: +' + addedK + ' facts, +' + addedS + ' secrets (' + wins.length + ' windows)');
  } catch (err) {
    spindle.log.warn('[vellum_tracker] scanKnowledge: ' + (err && err.message));
    done(false, { reason: 'error' });
  } finally { scanningKnow.delete(chatId); }
}

// Run the knowledge/secrets LLM extraction over a turns array. Returns result or null.
async function knowExtract(turns, nc, userId) {
  const excerpt = sampleHistory(turns, { maxTurns: 26, headN: 4, tailN: 10, charBudget: 17000, nameCtx: nc });
  const sys = KNOW_SYS + (namesBlock(nc) ? ('\n\n' + namesBlock(nc)).trimEnd() : '');
  const raw = await internalGenerate([{ role: 'system', content: sys }, { role: 'user', content: 'Transcript excerpt:\n\n' + excerpt }], { temperature: 0.2, max_tokens: 2400 }, userId);
  return parseKnowJson(raw);
}

// Fold a parsed knowledge/secrets result into the chronicle. Returns counts.
function applyKnowResult(ch, res, nc) {
  if (!Array.isArray(ch.knowledge)) ch.knowledge = [];
  if (!Array.isArray(ch.secrets)) ch.secrets = [];
  const turnNow = ch.turns || 0;
  let addedK = 0, addedS = 0;
  for (const k of res.knowledge) {
    k.who = canonName(k.who, nc);
    k.fact = applyNamesToText(k.fact, nc);
    if (!k.who || !k.fact) continue;
    const sig = knowSig(k);
    if (isTombstoned(ch, 'know', sig)) continue; // user deleted — don't resurrect
    const ex = ch.knowledge.find((x) => knowSig(x) === sig);
    if (ex) { if (ex.userEdited) continue; ex.reliability = k.reliability; ex.truth = k.truth; if (k.source) ex.source = k.source; ex.lastTurn = turnNow; continue; }
    ch.knowledge.push(Object.assign({ turn: turnNow, lastTurn: turnNow }, k));
    addedK++;
  }
  for (const s of res.secrets) {
    s.keeper = canonName(s.keeper, nc);
    s.from = (s.from || '').split(/\s*(?:,|;|\band\b|\/)\s*/).map((p) => canonName(p, nc)).filter(Boolean).join(', ');
    s.secret = applyNamesToText(s.secret, nc);
    if (s.exposure) s.exposure = applyNamesToText(s.exposure, nc);
    if (!s.secret) continue;
    const sig = secSig(s);
    if (isTombstoned(ch, 'sec', sig)) continue; // user deleted — don't resurrect
    const ex = ch.secrets.find((x) => secSig(x) === sig);
    if (ex) { if (ex.userEdited) continue; ex.danger = s.danger; if (s.exposure) ex.exposure = s.exposure; ex.lastTurn = turnNow; continue; }
    ch.secrets.push(Object.assign({ turn: turnNow, lastTurn: turnNow, revealed: false }, s));
    addedS++;
  }
  if (ch.knowledge.length > 60) ch.knowledge = ch.knowledge.slice(-60);
  if (ch.secrets.length > 40) ch.secrets = ch.secrets.slice(-40);
  return { addedK, addedS };
}




// ---- user-authored & manual cast operations ----
function applyCastEdit(ch, input) {
  const name = String(input.name || '').trim();
  if (!name) return null;
  let m = (input.id && ch.cast[input.id]) ? ch.cast[input.id] : findCastMember(ch, name);
  if (!m) {
    const key = castKey(name);
    if (!key) return null;
    m = ch.cast[key] = { id: key, name, aka: [], source: 'user', status: 'user', age: '', appearance: '', role: '', note: '', firstTurn: ch.turns || 0, lastTurn: ch.turns || 0, firstDay: ch.lastDay, lastDay: ch.lastDay };
  }
  if (!Array.isArray(m.aka)) m.aka = [];
  m.name = name;
  if (input.source === 'user' || m.source === 'user') m.source = 'user';
  if (typeof input.age === 'string') m.age = input.age.slice(0, 40);
  if (typeof input.appearance === 'string') m.appearance = input.appearance.slice(0, 200);
  if (typeof input.role === 'string') m.role = input.role.slice(0, 200);
  if (typeof input.note === 'string') m.note = input.note.slice(0, 300);
  // aka may arrive as an array or a comma/semicolon-separated string.
  if (input.aka !== undefined) {
    const list = Array.isArray(input.aka) ? input.aka : String(input.aka).split(/[,;]/);
    m.aka = list.map((a) => String(a).trim()).filter((a) => a && castKey(a) !== castKey(m.name)).slice(0, 8);
  }
  if (input.source === 'user' && m.status !== 'active') m.status = 'user';
  return m;
}

function broadcastChronicle(chatId, ch, userId) {
  const msg = { type: 'vellum_chronicle', chatId, chronicle: ch, updatedAt: Date.now() };
  if (userId) spindle.sendToFrontend(msg, userId); else spindle.sendToFrontend(msg);
}

// Resolve a usable chat id: trust the one the frontend sent, else ask the host
// for the active chat (fixes the null-chatId failure on a fresh reload).
async function resolveChatId(hinted, userId) {
  if (hinted) return hinted;
  try {
    if (spindle.chats && spindle.chats.getActive) {
      const active = await spindle.chats.getActive(userId);
      if (active && active.id) return active.id;
    }
  } catch (e) {
    if (isPermDenied(e)) spindle.log.warn('[vellum_tracker] chats permission not granted — cannot resolve active chat');
    else spindle.log.warn(`[vellum_tracker] getActive: ${e?.message || e}`);
  }
  return null;
}

// Read the RAW stored message history for a chat. This is the regex-proof path:
// display regex only changes rendering, so stored content keeps <ledger>/[BTS].
async function readStoredMessages(chatId) {
  try {
    if (spindle.chat && spindle.chat.getMessages) {
      const msgs = await spindle.chat.getMessages(chatId);
      if (Array.isArray(msgs)) {
        // Normalize to { role, content }. A message's active swipe content is in
        // `content`; fall back to the active swipe slot when present.
        return msgs.map((m) => {
          let content = typeof m.content === 'string' ? m.content : '';
          if ((!content || !/<ledger>|\[BTS/i.test(content)) && Array.isArray(m.swipes) && m.swipes.length) {
            const slot = typeof m.swipe_id === 'number' ? m.swipes[m.swipe_id] : null;
            const cand = slot || m.swipes.find((s) => /<ledger>|\[BTS/i.test(String(s)));
            if (cand) content = String(cand);
          }
          return { role: m.role, content, name: (m.name || '').trim(), isUser: m.is_user === true || m.role === 'user' };
        });
      }
    }
  } catch (e) {
    if (isPermDenied(e)) { const err = new Error('PERMISSION_DENIED:chat_mutation'); err.permDenied = true; throw err; }
    spindle.log.warn(`[vellum_tracker] readStoredMessages: ${e?.message || e}`);
  }
  return null;
}

// Full re-scan from a messages array (whole visible history).
function rebuildFromMessages(messages) {
  const ch = freshChronicle();
  let turn = 0, lastDay = 1;
  for (const msg of messages || []) {
    if (!msg || msg.role !== 'assistant' || typeof msg.content !== 'string') continue;
    const led = parseLedger(msg.content);
    const bts = parseBts(msg.content);
    if (!led && !bts) continue;
    turn++;
    const day = led ? (extractDay(led.time) || lastDay) : lastDay;
    lastDay = day;
    foldTurn(ch, turn, day, led, bts);
  }
  ch.turns = turn; ch.lastDay = lastDay;
  return ch;
}

// ===== IMPORT CHAT HISTORY =====
// Parse a user-supplied chat export into a normalized [{role, content, name}].
// Supports: Lumiverse/array JSON, SillyTavern JSONL (one msg per line), a
// {messages:[...]} object, and a plain-text "Name: line" transcript fallback.
const importing = new Set();

function normImportRole(m) {
  if (m == null) return null;
  if (typeof m.role === 'string') {
    const r = m.role.toLowerCase();
    if (r === 'user' || r === 'human') return 'user';
    if (r === 'assistant' || r === 'ai' || r === 'char' || r === 'model') return 'assistant';
    if (r === 'system') return 'system';
  }
  if (typeof m.is_user === 'boolean') return m.is_user ? 'user' : 'assistant';
  if (typeof m.isUser === 'boolean') return m.isUser ? 'user' : 'assistant';
  return null;
}

function normImportContent(m) {
  if (typeof m.content === 'string') return m.content;
  if (typeof m.mes === 'string') return m.mes;             // SillyTavern
  if (typeof m.text === 'string') return m.text;
  if (Array.isArray(m.swipes) && m.swipes.length) {
    const slot = typeof m.swipe_id === 'number' ? m.swipes[m.swipe_id] : m.swipes[0];
    if (typeof slot === 'string') return slot;
  }
  if (Array.isArray(m.content)) {
    return m.content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
  }
  return '';
}

function normImportMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const role = normImportRole(m);
  const content = String(normImportContent(m) || '');
  if (!role || !content.trim()) return null;
  const name = String(m.name || m.author || m.speaker || '').trim();
  return { role, content, name, isUser: role === 'user' };
}

// Plain-text transcript fallback. Lines like "Alice: hello" start a new turn;
// continuation lines append to the current speaker. A blank speaker name maps
// to assistant. userHint marks which name is the player so roles are right.
function parseTextTranscript(text, userHint) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let cur = null;
  const uh = (userHint || '').trim().toLowerCase();
  const speakerRe = /^\s*([A-Za-z0-9 ._'\-]{1,40}?)\s*:\s+(.*)$/;
  const flush = () => { if (cur && cur.content.trim()) out.push(cur); cur = null; };
  for (const ln of lines) {
    const m = ln.match(speakerRe);
    if (m) {
      flush();
      const nm = m[1].trim();
      const role = (uh && nm.toLowerCase() === uh) ? 'user' : 'assistant';
      cur = { role, content: m[2], name: nm, isUser: role === 'user' };
    } else if (cur) {
      cur.content += '\n' + ln;
    }
  }
  flush();
  return out;
}

// Top-level: turn raw file text into a normalized transcript array.
function parseImportedTranscript(text, opts) {
  const o = opts || {};
  const raw = String(text || '').trim();
  if (!raw) return [];
  // 1) Try whole-file JSON (array, {messages:[]}, or {chat:[]}).
  try {
    const j = JSON.parse(raw);
    let arr = null;
    if (Array.isArray(j)) arr = j;
    else if (j && Array.isArray(j.messages)) arr = j.messages;
    else if (j && Array.isArray(j.chat)) arr = j.chat;
    else if (j && Array.isArray(j.history)) arr = j.history;
    if (arr) { const mapped = arr.map(normImportMessage).filter(Boolean); if (mapped.length) return mapped; }
  } catch (e) { /* not whole-file JSON */ }
  // 2) Try JSONL (SillyTavern: one JSON object per line; first line may be metadata).
  if (/\n/.test(raw) && /^\s*\{/.test(raw)) {
    const objs = [];
    let any = false;
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      try { const obj = JSON.parse(t); any = true; const nm = normImportMessage(obj); if (nm) objs.push(nm); } catch (e) { /* skip non-JSON line */ }
    }
    if (any && objs.length) return objs;
  }
  // 3) Plain-text transcript fallback.
  return parseTextTranscript(raw, o.userHint);
}

// Orchestrate a full import: fold ledgers/BTS, then run cast+memory+knowledge
// extractors over the imported transcript with proper name context.
async function importHistory(chatId, rawText, userId) {
  const done = (ok, extra) => spindle.sendToFrontend(Object.assign({ type: 'vellum_import_done', ok }, extra || {}), userId);
  if (!chatId) { done(false, { reason: 'no_active_chat' }); return; }
  if (!hasPerm('chat_mutation')) { done(false, { reason: 'no_chat_mutation_permission' }); return; }
  if (importing.has(chatId)) { done(false, { reason: 'busy' }); return; }
  importing.add(chatId);
  try {
    spindle.sendToFrontend({ type: 'vellum_import_progress', stage: 'parsing' }, userId);
    const msgs = parseImportedTranscript(rawText, {});
    if (!msgs.length) { done(false, { reason: 'empty' }); return; }

    const ch = await loadChronicle(chatId);
    // Resolve names from the chat first, then enrich with any names seen in the
    // imported transcript (so a foreign export still gets sensible labels).
    const nc = await resolveNameContext(chatId, msgs);

    // 1) Fold any ledger/BTS blocks present in the import into the structured tracker.
    const scanned = rebuildFromMessages(msgs);
    let merged = ch;
    if (scanned && scanned.turns > 0) { merged = mergeEnrich(ch, scanned); merged._sig = ch._sig; }

    const turns = assistantTurns(msgs);
    const useGen = hasPerm('generation') && spindle.generate && (spindle.generate.raw || spindle.generate.quiet);
    let castN = 0, memN = 0, knowK = 0, knowS = 0, genFailed = false;
    if (useGen && turns.length) {
      // Scan the WHOLE imported transcript: split it into sequential windows and
      // run every extractor over each one. No cap — every turn is covered. The
      // apply* folders dedupe, so overlapping/foreign data merges cleanly.
      const WINDOW = 24;          // turns per extraction window
      const chunks = [];
      for (let i = 0; i < turns.length; i += WINDOW) chunks.push(turns.slice(i, i + WINDOW));
      const total = chunks.length;
      for (let ci = 0; ci < chunks.length; ci++) {
        const part = chunks[ci];
        const prog = (stage) => spindle.sendToFrontend({ type: 'vellum_import_progress', stage, chunk: ci + 1, chunks: total }, userId);
        try {
          prog('cast');
          const cl = await castExtract(part, nc, userId);
          if (cl) { const r = applyCastList(merged, cl, nc); castN += r.added; }
        } catch (e) { genFailed = genFailed || !!(e && e.permDenied); spindle.log.warn('[vellum_tracker] import cast: ' + (e && e.message)); if (e && e.permDenied) break; }
        try {
          prog('memory');
          const ml = await memExtract(part, nc, userId);
          if (ml) memN += applyMemList(merged, ml, nc);
        } catch (e) { spindle.log.warn('[vellum_tracker] import memory: ' + (e && e.message)); }
        try {
          prog('knowledge');
          const kr = await knowExtract(part, nc, userId);
          if (kr) { const r = applyKnowResult(merged, kr, nc); knowK += r.addedK; knowS += r.addedS; }
        } catch (e) { spindle.log.warn('[vellum_tracker] import knowledge: ' + (e && e.message)); }
        // Persist incrementally so a long import survives an interruption.
        if (ci % 3 === 2) { try { await saveChronicle(chatId, merged); broadcastChronicle(chatId, merged, userId); } catch (e) {} }
      }
    }

    await saveChronicle(chatId, merged);
    broadcastChronicle(chatId, merged, userId);
    done(true, {
      messages: msgs.length,
      foldedTurns: scanned ? scanned.turns : 0,
      cast: castN, memories: memN, knowledge: knowK, secrets: knowS,
      generated: !!useGen, genFailed,
    });
    spindle.log.info('[vellum_tracker] import: ' + msgs.length + ' msgs, +' + castN + ' cast, +' + memN + ' mem, +' + knowK + 'k/' + knowS + 's');
  } catch (err) {
    spindle.log.warn('[vellum_tracker] importHistory: ' + (err && err.message));
    done(false, { reason: 'error' });
  } finally { importing.delete(chatId); }
}

// Wipe ALL tracked data for a chat back to a fresh chronicle (start over).
async function clearAllData(chatId, userId) {
  const done = (ok, extra) => spindle.sendToFrontend(Object.assign({ type: 'vellum_cleared', ok }, extra || {}), userId);
  if (!chatId) { done(false, { reason: 'no_active_chat' }); return; }
  try {
    const fresh = freshChronicle();
    chronicleByChat.set(chatId, fresh);
    await saveChronicle(chatId, fresh);
    // Drop cached live state + injection so the UI fully resets.
    lastStateByChat.delete(chatId);
    lastInjectionByChat.delete(chatId);
    deepCacheByChat.delete(chatId);
    _nameCtxCache.delete(chatId);
    try {
      await spindle.variables.chat.set(chatId, 'vellum_state_json', '');
      await spindle.variables.chat.set(chatId, 'vellum_injection_json', '');
    } catch (e) { /* best effort */ }
    broadcastChronicle(chatId, fresh, userId);
    spindle.sendToFrontend({ type: 'vellum_tracker_empty' }, userId);
    done(true, {});
    spindle.log.info('[vellum_tracker] cleared all data for chat ' + chatId);
  } catch (err) {
    spindle.log.warn('[vellum_tracker] clearAllData: ' + (err && err.message));
    done(false, { reason: 'error' });
  }
}

// Union-enrich: add anything from `extra` that `base` is missing; never remove.
function mergeEnrich(base, extra) {
  for (const k of Object.keys(extra.arcs)) if (!base.arcs[k]) base.arcs[k] = extra.arcs[k];
  for (const k of Object.keys(extra.threads)) if (!base.threads[k]) base.threads[k] = extra.threads[k];
  const seenE = new Set(base.events.map((e) => e.day + '|' + e.text));
  for (const e of extra.events) if (!seenE.has(e.day + '|' + e.text)) base.events.push(e);
  const seenS = new Set(base.shifts.map((s) => s.day + '|' + s.text));
  for (const s of extra.shifts) if (!seenS.has(s.day + '|' + s.text)) base.shifts.push(s);
  base.events.sort((a, b) => (a.turn || 0) - (b.turn || 0));
  base.shifts.sort((a, b) => (a.turn || 0) - (b.turn || 0));
  if (base.events.length > 60) base.events = base.events.slice(-60);
  if (base.shifts.length > 50) base.shifts = base.shifts.slice(-50);
  base.turns = Math.max(base.turns, extra.turns);
  // Preserve auto-summary memories and the coverage marker (a rescan rebuilds the
  // structured tracker from raw turns, but must never discard distilled memories).
  if (Array.isArray(extra.memories) && extra.memories.length) {
    base.memories = (base.memories && base.memories.length) ? base.memories : extra.memories;
  }
  if (!base.covered && extra.covered) base.covered = extra.covered;
  return base;
}


/* ---------- interceptor: lean the older context + inject scene-relevant recall ---------- */
let lastInterceptedMessages = null;
const lastInjectionByChat = new Map();
let _interceptorFiredOnce = false;
const vellumInterceptor = async (messages, context) => {
  if (!_interceptorFiredOnce) {
    _interceptorFiredOnce = true;
    const cid = context && (context.chatId || context.chat_id);
    try { spindle.toast.info('VELLUM interceptor active' + (cid ? '' : ' (no chatId in context!)'), { title: 'VELLUM Tracker' }); } catch (e) {}
  }
  lastInterceptedMessages = messages; // cache full history for on-demand chronicle rebuilds
  const depthByIndex = new Map();
  let depth = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      depth++;
      depthByIndex.set(i, depth);
    }
  }
  let out = messages.map((msg, idx) => {
    const d = depthByIndex.get(idx);
    if (!d || typeof msg.content !== 'string') return msg;
    const filtered = applyDepthFilters(msg.content, d);
    return filtered === msg.content ? msg : { ...msg, content: filtered };
  });

  // Scene-relevant chronicle recall (budgeted, retrieval-gated — never a full dump).
  let injectedContent = '';
  try {
    const chatId = context && (context.chatId || context.chat_id);
    if (!chatId) {
      spindle.log.warn('[vellum_tracker] interceptor: no context.chatId — cannot inject');
    } else {
      const ch = await loadChronicle(chatId);
      if (chronicleHasContent(ch)) {
        const query = queryFromMessages(out, RECALL.queryMessages);
        const { arcIds, threadIds } = pinnedIdSets(ch);
        const sel = selectRelevant(ch, query, arcIds, threadIds, (function () { const ap = deepApproved(chatId, ch); return ap ? { approved: ap } : null; })());
        const lines = sel.lines;
        const cast = buildCastDigest(ch, query);
        const castBlock = cast.text;
        const knowBlock = buildKnowledgeDigest(ch, query);
        let content = '';
        if (castBlock) content += '[CAST — established characters, for continuity. Keep ages, looks, and roles consistent; do not contradict these.]\n' + castBlock + '\n\n';
        if (knowBlock) content += '[KNOWLEDGE & SECRETS — the information state, for dramatic irony. Honor exactly who knows, believes, suspects, or is ignorant of what; never let a character act on knowledge they do not have, and never casually expose a secret unless the scene earns it.]\n' + knowBlock + '\n\n';
        if (lines.length) content += '[CHRONICLE RECALL — entries relevant to the current scene, retrieved from long-term memory. Honor them as established history; do not recite them in prose.]\n' + lines.join('\n');
        content = content.trim();
        if (content) {
          injectedContent = content;
          lastInjectionByChat.set(chatId, {
            at: Date.now(),
            cast: castBlock || '',
            castCount: castBlock ? castBlock.split('\n').filter(Boolean).length : 0,
            castTrace: cast.trace || [],
            recall: lines.slice(),
            recallTrace: sel.trace || [],
            chars: content.length,
          });
          try { await spindle.variables.chat.set(chatId, 'vellum_injection_json', JSON.stringify(lastInjectionByChat.get(chatId)).slice(0, 40000)); } catch (e3) {}
          spindle.log.info(`[vellum_tracker] injected ${content.length} chars (${lines.length} recall, cast=${!!castBlock})`);
        } else {
          lastInjectionByChat.set(chatId, { at: Date.now(), cast: '', castCount: 0, recall: [], chars: 0 });
          spindle.log.info('[vellum_tracker] nothing to inject this turn (no cast/recall matched)');
        }
      } else {
        spindle.log.info('[vellum_tracker] chronicle empty — nothing to inject yet');
      }
    }
  } catch (err) {
    spindle.log.warn(`[vellum_tracker] recall inject: ${err?.message || err}`);
  }

  // Inject at index 0 as a system message + a Prompt Breakdown entry (the exact
  // shape LoreRecall uses, so it shows as its own attributed block in dry-run /
  // live breakdown / saved snapshots).
  if (injectedContent) {
    return {
      messages: [{ role: 'system', content: injectedContent }, ...out],
      breakdown: [{ messageIndex: 0, name: 'VELLUM Recall' }],
    };
  }
  return out;
};

/* ---------- interceptor registration (re-registers when permission is granted) ----------
 * registerInterceptor only takes effect if the `interceptor` permission is
 * granted AT THE MOMENT of the call. If the user grants it later, the original
 * load-time registration was already dropped by the host — so we re-register on
 * the permission_changed signal. */
let _interceptorRegistered = false;
function ensureInterceptor(reason) {
  try {
    spindle.registerInterceptor(vellumInterceptor, 120);
    _interceptorRegistered = true;
    spindle.log.info(`[vellum_tracker] interceptor registered (${reason})`);
  } catch (e) {
    spindle.log.warn(`[vellum_tracker] interceptor register failed (${reason}): ${e?.message || e}`);
  }
}
ensureInterceptor('load');
try {
  if (spindle.permissions && spindle.permissions.onChanged) {
    spindle.permissions.onChanged((detail) => {
      const granted = detail && (detail.granted || (Array.isArray(detail.allGranted) && detail.allGranted.includes('interceptor')));
      if (granted) ensureInterceptor('permission_changed');
    });
  }
} catch (e) { /* onChanged unavailable */ }


/* ---------- shared handler ---------- */
const lastStateByChat = new Map();

async function handle(chatId, content, userId) {
  if (!content || !chatId) return;
  const parsed = parseLedger(content);
  const btsRaw = parseBts(content);
  if (!parsed && !btsRaw) return;
  const ledger = parsed || { raw: '', time: '', location: '', weather: '', present: '', thoughts: '', arcs: '', offscreen: '', sceneTension: '', bondTension: '' };
  lastStateByChat.set(chatId, { ledger, bts: btsRaw, updatedAt: Date.now() });
  await syncChatVars(chatId, ledger, btsRaw);
  broadcast(chatId, ledger, btsRaw);

  // Fold this turn into the long-term chronicle (only when the state is new).
  try {
    const ch = await loadChronicle(chatId);
    const sig = sigOf(ledger, btsRaw);
    if (sig !== ch._sig) {
      ch._sig = sig;
      ch.turns = (ch.turns || 0) + 1;
      const day = extractDay(ledger.time) || ch.lastDay || 1;
      foldTurn(ch, ch.turns, day, ledger, btsRaw);
      await saveChronicle(chatId, ch);
      broadcastChronicle(chatId, ch);
      // After the live state is saved, opportunistically archive older turns in
      // the background (non-blocking — the user's generation already finished).
      if (userId) setTimeout(() => { maybeSummarize(chatId, userId); }, 1500);
      if (userId && deepEnabled(ch)) setTimeout(async () => {
        try { const msgs = await readStoredMessages(chatId); if (msgs && msgs.length) await runDeepRecall(chatId, msgs, userId); } catch (e) {}
      }, 1800);
    }
  } catch (err) {
    spindle.log.warn(`[vellum_tracker] chronicle fold: ${err?.message || err}`);
  }
}

/* ---------- events ---------- */
spindle.on('GENERATION_ENDED', async (payload) => {
  try {
    // The worker is provably alive here (this event fired), and by now any
    // late-granted `interceptor` permission has propagated. Re-assert the
    // interceptor registration so the NEXT turn's pipeline includes it, even if
    // the load-time / onChanged registrations were dropped by the host.
    ensureInterceptor('generation_ended');
    const chatId = payload?.chatId || payload?.chat_id;
    const content = payload?.content || payload?.message?.content || '';
    await handle(chatId, content, payload?.userId || payload?.user_id);
  } catch (err) {
    spindle.log.warn(`[vellum_tracker] GENERATION_ENDED: ${err?.message || err}`);
  }
});

spindle.on('MESSAGE_EDITED', async (payload) => {
  try {
    const msg = payload?.message;
    if (!msg || msg.is_user) return;
    const chatId = payload?.chatId || payload?.chat_id;
    await handle(chatId, msg.content || '', payload?.userId || payload?.user_id);
  } catch (err) {
    spindle.log.warn(`[vellum_tracker] MESSAGE_EDITED: ${err?.message || err}`);
  }
});

/* ---------- frontend messages ----------
 * get_state : re-broadcast the cached state for a chat (used when the window opens).
 * parse_content : parse explicit content the frontend supplies (fallback path).
 */
spindle.onFrontendMessage(async (payload, userId) => {
  try {
    if (payload?.type === 'get_state') {
      const chatId = await resolveChatId(payload.chatId, userId);
      let state = chatId && lastStateByChat.get(chatId);
      // Cache miss (worker was idle-unloaded) — restore from the persisted blob.
      if (!state && chatId) {
        try {
          const raw = spindle.variables.chat.get ? await spindle.variables.chat.get(chatId, 'vellum_state_json') : null;
          if (raw) {
            const p = JSON.parse(raw);
            if (p && (p.ledger || p.bts)) { state = p; lastStateByChat.set(chatId, p); }
          }
        } catch (e) { /* fall through to empty */ }
      }
      if (state) {
        spindle.sendToFrontend({ type: 'vellum_tracker_update', chatId, ledger: state.ledger, bts: state.bts, updatedAt: state.updatedAt }, userId);
      } else {
        spindle.sendToFrontend({ type: 'vellum_tracker_empty' }, userId);
      }
      return;
    }
    if (payload?.type === 'parse_content') {
      await handle(payload.chatId, payload.content || '', userId);
      spindle.sendToFrontend({ type: 'vellum_tracker_ack' }, userId);
      return;
    }
    if (payload?.type === 'check_perms') {
      let granted = ['chats', 'chat_mutation', 'generation'].filter((p) => hasPerm(p));
      try {
        if (spindle.permissions && spindle.permissions.getGranted) {
          const g = await spindle.permissions.getGranted();
          if (Array.isArray(g)) granted = ['chats', 'chat_mutation', 'generation'].filter((p) => g.includes(p));
        }
      } catch (e) { /* use sync result */ }
      spindle.sendToFrontend({ type: 'vellum_perms', granted }, userId);
      return;
    }
    if (payload?.type === 'get_chronicle') {
      const chatId = await resolveChatId(payload.chatId, userId);
      if (!chatId) { spindle.sendToFrontend({ type: 'vellum_chronicle_empty' }, userId); return; }
      const ch = await loadChronicle(chatId);
      broadcastChronicle(chatId, ch, userId);
      return;
    }
    if (payload?.type === 'get_injection') {
      const chatId = await resolveChatId(payload.chatId, userId);
      let inj = chatId && lastInjectionByChat.get(chatId);
      if (!inj && chatId) {
        try {
          const raw = spindle.variables.chat.get ? await spindle.variables.chat.get(chatId, 'vellum_injection_json') : null;
          if (raw) { const p = JSON.parse(raw); if (p) { inj = p; lastInjectionByChat.set(chatId, p); } }
        } catch (e) { /* none */ }
      }
      spindle.sendToFrontend({ type: 'vellum_injection', injection: inj || null }, userId);
      return;
    }
    if (payload?.type === 'set_deep_recall') {
      const chatId = await resolveChatId(payload.chatId, userId);
      if (!chatId) return;
      const ch = await loadChronicle(chatId);
      ch.deepRecall = !!payload.enabled;
      if (!ch.deepRecall) deepCacheByChat.delete(chatId);
      await saveChronicle(chatId, ch);
      spindle.sendToFrontend({ type: 'vellum_deep_recall', enabled: ch.deepRecall }, userId);
      if (ch.deepRecall && userId) setTimeout(async () => { try { const msgs = await readStoredMessages(chatId); if (msgs && msgs.length) await runDeepRecall(chatId, msgs, userId); } catch (e) {} }, 200);
      return;
    }
    if (payload?.type === 'get_deep_recall') {
      const chatId = await resolveChatId(payload.chatId, userId);
      const ch = chatId ? await loadChronicle(chatId) : null;
      spindle.sendToFrontend({ type: 'vellum_deep_recall', enabled: !!(ch && ch.deepRecall) }, userId);
      return;
    }
    if (payload?.type === 'summarize_all') {
      const chatId = await resolveChatId(payload.chatId, userId);
      await summarizeAll(chatId, userId);
      return;
    }
    if (payload?.type === 'vellum_setup_error') {
      spindle.log.warn('[vellum_tracker] FRONTEND setup() error: ' + (payload.error || 'unknown'));
      return;
    }
    if (payload?.type === 'scan_cast') {
      const chatId = await resolveChatId(payload.chatId, userId);
      await scanCast(chatId, userId);
      return;
    }
    if (payload?.type === 'scan_memjournal') {
      const chatId = await resolveChatId(payload.chatId, userId);
      await scanMemJournal(chatId, userId);
      return;
    }
    if (payload?.type === 'scan_knowledge') {
      const chatId = await resolveChatId(payload.chatId, userId);
      await scanKnowledge(chatId, userId);
      return;
    }
    if (payload?.type === 'mem_delete') {
      const chatId = await resolveChatId(payload.chatId, userId);
      if (!chatId) return;
      const ch = await loadChronicle(chatId);
      if (payload.charKey && ch.memJournal && ch.memJournal[payload.charKey]) {
        const bucket = ch.memJournal[payload.charKey];
        if (payload.all) {
          (bucket.entries || []).forEach((e) => addTombstone(ch, 'mem', mjSig(payload.charKey, e.memory)));
          delete ch.memJournal[payload.charKey];
        } else if (typeof payload.id === 'string' && payload.id) {
          // Stable-id delete (preferred): immune to sort/filter index drift.
          const idx = bucket.entries.findIndex((e) => e.id === payload.id);
          if (idx >= 0) { addTombstone(ch, 'mem', mjSig(payload.charKey, bucket.entries[idx].memory)); bucket.entries.splice(idx, 1); }
        } else if (typeof payload.index === 'number') {
          // Legacy fallback for entries saved before ids existed.
          const e = bucket.entries[payload.index];
          if (e) addTombstone(ch, 'mem', mjSig(payload.charKey, e.memory));
          bucket.entries.splice(payload.index, 1);
        }
        if (ch.memJournal[payload.charKey] && !bucket.entries.length) delete ch.memJournal[payload.charKey];
        await saveChronicle(chatId, ch); broadcastChronicle(chatId, ch, userId);
      }
      return;
    }
    if (payload?.type === 'knowledge_delete') {
      const chatId = await resolveChatId(payload.chatId, userId);
      if (!chatId) return;
      const ch = await loadChronicle(chatId);
      if (payload.kind === 'knowledge' && Array.isArray(ch.knowledge) && typeof payload.index === 'number') {
        const e = ch.knowledge[payload.index];
        if (e) { addTombstone(ch, 'know', knowSig(e)); ch.knowledge.splice(payload.index, 1); }
      } else if (payload.kind === 'secret' && Array.isArray(ch.secrets) && typeof payload.index === 'number') {
        const e = ch.secrets[payload.index];
        if (e) { addTombstone(ch, 'sec', secSig(e)); ch.secrets.splice(payload.index, 1); }
      } else if (payload.kind === 'clear_knowledge') {
        (ch.knowledge || []).forEach((e) => addTombstone(ch, 'know', knowSig(e)));
        ch.knowledge = [];
      } else if (payload.kind === 'clear_secrets') {
        (ch.secrets || []).forEach((e) => addTombstone(ch, 'sec', secSig(e)));
        ch.secrets = [];
      }
      await saveChronicle(chatId, ch); broadcastChronicle(chatId, ch, userId);
      return;
    }
    if (payload?.type === 'cast_add' || payload?.type === 'cast_update') {
      const chatId = await resolveChatId(payload.chatId, userId);
      if (!chatId) { spindle.sendToFrontend({ type: 'vellum_cast_done', ok: false, reason: 'no_active_chat' }, userId); return; }
      const ch = await loadChronicle(chatId);
      const m = applyCastEdit(ch, Object.assign({ source: payload.type === 'cast_add' ? 'user' : undefined }, payload.character || {}));
      if (m) { await saveChronicle(chatId, ch); broadcastChronicle(chatId, ch, userId); }
      else spindle.sendToFrontend({ type: 'vellum_cast_done', ok: false, reason: 'invalid' }, userId);
      return;
    }
    if (payload?.type === 'cast_delete') {
      const chatId = await resolveChatId(payload.chatId, userId);
      if (!chatId) return;
      const ch = await loadChronicle(chatId);
      if (payload.id && ch.cast[payload.id]) { delete ch.cast[payload.id]; await saveChronicle(chatId, ch); broadcastChronicle(chatId, ch, userId); }
      return;
    }
    if (payload?.type === 'memory_edit') {
      const chatId = await resolveChatId(payload.chatId, userId);
      if (!chatId) return;
      const ch = await loadChronicle(chatId);
      if (payload.id && Array.isArray(ch.memories)) {
        const m = ch.memories.find((x) => x.id === payload.id);
        if (m) {
          if (typeof payload.text === 'string') m.text = payload.text.trim().slice(0, 2000);
          if (payload.keywords !== undefined) {
            const list = Array.isArray(payload.keywords) ? payload.keywords : String(payload.keywords).split(/[,;]/);
            m.keywords = list.map((k) => String(k).toLowerCase().trim()).filter(Boolean).slice(0, 14);
          }
          m.edited = true;
          await saveChronicle(chatId, ch);
          broadcastChronicle(chatId, ch, userId);
        }
      }
      return;
    }
    if (payload?.type === 'memory_delete') {
      const chatId = await resolveChatId(payload.chatId, userId);
      if (!chatId) return;
      const ch = await loadChronicle(chatId);
      if (payload.id && Array.isArray(ch.memories)) {
        const target = ch.memories.find((m) => m.id === payload.id);
        const before = ch.memories.length;
        if (target && typeof target.fromTurn === 'number') {
          // Coverage is a single contiguous watermark, so re-opening a range means
          // rewinding to just before this memory AND dropping any later memories
          // (they'd otherwise overlap when re-summarized). They regenerate on the
          // next "Summarize past turns" run, in order, with no duplicates.
          const reopenTo = Math.max(0, target.fromTurn - 1);
          ch.memories = ch.memories.filter((m) => (m.fromTurn || 0) < target.fromTurn);
          if (reopenTo < (ch.covered || 0)) ch.covered = reopenTo;
        } else {
          ch.memories = ch.memories.filter((m) => m.id !== payload.id);
        }
        if (ch.memories.length !== before) {
          await saveChronicle(chatId, ch);
          broadcastChronicle(chatId, ch, userId);
        }
      }
      return;
    }
    if (payload?.type === 'memory_clear') {
      const chatId = await resolveChatId(payload.chatId, userId);
      if (!chatId) return;
      const ch = await loadChronicle(chatId);
      ch.memories = [];
      ch.covered = 0; // reset coverage so the cleared range can be re-summarized
      await saveChronicle(chatId, ch);
      broadcastChronicle(chatId, ch, userId);
      return;
    }
    if (payload?.type === 'cast_promote') {
      const chatId = await resolveChatId(payload.chatId, userId);
      if (!chatId) return;
      const ch = await loadChronicle(chatId);
      const c = payload.id && ch.cast[payload.id];
      if (c) {
        const to = payload.to; // 'present' | 'active' | 'mentioned' | 'added'
        if (to === 'added') { c.source = 'user'; c.appeared = false; c.status = 'user'; }
        else { c.appeared = true; c.status = (to === 'mentioned') ? 'mentioned' : 'active'; if (to === 'present') c.lastTurn = ch.turns || c.lastTurn; }
        await saveChronicle(chatId, ch); broadcastChronicle(chatId, ch, userId);
      }
      return;
    }
    if (payload?.type === 'import_history') {
      const chatId = await resolveChatId(payload.chatId, userId);
      await importHistory(chatId, payload.text || '', userId);
      return;
    }
    if (payload?.type === 'clear_all') {
      const chatId = await resolveChatId(payload.chatId, userId);
      await clearAllData(chatId, userId);
      return;
    }
    if (payload?.type === 'rebuild_chronicle') {
      const chatId = await resolveChatId(payload.chatId, userId);
      if (!chatId) {
        spindle.sendToFrontend({ type: 'vellum_chronicle_rebuilt', scanned: false, reason: 'no_active_chat' }, userId);
        return;
      }
      // Preferred source: the RAW stored message history. Display regex only
      // changes rendering, never storage — so the <ledger>/[BTS] blocks are
      // intact here even when hidden from the chat. Fall back to the cached
      // interceptor array, then any messages the frontend supplied.
      let rawMessages = await readStoredMessages(chatId);
      if (!rawMessages || !rawMessages.length) rawMessages = lastInterceptedMessages;
      if (!rawMessages || !rawMessages.length) rawMessages = payload.messages;

      let scanned = null;
      let scannedTurns = 0;
      if (rawMessages && rawMessages.length) {
        scanned = rebuildFromMessages(rawMessages);
        scannedTurns = scanned.turns;
      }
      const base = await loadChronicle(chatId);
      let merged;
      if (scanned && scannedTurns > 0) {
        // Rebuild wins on coverage: start from the full scan, then fold in any
        // live history depth the incremental chronicle already accumulated.
        merged = mergeEnrich(scanned, base);
        merged._sig = base._sig;
      } else {
        merged = base;
      }
      await saveChronicle(chatId, merged);
      broadcastChronicle(chatId, merged, userId);
      spindle.sendToFrontend({
        type: 'vellum_chronicle_rebuilt',
        scanned: !!(scanned && scannedTurns > 0),
        turns: scannedTurns,
        source: rawMessages === lastInterceptedMessages ? 'context-cache' : 'stored-history',
      }, userId);
      return;
    }
  } catch (err) {
    spindle.log.warn(`[vellum_tracker] frontend msg: ${err?.message || err}`);
  }
});

spindle.log.info('VELLUM Tracker loaded — floating ledger + backstage sync active.');
