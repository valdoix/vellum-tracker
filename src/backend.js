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
// Operator-scoped extensions REQUIRE a userId on connections.list/generate.
// Several internal call paths (interceptor, background timers) don't naturally
// carry one, so we remember the last userId seen from any frontend message,
// host event, or generation and fall back to it.
let _lastUserId = null;
function rememberUser(u) { if (u) _lastUserId = u; }
async function resolveConnection(userId) {
  const uid = userId || _lastUserId;
  if (_connCache.conn && Date.now() - _connCache.at < 30000) return _connCache.conn;
  try {
    if (spindle.connections && spindle.connections.list) {
      const list = await spindle.connections.list(uid);
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
  const uid = userId || _lastUserId;
  rememberUser(userId);
  const conn = await resolveConnection(uid);
  const req = { messages, parameters: params || {} };
  if (uid) req.userId = uid;
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

/* ---------- retrieval-query hygiene (#6) ----------
 * Strip preset jailbreak / narrative-protocol boilerplate from a message before
 * it feeds the recall scorer, so system scaffolding doesn't dominate the query.
 * Patterns are matched case-insensitively; the message is truncated at the first
 * hit (the boilerplate is almost always a trailing block). Mirrors LoreRecall's
 * sanitizeRetrievalMessage idea. */
const QUERY_CUT_PATTERNS = [
  /\bimportant\s*(?:note|reminder)\s*:/i,
  /\byou\s+are\s+(?:forbidden|required|now)\b/i,
  /\bnever\s+break\s+character\b/i,
  /\b(?:system|assistant)\s+(?:prompt|instructions?)\b/i,
  /\[\s*(?:narrative|emotional|strict|system|ooc)\b/i,
  /<\s*(?:system|instructions?|guidelines?)\b/i,
  /\bthe\s+human\s+never\s+sees\b/i,
  /\bprivate\s+workspace\b/i,
  /\btreat\s+.{0,30}\bas\s+a\s+black\s+box\b/i,
  /\bactive\s+personality\s+matrix\b/i,
  /\bweave\s+planning\b/i,
];
const QUERY_MSG_LIMIT = 800; // per-message char cap before scoring

function sanitizeQueryText(s) {
  let t = String(s || '');
  if (!t) return '';
  let cut = t.length;
  for (const re of QUERY_CUT_PATTERNS) {
    const m = t.match(re);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  if (cut < t.length) t = t.slice(0, cut);
  t = t.trim();
  if (t.length > QUERY_MSG_LIMIT) t = t.slice(0, QUERY_MSG_LIMIT);
  return t;
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

// Build the present-character RAPPORT strip from the relations system: for each
// character currently on stage, their affection/trust toward the player ({{user}}),
// derived (not model-guessed). Replaces the old single [bond] meter.
// `userName` is the resolved {{user}} persona name (authoritative).
function computeRapport(ch, userName) {
  if (!ch || !Array.isArray(ch.relations) || !ch.relations.length) return [];
  const presentIds = new Set(ch.presentIds || []);
  if (!presentIds.size) return [];
  const userKey = userName ? castKey(userName) : null;
  if (!userKey) return []; // can't identify the player → don't guess
  // The player's cast id = the card matching the {{user}} persona name. Try the
  // strongest signal first (exact key / alias), then a distinctive-token match
  // (so short "Daeron" matches "Daeron Targaryen") — but a SHARED SURNAME alone
  // (Targaryen, Lannister) must NOT match, or the player gets confused with kin.
  const utoks = (String(userName).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  const KIN = kinTokens(ch);
  const distinctive = utoks.filter((t) => !KIN.has(t));
  const exactMatch = (c) => castKey(c.name) === userKey || (c.aka || []).some((a) => castKey(a) === userKey);
  const tokenMatch = (c) => { const ct = (String(c.name).toLowerCase().match(/[a-z0-9]{3,}/g) || []); return distinctive.some((t) => ct.includes(t)); };
  const nameMatchesUser = (c) => exactMatch(c) || tokenMatch(c);
  let userId = null;
  // prefer an exact match across all cast first
  for (const k of Object.keys(ch.cast || {})) { if (exactMatch(ch.cast[k])) { userId = ch.cast[k].id; break; } }
  if (!userId) { for (const k of Object.keys(ch.cast || {})) { if (tokenMatch(ch.cast[k])) { userId = ch.cast[k].id; break; } } }
  const userMatch = (id) => { const c = ch.cast[id]; return c && nameMatchesUser(c); };
  const out = [];
  const seen = new Set();
  for (const r of ch.relations) {
    let other = null;
    if (userId && r.a === userId && presentIds.has(r.b)) other = r.b;
    else if (userId && r.b === userId && presentIds.has(r.a)) other = r.a;
    // fallback when the player has no resolved cast id: a relation where one
    // side fuzzy-matches the persona and the other is a present character.
    else if (!userId) {
      if (userMatch(r.a) && presentIds.has(r.b)) other = r.b;
      else if (userMatch(r.b) && presentIds.has(r.a)) other = r.a;
    }
    if (!other) continue;
    const oc = ch.cast[other];
    if (!oc) continue;
    if (userMatch(other)) continue; // never show the player as a rapport row
    if (seen.has(other)) continue; seen.add(other);
    out.push({ name: oc.name, affection: r.affection || 0, trust: r.trust || 0, sentiment: r.sentiment || 'neutral' });
  }
  return out.slice(0, 6);
}

// Resolve the {{user}} persona name for rapport (cheap, cached via macros).
async function resolveUserName(chatId) {
  const cached = _nameCtxCache.get(chatId);
  if (cached && cached.ctx && cached.ctx.user) return cached.ctx.user;
  try {
    if (spindle.macros && spindle.macros.resolve) {
      const r = await spindle.macros.resolve('{{user}}', { chatId, commit: false });
      const txt = (r && (r.text || r.result || r)) || '';
      const n = String(txt).trim();
      if (n && !/\{\{|\}\}/.test(n)) return n;
    }
  } catch (e) { /* fall through */ }
  return null;
}

function broadcast(chatId, parsed, btsRaw, chArg, userName) {
  let rapport = [];
  try { const ch = chArg || chronicleByChat.get(chatId); if (ch) { rapport = computeRapport(ch, userName); } } catch (e) {}
  spindle.sendToFrontend({
    type: 'vellum_tracker_update',
    chatId,
    ledger: parsed,
    bts: btsRaw,
    rapport,
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

// Detect an unnamed / incidental "character": a generic role or descriptor
// ("a servant", "the guard", "a maid with linens", "the crowd", "someone")
// rather than a proper name. Such figures should never anchor a knowledge fact,
// secret, or cast card. Returns true when the value is NOT a usable name.
function isIncidentalName(raw) {
  const n = String(raw == null ? '' : raw).trim();
  if (!n) return true;
  // Strip a leading article/possessive so "the crowd"/"a servant" are caught.
  const stripped = n.toLowerCase().replace(/^(the|a|an|some|one|that|this|his|her|their|my|your)\s+/i, '').trim();
  const GENERIC = /^(servants?|guards?|maids?|soldiers?|knights?|squires?|handmaidens?|attendants?|stewards?|cooks?|grooms?|smiths?|septons?|septas?|maesters?|whores?|prostitutes?|crowd|mob|people|peasants?|smallfolk|commoners?|villagers?|townsfolk|onlookers?|bystanders?|courtiers?|nobles?|lords?|ladies|men|women|boys?|girls?|children|someone|somebody|anyone|everyone|nobody|no one|stranger|strangers?|figures?|others?)\b/i;
  if (GENERIC.test(stripped)) return true;
  // A multiword descriptor with no capitalized proper-name token is incidental
  // ("a woman with linens"); a single lowercase word is too ("guard").
  if (!/[A-Z]/.test(n)) return true;
  return false;
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
  return { version: 3, updatedAt: 0, turns: 0, lastDay: 1, arcs: {}, threads: {}, events: [], shifts: [], memories: [], memTree: { arcs: [], builtAt: 0 }, cast: {}, present: [], memJournal: {}, knowledge: [], secrets: [], relations: [], covered: 0, hideSummarized: false, living: false, pulse: [], pulseSeen: 0, tombstones: { mem: [], know: [], sec: [], rel: [] }, injLog: [], fb: {}, tune: { minScore: RECALL.minScore, samples: 0 }, _sig: '' };
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
    // No cap — full status history retained (file-backed storage).
  }
  t.status = st || t.status;
  t.title = title;
  t.lastTurn = turn; t.lastDay = day;
}

// Tokenize a log line for similarity (lowercase words >=3 chars, drop a few
// filler words). Self-contained so it works regardless of declaration order.
const _LOG_FILLER = new Set(['the', 'and', 'for', 'with', 'now', 'into', 'its', 'a', 'an', 'of', 'to', 'in', 'on', 'as', 'at', 'is', 'are', 'was', 'were', 'has', 'have', 'her', 'his', 'their', 'they', 'them']);
function logSimTokens(t) {
  return (String(t || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !_LOG_FILLER.has(w));
}
// Containment similarity vs the smaller set — robust when one line elaborates
// the other ("staff moving" vs "staff laying breakfast").
function logSim(aTokens, bTokens) {
  const A = new Set(aTokens), B = new Set(bTokens);
  if (!A.size || !B.size) return 0;
  let inter = 0; A.forEach((x) => { if (B.has(x)) inter++; });
  return inter / Math.min(A.size, B.size);
}

function pushLog(arr, entry, cap) {
  // Fuzzy same-day dedup: a recurring ambient line ("Kitchen staff laying
  // breakfast; bread rising; fire crackling") gets re-emitted nearly verbatim
  // every turn. Skip a new entry that's highly similar to a recent one on the
  // SAME story day; if the new wording is longer/richer, replace the old one so
  // the most complete phrasing is kept (no duplicate rows pile up).
  const newTokens = logSimTokens(entry.text);
  const scanFrom = Math.max(0, arr.length - 8); // only check the recent tail
  for (let i = arr.length - 1; i >= scanFrom; i--) {
    const e = arr[i];
    if (!e || e.day !== entry.day) continue;
    if (e.text === entry.text) return; // exact dup
    const sim = logSim(newTokens, logSimTokens(e.text));
    if (sim >= 0.7) {
      // near-duplicate on the same day — keep the longer (more informative) text
      if ((entry.text || '').length > (e.text || '').length && !e.userEdited) {
        e.text = entry.text; e.turn = entry.turn;
      }
      return;
    }
  }
  arr.push(entry);
  if (cap && arr.length > cap) arr.shift(); // cap falsy = unlimited
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
    chronicleLines(led.offscreen).forEach((text) => pushLog(ch.events, { turn, day, text }, 0));
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
    let _btsActor = '';
    String(bts).split('\n').map((l) => l.trim()).filter(Boolean).forEach((line) => {
      if (/^\+?\s*thread\s*[:→]/i.test(line) || /^thread→/i.test(line)) {
        const th = parseThreadLine(line);
        upsertTrack(ch.threads, th.name, th.detail, turn, day);
      } else if (/^rel[A-Za-z]*→/i.test(line)) {
        pushLog(ch.shifts, { turn, day, text: line.replace(/^rel[A-Za-z]*→\s*/i, '').trim(), kind: 'rel' }, 0);
        try {
          const two = line.match(/^rel([A-Za-z][\w' .-]*?)→\s*([^:]+):(.*)$/i);
          const one = line.match(/^rel→\s*([^:]+):(.*)$/i);
          let aName = null, bName = null, tail = null;
          if (two) { aName = two[1].trim(); bName = two[2].trim(); tail = two[3]; }
          else if (one) { aName = _btsActor; bName = one[1].trim(); tail = one[2]; }
          if (aName && bName) {
            const ax = parseRelAxes(tail);
            if (ax) {
              const ma = resolveOrAddCast(ch, aName), mb = resolveOrAddCast(ch, bName);
              if (ma && mb && ma.id !== mb.id) {
                let r = (ch.relations || []).find((x) => (x.a === ma.id && x.b === mb.id) || (x.a === mb.id && x.b === ma.id));
                if (!r) r = relationAdd(ch, { a: aName, b: bName, category: 'neutral', sentiment: 'neutral' }, { source: 'auto' });
                if (r && !(r.userEdited && r.lockScores)) {
                  const beforeS = r.sentiment;
                  if (ax.abs) { r.affection = REL_CLAMP(ax.dAff); r.trust = REL_CLAMP(ax.dTr); r.sentiment = deriveSentiment(r.affection, r.trust); r.lastTurn = turn; r.history.push({ turn, day, affection: r.affection, trust: r.trust, reason: ax.reason }); if (r.history.length > 60) r.history.shift(); }
                  else { applyRelDelta(r, ax.dAff, ax.dTr, ax.reason, turn); }
                  const na = ch.cast[r.a] ? ch.cast[r.a].name : aName, nb = ch.cast[r.b] ? ch.cast[r.b].name : bName;
                  const moved = beforeS !== r.sentiment;
                  pushPulse(ch, { kind: 'relation', icon: (ax.dAff + ax.dTr) >= 0 ? '▲' : '▼', who: na, text: na + ' → ' + nb + ': ' + (moved ? (beforeS + ' → ' + r.sentiment + ' ') : '') + '(aff ' + (ax.abs ? '=' : (ax.dAff >= 0 ? '+' : '')) + ax.dAff + ', trust ' + (ax.abs ? '=' : (ax.dTr >= 0 ? '+' : '')) + ax.dTr + ')' + (ax.reason ? ' — ' + ax.reason : ''), relId: r.id, sentiment: r.sentiment, big: moved });
                }
              }
            }
          }
        } catch (eRel) {}
      } else if (/^world\b/i.test(line)) {
        const t = line.replace(/^world[:\s]*/i, '').trim();
        if (t) pushLog(ch.events, { turn, day, text: t }, 0);
      } else {
        // Off-screen / present cast mentioned in BTS actor lines: ":: Name ::" or ":: OFF :: Name"
        const off = line.match(/^::\s*OFF\s*::\s*([^|>]+)/i);
        const on = line.match(/^::\s*([^:|>]+?)\s*::/);
        if (off && off[1]) { _btsActor = off[1].trim(); touchCast(ch, _btsActor, turn, day, 'active'); }
        else if (on && on[1] && !/^OFF$/i.test(on[1].trim())) { _btsActor = on[1].trim(); touchCast(ch, _btsActor, turn, day, 'active'); }
      }
    });
  }
  ch.lastDay = day;
}

// Split a [present] field into clean character names.
﻿// Parse signed/absolute affection+trust from a BTS rel line tail, e.g.
// "aff +12, trust -8 (the lie)" or "aff 55, trust 30". Returns {dAff,dTr,abs,reason} or null.
function parseRelAxes(tail) {
  const s = String(tail || '');
  const affM = s.match(/aff(?:ection)?\s*([+-]?\d{1,3})/i);
  const trM = s.match(/trust\s*([+-]?\d{1,3})/i);
  if (!affM && !trM) return null;
  const signed = /[+-]\s*\d/.test(s); // any explicit sign => treat as delta
  const reasonM = s.match(/\(([^)]+)\)/);
  return {
    dAff: affM ? parseInt(affM[1], 10) : 0,
    dTr: trM ? parseInt(trM[1], 10) : 0,
    abs: !signed,
    reason: reasonM ? reasonM[1].trim() : '',
  };
}

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

// Content-derived alias keys (#5, TunnelVision deriveAliasKeys idea): mine a
// character's role/appearance/note for role-descriptors and proper-noun phrases
// the scene might use instead of the name ("the kingslayer", "her twin", "the
// queen"). Stored in c.derivedAka (separate from user-facing aka) and used only
// to strengthen scene name-matching, never shown in the UI.
const ROLE_STOP = new Set(['the','a','an','and','or','of','to','in','on','at','with','her','his','their','its','who','that','which','is','was','are','were','as','for','from','by','this','these','those','very','more','most','some','such']);
function deriveAliasKeys(c) {
  const out = new Set();
  const src = [c.role || '', c.appearance || '', c.note || ''].join('. ');
  if (!src.trim()) return [];
  // 1) role descriptors: "<article> <word(s)> who/that ..." or a leading noun phrase
  const roleRe = /\b(?:the|a|an|her|his|their)\s+([a-z][a-z'’-]+(?:\s+[a-z][a-z'’-]+){0,2})\b/gi;
  let m;
  while ((m = roleRe.exec(src)) !== null) {
    const phrase = m[1].trim().toLowerCase();
    const toks = phrase.split(/\s+/).filter((w) => w.length > 2 && !ROLE_STOP.has(w));
    if (toks.length) out.add(toks.join(' '));
    if (out.size > 10) break;
  }
  // 2) capitalized proper-noun phrases (titles, epithets) e.g. "Prince of Harrenhal"
  const propRe = /\b([A-Z][a-z]{2,}(?:\s+(?:of|the)\s+[A-Z][a-z]{2,}|\s+[A-Z][a-z]{2,}){0,2})\b/g;
  while ((m = propRe.exec(src)) !== null) {
    const phrase = m[1].trim();
    if (castKey(phrase) !== castKey(c.name)) out.add(phrase.toLowerCase());
    if (out.size > 16) break;
  }
  return Array.from(out).slice(0, 12);
}

// Refresh c.derivedAka from its current fields (call after enrich/edit).
function refreshDerivedAliases(c) {
  try { c.derivedAka = deriveAliasKeys(c); } catch (e) { /* best effort */ }
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

// Short stable id generator for chronicle entries (events/shifts/knowledge/etc.)
let _vidCounter = 0;
function vid(prefix) { return (prefix || 'v') + Date.now().toString(36) + (_vidCounter++).toString(36) + Math.floor(Math.random() * 1296).toString(36); }

// Stamp stable ids on every entry that lacks one. Called in saveChronicle so
// ALL creation paths (fold, scan, import, manual add) get ids uniformly — this
// is what lets the UI edit/delete by id, immune to sort/filter index drift.
function ensureIds(ch) {
  (ch.events || []).forEach((e) => { if (e && !e.id) e.id = vid('ev'); });
  (ch.shifts || []).forEach((s) => { if (s && !s.id) s.id = vid('sh'); });
  (ch.knowledge || []).forEach((k) => { if (k && !k.id) k.id = vid('kn'); });
  (ch.secrets || []).forEach((s) => { if (s && !s.id) s.id = vid('sc'); });
  for (const k of Object.keys(ch.memJournal || {})) {
    (ch.memJournal[k].entries || []).forEach((e) => { if (e && !e.id) e.id = vid('mj'); });
  }
  (ch.memories || []).forEach((m) => { if (m && !m.id) m.id = vid('m'); });
  (ch.relations || []).forEach((r) => { if (r && !r.id) r.id = vid('rel'); });
}

// Collapse same-day near-duplicate log entries already stored (events/shifts).
// Cleans up history accumulated before fuzzy dedup existed, and catches dups
// introduced via import/merge. Keeps the richest phrasing; never drops a
// user-edited or user-added entry. Order-preserving. Returns count removed.
function dedupeLogArray(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return 0;
  const kept = [];
  const keptTokens = [];
  let removed = 0;
  for (const e of arr) {
    if (!e) continue;
    const toks = logSimTokens(e.text);
    let dupOf = -1;
    for (let i = kept.length - 1; i >= 0 && i >= kept.length - 12; i--) {
      if (kept[i].day !== e.day) continue;
      if (kept[i].text === e.text || logSim(toks, keptTokens[i]) >= 0.7) { dupOf = i; break; }
    }
    if (dupOf >= 0) {
      const prev = kept[dupOf];
      // user content always wins and is never replaced; otherwise keep longer text
      if (e.userEdited || e.userAdded) { kept[dupOf] = e; keptTokens[dupOf] = toks; }
      else if (!prev.userEdited && !prev.userAdded && (e.text || '').length > (prev.text || '').length) { kept[dupOf] = e; keptTokens[dupOf] = toks; }
      removed++;
    } else {
      kept.push(e); keptTokens.push(toks);
    }
  }
  if (removed) { arr.length = 0; arr.push(...kept); }
  return removed;
}
function dedupeLogs(ch) {
  const r = dedupeLogArray(ch.events) + dedupeLogArray(ch.shifts);
  if (r) spindle.log.info('[vellum_tracker] collapsed ' + r + ' duplicate log entries');
  return r;
}

// No structural prune: the chronicle now lives on the per-extension virtual
// disk (spindle.storage), which has no 90KB chat-var ceiling, so arcs/threads/
// events/etc. are unbounded. Kept as a no-op hook for clarity.
function pruneChronicle(ch) { /* unlimited — file-backed storage */ }

// Per-extension file path for a chat's chronicle (unlimited, free-tier disk).
function chroniclePath(chatId) { return 'chronicles/' + String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_') + '.json'; }

async function loadChronicle(chatId) {
  if (chronicleByChat.has(chatId)) return chronicleByChat.get(chatId);
  let ch = freshChronicle();
  let loaded = false;
  // 1) Primary store: per-extension virtual disk (no size limit).
  try {
    if (spindle.storage && spindle.storage.exists && await spindle.storage.exists(chroniclePath(chatId))) {
      const raw = await spindle.storage.read(chroniclePath(chatId));
      if (raw) { const p = JSON.parse(raw); if (p && p.arcs) { ch = p; loaded = true; } }
    }
  } catch (e) { spindle.log.warn(`[vellum_tracker] storage load: ${e?.message || e}`); }
  // 2) Migration fallback: older chronicles persisted in the 90KB chat-var.
  if (!loaded) {
    try {
      const stored = spindle.variables.chat.get ? await spindle.variables.chat.get(chatId, 'vellum_chronicle') : null;
      if (stored) { const p = JSON.parse(stored); if (p && p.arcs) { ch = p; ch._migrateToStorage = true; } }
    } catch (e) { /* fall back to fresh */ }
  }
  // migrate older chronicles missing the memory fields
  if (!Array.isArray(ch.memories)) ch.memories = [];
  if (!ch.memTree || typeof ch.memTree !== 'object') ch.memTree = { arcs: [], builtAt: 0 }; // persisted arc-node tree
  if (!Array.isArray(ch.memTree.arcs)) ch.memTree.arcs = [];
  if (typeof ch.covered !== 'number') ch.covered = 0;
  if (!ch.cast || typeof ch.cast !== 'object') ch.cast = {};
  if (!Array.isArray(ch.present)) ch.present = [];
  if (!Array.isArray(ch.presentIds)) ch.presentIds = [];
  if (typeof ch.deepRecall !== 'boolean') ch.deepRecall = false;
  if (typeof ch.hideSummarized !== 'boolean') ch.hideSummarized = false;
  if (typeof ch.living !== 'boolean') ch.living = false; // auto-update the trackers each turn
  if (!Array.isArray(ch.pulse)) ch.pulse = [];           // activity log / notifications
  if (typeof ch.pulseSeen !== 'number') ch.pulseSeen = 0; // count marked-seen
  if (!ch.memJournal || typeof ch.memJournal !== 'object') ch.memJournal = {};
  if (!Array.isArray(ch.knowledge)) ch.knowledge = [];
  if (!Array.isArray(ch.secrets)) ch.secrets = [];
  if (!Array.isArray(ch.relations)) ch.relations = []; // cast relationship edges
  ch.relations.forEach((r) => ensureRelScores(r)); // migrate text-only edges to numeric axes
  // Tombstones: signatures of entries the user deleted, so a re-import or a
  // future scan never resurrects them. Capped to stay bounded.
  if (!ch.tombstones || typeof ch.tombstones !== 'object') ch.tombstones = { mem: [], know: [], sec: [], rel: [] };
  if (!Array.isArray(ch.tombstones.mem)) ch.tombstones.mem = [];
  if (!Array.isArray(ch.tombstones.know)) ch.tombstones.know = [];
  if (!Array.isArray(ch.tombstones.sec)) ch.tombstones.sec = [];
  if (!Array.isArray(ch.tombstones.rel)) ch.tombstones.rel = [];
  // Injector state (persisted so it survives worker idle-unload):
  if (!Array.isArray(ch.injLog)) ch.injLog = [];            // cooldown ring (#2)
  if (!ch.fb || typeof ch.fb !== 'object') ch.fb = {};      // per-id feedback (#1): {inj,ref,miss}
  if (!ch.tune || typeof ch.tune !== 'object') ch.tune = { minScore: RECALL.minScore, samples: 0 }; // (#16)
  // ensure every cast member has an aka (also-known-as) list
  for (const k of Object.keys(ch.cast)) { if (!Array.isArray(ch.cast[k].aka)) ch.cast[k].aka = []; }
  chronicleByChat.set(chatId, ch);
  return ch;
}

async function saveChronicle(chatId, ch) {
  ch.updatedAt = Date.now();
  ensureIds(ch);
  dedupeLogs(ch);
  chronicleByChat.set(chatId, ch);
  // Persist to the per-extension virtual disk (spindle.storage) — file-backed,
  // free-tier, NO 90KB chat-var ceiling, so the chronicle is effectively
  // unlimited (arcs, threads, events, memories, etc. are never trimmed).
  let persisted = false;
  try {
    const json = JSON.stringify(ch);
    if (spindle.storage && spindle.storage.write) {
      await spindle.storage.write(chroniclePath(chatId), json);
      persisted = true;
      // One-time migration cleanup: drop the legacy oversized chat-var blob.
      if (ch._migrateToStorage) {
        delete ch._migrateToStorage;
        try { await spindle.variables.chat.set(chatId, 'vellum_chronicle', ''); } catch (e2) {}
      }
    }
  } catch (e) { spindle.log.warn(`[vellum_tracker] storage persist: ${e?.message || e}`); }
  // Fallback for hosts without storage: keep the old size-safe chat-var path so
  // we never store invalid (truncated) JSON that would reset the chronicle.
  if (!persisted) {
    const LIMIT = 90000;
    try {
      let json = JSON.stringify(ch);
      if (json.length > LIMIT) {
        const slim = JSON.parse(json);
        delete slim.vellum_ledger_raw;
        for (const k of Object.keys(slim.arcs || {})) { delete slim.arcs[k].rawHistory; }
        const trims = [
          () => { if (slim.events && slim.events.length > 200) slim.events = slim.events.slice(-200); },
          () => { if (slim.shifts && slim.shifts.length > 150) slim.shifts = slim.shifts.slice(-150); },
          () => { for (const k of Object.keys(slim.arcs || {})) if (slim.arcs[k].history && slim.arcs[k].history.length > 12) slim.arcs[k].history = slim.arcs[k].history.slice(-12); },
          () => { for (const k of Object.keys(slim.threads || {})) if (slim.threads[k].history && slim.threads[k].history.length > 12) slim.threads[k].history = slim.threads[k].history.slice(-12); },
          () => { if (slim.memories && slim.memories.length > 60) slim.memories = slim.memories.slice(-60); },
          () => { if (slim.events) slim.events = slim.events.slice(-40); if (slim.shifts) slim.shifts = slim.shifts.slice(-40); },
          () => { if (slim.memories && slim.memories.length > 30) slim.memories = slim.memories.slice(-30); },
        ];
        for (const t of trims) { json = JSON.stringify(slim); if (json.length <= LIMIT) break; t(); }
        json = JSON.stringify(slim);
        if (json.length > LIMIT) { slim.events = []; slim.shifts = []; json = JSON.stringify(slim); }
      }
      await spindle.variables.chat.set(chatId, 'vellum_chronicle', json);
    } catch (e) { spindle.log.warn(`[vellum_tracker] saveChronicle persist: ${e?.message || e}`); }
  }
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
  queryMessages: 5,   // how many recent messages form the retrieval query
  budgetChars: 2600,  // max chars of scene-relevant recall injected per turn
  minScore: 3,        // min scene-weighted score to inject (newest-turn hit or phrase, or 2+ shared tokens)
  maxItems: 18,
};

// Global injection budget allocator (#4.5). One ceiling for the whole VELLUM
// recall block, split across sub-blocks by priority. Sub-block caps are upper
// bounds; the allocator hands leftover budget down the priority chain so a quiet
// scene still fills with the most relevant material.
const INJECT_BUDGET = {
  total: 6400,        // hard ceiling for the entire injected recall system message
  cast: 1400,         // cast roster digest
  knowledge: 1100,    // knowledge + secrets digest
  recall: 2600,       // scene-relevant chronicle recall (mirrors RECALL.budgetChars)
  graph: 900,         // entity-graph multi-hop additions (#12)
  memory: 1800,       // dedicated Story Memory slice (chapter summaries) — never crowded out
};
const MEMORY_RECALL = {
  recencyFloor: 2,    // always include the N most-recent summaries (bridge over hidden turns)
  maxItems: 8,
  minScore: 1.5,      // lower gate than general recall — summaries are precious
};
// Conversation-phase budget multipliers (#7) applied to the recall slice.
const PHASE_BUDGET_MULT = { action: 1.15, dialogue: 1.0, intro: 0.85, transition: 0.7, unknown: 1.0 };

const RECALL_STOP = new Set(['the','and','for','with','that','this','her','his','him','she','they','them','their','was','were','are','you','your','from','into','but','not','had','has','have','will','would','could','should','what','when','where','who','why','how','all','any','out','off','over','then','there','about','said','says','like','just','its','also','been','being','because','around','before','after','still','than','too','very','more','most','some','such','only','even','onto','upon','while','here','now','one','two']);
// Shared family surnames — a lone surname token must NOT flag a character as
// "named in the scene" (you playing "Daeron Targaryen" shouldn't light up every
// Targaryen). Used by nameSignal / sceneMentionBoost / graph anchor matching.
const NAME_SURNAMES = new Set(['targaryen', 'lannister', 'stark', 'martell', 'baratheon', 'tyrell', 'greyjoy', 'tully', 'arryn', 'stone', 'snow', 'sand', 'hill', 'rivers', 'storm', 'flowers', 'waters', 'pyke', 'frey', 'bolton', 'mormont', 'tarly', 'clegane', 'hunt']);

// Genre-agnostic "kin token" detector: any 3+ char name token shared by 2+ cast
// members is treated like a surname (won't, alone, flag a character as named).
// This makes surname-disambiguation work for ANY story/world, not just ASOIAF.
// Cached per chronicle by cast size+version so it's cheap on repeated calls.
const _kinCache = new WeakMap();
function kinTokens(ch) {
  if (!ch || !ch.cast) return NAME_SURNAMES;
  const keys = Object.keys(ch.cast);
  const cached = _kinCache.get(ch);
  if (cached && cached.n === keys.length) return cached.set;
  const counts = new Map();
  for (const k of keys) {
    const toks = new Set((String(ch.cast[k].name || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []));
    for (const t of toks) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const set = new Set(NAME_SURNAMES);
  for (const [t, n] of counts) if (n >= 2) set.add(t); // shared by 2+ cast → kin token
  _kinCache.set(ch, { n: keys.length, set });
  return set;
}

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
    c = sanitizeQueryText(stripReverie(stripLedger(stripBts(c))));
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
    c = sanitizeQueryText(stripReverie(stripLedger(stripBts(c))).trim());
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
// Score-density packing (#4): once gated, order by score/length so the budget
// surfaces the most distinct relevant items rather than one long entry. A
// scene-named entry (mention boost) is always allowed through regardless of the
// minScore gate. Returns { lines, trace, ids } — ids feed the cooldown ring.
function selectRelevant(ch, queryText, pinnedArcIds, pinnedThreadIds, opts) {
  const o = Object.assign({}, RECALL, opts || {});
  const qtokens = uniqTokens(recallTokens(queryText));
  if (qtokens.length < 2) return { lines: [], trace: [], ids: [] };
  const cands = gatherCandidates(ch, queryText, pinnedArcIds, pinnedThreadIds);
  // Deep Recall is now a RERANKER (#9), not a gate: approved entries get a strong
  // additive boost (and carry the controller's reason), but lexical scoring still
  // runs so recall works instantly with no controller and never empties out.
  const approved = o.approved instanceof Map ? o.approved : null;
  if (approved) {
    for (const c of cands) {
      if (approved.has(c.id)) { c.score += 50; c.approvedWhy = approved.get(c.id) || 'LLM judged relevant'; }
    }
    cands.sort((a, b) => (b.score - a.score) || (b.recency - a.recency));
  }
  const minScore = Number.isFinite(o.minScore) ? o.minScore : RECALL.minScore;
  const budget = Number.isFinite(o.budgetChars) ? o.budgetChars : RECALL.budgetChars;

  // Gate first, then re-order survivors by score-density for packing.
  const gated = cands.filter((c) => {
    if (c.mention > 0) return true;          // named in latest message → always eligible
    if (c.approvedWhy) return true;          // controller-approved → always eligible
    return c.score >= minScore;
  });
  gated.sort((a, b) => {
    // scene-named entries first, then density, then raw score
    if ((b.mention > 0) !== (a.mention > 0)) return (b.mention > 0) ? 1 : -1;
    const da = a.score / Math.max(20, a.len), db = b.score / Math.max(20, b.len);
    return (db - da) || (b.score - a.score);
  });

  const lines = [], trace = [], ids = [];
  const seenShingles = []; // for near-duplicate suppression
  let used = 0;
  for (const c of gated) {
    if (lines.length >= o.maxItems) break;
    if (used + c.line.length + 1 > budget) continue;
    // Near-duplicate suppression: long chronicles fold a near-identical event/
    // shift every turn ("Perzys sleeping in vault" ×15). Skip a candidate whose
    // body strongly overlaps one already selected, unless it's scene-named.
    if (c.mention < 100) {
      const toks = new Set(recallTokens(c.line).filter((t) => t.length >= 4 && !RECALL_STOP.has(t)));
      let dup = false;
      for (const prev of seenShingles) {
        if (!toks.size || !prev.size) continue;
        let inter = 0; for (const t of toks) if (prev.has(t)) inter++;
        const sim = inter / Math.min(toks.size, prev.size);
        if (sim >= 0.6) { dup = true; break; }
      }
      if (dup) continue;
      seenShingles.push(toks);
    }
    lines.push(c.line);
    ids.push(c.id);
    const why = c.approvedWhy || c.why || ('relevance ' + Math.round(c.score));
    trace.push({ id: c.id, kind: c.kind, label: c.label, score: c.approvedWhy ? '✓' : Math.round(c.score * 10) / 10, why });
    used += c.line.length + 1;
  }
  return { lines, trace, ids };
}

// ============================================================================
// STORY MEMORY — a dedicated, smart summary-only selector (Option B).
// Chapter summaries are memory, not trivia: they get their own budget, their
// own scoring tuned for summaries (recency floor + entity/tag-aware, no density
// penalty), and a multi-axis index that an optional LLM can traverse to drill
// from an axis (character/topic/plot/day) to a concrete chapter finding.
// ============================================================================

// Tag-aware relevance score for a single summary against the scene.
function scoreMemory(m, layers, qtokens, qphrase, nc) {
  let s = 0;
  const why = [];
  // keyword + phrase (existing signal)
  const kw = (m.keywords || []).join(' ');
  const kwS = layeredScore(kw, layers) * 2;
  const ph = phraseBonus(kw, layers);
  const body = layeredScore(m.text, layers);
  if (kwS) { s += kwS; why.push('keywords'); }
  if (ph) { s += ph; why.push('phrase'); }
  if (body) s += body * 0.5;
  // ENTITY overlap (#2): a character named in the scene → strong boost.
  for (const c of (m.characters || [])) {
    const cn = normForPhrase(c).trim();
    if (cn.length >= 3 && qphrase.includes(' ' + cn + ' ')) { s += 5; why.push('character ' + c); }
    else { const toks = recallTokens(c).filter((t) => t.length >= 3 && !RECALL_STOP.has(t)); for (const t of toks) if (qtokens.includes(t)) { s += 2.5; break; } }
  }
  // TOPIC overlap (#7): a recurring motif/topic echoed in the scene.
  for (const t of (m.topics || [])) {
    const tn = normForPhrase(t).trim();
    if (tn.length >= 3 && qphrase.includes(' ' + tn + ' ')) { s += 4; why.push('topic "' + t + '"'); }
    else { const toks = recallTokens(t).filter((w) => w.length >= 4 && !RECALL_STOP.has(w)); for (const w of toks) if (qtokens.includes(w)) { s += 1.5; break; } }
  }
  // PLOT / location overlap.
  for (const p of (m.plots || [])) { const toks = recallTokens(p).filter((w) => w.length >= 4 && !RECALL_STOP.has(w)); for (const w of toks) if (qtokens.includes(w)) { s += 2; why.push('plot'); break; } }
  if (m.location) { const ln = normForPhrase(m.location).trim(); if (ln.length >= 3 && qphrase.includes(' ' + ln + ' ')) { s += 2; why.push('location'); } }
  return { score: s, why: why.slice(0, 3).join(', ') };
}

// One injectable line for a summary (compact, dated, titled).
function memoryLine(m) {
  const dl = m.day ? 'Day ' + m.day : 't' + m.fromTurn + '-' + m.toTurn;
  const head = m.title ? (m.title + ' — ') : '';
  return '\u2756 [' + dl + '] ' + head + (m.text || '').trim();
}

// selectMemories(): the smart summary injector. Recency floor (#1) + tag/entity
// scoring (#2) + dedup (#5), in its own budget. Returns { lines, trace, ids }.
function selectMemories(ch, queryText, opts) {
  const o = opts || {};
  const mems = (ch.memories || []);
  if (!mems.length) return { lines: [], trace: [], ids: [] };
  const budget = Number.isFinite(o.budgetChars) ? o.budgetChars : INJECT_BUDGET.memory;
  const layers = buildLayersFromQuery(queryText);
  const qtokens = uniqTokens(recallTokens(queryText));
  const qphrase = normForPhrase(queryText);
  const nc = o.nc || null;
  const approved = o.approved instanceof Set ? o.approved : null; // ids the LLM traversal chose

  const byTurn = mems.slice().sort((a, b) => (a.fromTurn || 0) - (b.fromTurn || 0));
  const floorN = Math.max(0, MEMORY_RECALL.recencyFloor);
  const recentIds = new Set(byTurn.slice(-floorN).map((m) => m.id));

  const scored = mems.map((m) => {
    const r = scoreMemory(m, layers, qtokens, qphrase, nc);
    let score = r.score;
    let why = r.why;
    if (recentIds.has(m.id)) { score += 100; why = 'recent chapter'; }      // recency floor
    if (approved && approved.has(m.id)) { score += 60; why = 'memory-tree relevant' + (why ? '; ' + why : ''); }
    return { m, score, why };
  }).filter((x) => x.score >= MEMORY_RECALL.minScore || recentIds.has(x.m.id) || (approved && approved.has(x.m.id)));

  // order: recency-floor + approved first (by turn), then by score; ties by recency
  scored.sort((a, b) => {
    const ap = (recentIds.has(a.m.id) || (approved && approved.has(a.m.id))) ? 1 : 0;
    const bp = (recentIds.has(b.m.id) || (approved && approved.has(b.m.id))) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return (b.score - a.score) || ((b.m.fromTurn || 0) - (a.m.fromTurn || 0));
  });

  const lines = [], trace = [], ids = [], seen = [];
  let used = 0;
  for (const { m, score, why } of scored) {
    if (lines.length >= MEMORY_RECALL.maxItems) break;
    const line = memoryLine(m);
    if (used + line.length + 1 > budget) continue;
    // dedup (#5): skip a summary that strongly overlaps one already chosen
    const toks = new Set(recallTokens(m.text).filter((t) => t.length >= 4 && !RECALL_STOP.has(t)));
    let dup = false;
    for (const prev of seen) { if (!toks.size || !prev.size) continue; let inter = 0; for (const t of toks) if (prev.has(t)) inter++; if (inter / Math.min(toks.size, prev.size) >= 0.7) { dup = true; break; } }
    if (dup) continue;
    seen.push(toks);
    lines.push(line); ids.push(m.id);
    trace.push({ id: m.id, kind: 'memory', label: m.title || ('t' + m.fromTurn + '-' + m.toTurn), score: Math.round(score * 10) / 10, why: why || 'relevant chapter' });
    used += line.length + 1;
  }
  // chronological order in the injected block reads as a timeline
  const order = new Map(byTurn.map((m, i) => [m.id, i]));
  const zipped = lines.map((l, i) => ({ l, id: ids[i], t: trace[i] })).sort((a, b) => (order.get(a.id) || 0) - (order.get(b.id) || 0));
  return { lines: zipped.map((z) => z.l), trace: zipped.map((z) => z.t), ids: zipped.map((z) => z.id) };
}

// Build the multi-axis index (the queryable "tree") from summary tags.
// Axes: characters, topics, plots, days. Each maps an axis-value -> memory ids.
function buildMemoryIndex(ch) {
  const idx = { characters: {}, topics: {}, plots: {}, days: {} };
  const add = (axis, key, id) => { const k = String(key || '').trim(); if (!k) return; const a = idx[axis]; (a[k] || (a[k] = [])).push(id); };
  for (const m of (ch.memories || [])) {
    (m.characters || []).forEach((c) => add('characters', c, m.id));
    (m.topics || []).forEach((t) => add('topics', t, m.id));
    (m.plots || []).forEach((p) => add('plots', p, m.id));
    if (m.day != null) add('days', 'Day ' + m.day, m.id);
  }
  return idx;
}

// A compact text view of the persisted arc tree for the traversal controller.
function arcTreeBlock(ch) {
  const arcs = (ch.memTree && ch.memTree.arcs) || [];
  if (!arcs.length) return '';
  return arcs.map((a) => '\u25C8 ' + a.title + (a.day ? ' (Day ' + a.day + ')' : '') + (a.gist ? ' — ' + a.gist : '') + '  {chapters: ' + (a.chapterIds || []).join(', ') + '}').join('\n');
}


// A serializable view of the memory tree for the UI: arcs with their chapters,
// the unassigned chapters, and the axis index counts.
function memTreeView(ch) {
  const memById = (id) => (ch.memories || []).find((m) => m.id === id);
  const lite = (m) => m ? { id: m.id, title: m.title || ('t' + m.fromTurn + '-' + m.toTurn), day: m.day || null, fromTurn: m.fromTurn, toTurn: m.toTurn, characters: m.characters || [], topics: m.topics || [], text: (m.text || '').slice(0, 240) } : null;
  const arcs = (ch.memTree && ch.memTree.arcs || []).map((a) => ({ id: a.id, title: a.title, gist: a.gist || '', from: a.from || null, to: a.to || null, day: a.day || null, userEdited: !!a.userEdited, chapters: (a.chapterIds || []).map(memById).filter(Boolean).map(lite) }));
  const inArc = new Set(); for (const a of (ch.memTree && ch.memTree.arcs || [])) for (const id of (a.chapterIds || [])) inArc.add(id);
  const unassigned = (ch.memories || []).filter((m) => !inArc.has(m.id)).map(lite);
  const idx = buildMemoryIndex(ch);
  const counts = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.length]));
  const index = { characters: counts(idx.characters), topics: counts(idx.topics), plots: counts(idx.plots), days: counts(idx.days) };
  return { arcs, unassigned, index, builtAt: (ch.memTree && ch.memTree.builtAt) || 0, chapters: (ch.memories || []).length };
}
// ============================================================================
// MEMORY TREE (persisted) — arc nodes grouping chapter summaries (tier 2).
// ch.memTree = { arcs: [{ id, title, gist, chapterIds:[], from, to, day }], builtAt }.
// An arc node bundles consecutive chapters under a label + 1-2 sentence gist,
// so traversal/coverage works at the arc level and the deep past compresses.
// Built by an LLM (build/rebuild), fully user-editable (rename/gist/move/delete).
// ============================================================================
function memArcId() { return 'arc' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }

// Recompute an arc's derived span (from/to/day) from its current chapters.
function refreshArcSpan(ch, arc) {
  const mems = (arc.chapterIds || []).map((id) => (ch.memories || []).find((m) => m.id === id)).filter(Boolean);
  if (!mems.length) { arc.from = null; arc.to = null; arc.day = null; return; }
  arc.from = Math.min(...mems.map((m) => m.fromTurn || 0));
  arc.to = Math.max(...mems.map((m) => m.toTurn || 0));
  arc.day = mems[0].day || null;
}

// Chapters not assigned to any arc.
function unassignedChapters(ch) {
  const inArc = new Set();
  for (const a of (ch.memTree.arcs || [])) for (const id of (a.chapterIds || [])) inArc.add(id);
  return (ch.memories || []).filter((m) => !inArc.has(m.id));
}

const MEMTREE_SYS = 'You are a story editor organizing a roleplay\'s chapter summaries into ARCS — contiguous groups that form one movement of the story (a phase, a storyline, an act). You are given the chapters in order (id · title · day · characters · topics). Output STRICT JSON only: {"arcs":[{"title":"3-6 word arc name","gist":"1-2 sentences: what this arc is about and what changed across it","chapterIds":["id","id"]}]}. Rules: cover EVERY chapter exactly once, in order; arcs are CONTIGUOUS runs of chapters (no interleaving); make 2-8 arcs depending on length; name them for their dramatic content (e.g. "The Reluctant Betrothal", "Discovering the Dragon"), not "Chapters 1-4"; the gist must capture the arc\'s throughline. No prose outside the JSON.';

const buildingTree = new Set();
async function buildMemoryTree(chatId, userId) {
  if (buildingTree.has(chatId)) return { ok: false, reason: 'busy' };
  if (!hasPerm('generation') || !(spindle.generate && (spindle.generate.raw || spindle.generate.quiet))) return { ok: false, reason: 'no_generation' };
  buildingTree.add(chatId);
  try {
    const ch = await loadChronicle(chatId);
    const mems = (ch.memories || []).slice().sort((a, b) => (a.fromTurn || 0) - (b.fromTurn || 0));
    if (mems.length < 2) return { ok: false, reason: 'too_few' };
    const list = mems.map((m) => m.id + ' \u00b7 ' + (m.title || ('t' + m.fromTurn + '-' + m.toTurn)) + (m.day ? ' \u00b7 Day ' + m.day : '')
      + (m.characters && m.characters.length ? ' \u00b7 ' + m.characters.slice(0, 4).join('/') : '')
      + (m.topics && m.topics.length ? ' \u00b7 [' + m.topics.slice(0, 4).join(', ') + ']' : '')).join('\n');
    let raw = '';
    try { raw = await internalGenerate([{ role: 'system', content: MEMTREE_SYS }, { role: 'user', content: 'Chapters in order:\n' + list }], { temperature: 0.2, max_tokens: 1800 }, userId); }
    catch (e) { return { ok: false, reason: (e && e.permDenied) ? 'no_generation' : 'error' }; }
    let obj = null;
    try { obj = JSON.parse(String(raw).replace(/<think[\s\S]*?<\/think>/gi, '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim().match(/\{[\s\S]*\}/)[0]); } catch (e) { return { ok: false, reason: 'parse' }; }
    const valid = new Set(mems.map((m) => m.id));
    const used = new Set();
    const arcs = [];
    for (const a of (Array.isArray(obj.arcs) ? obj.arcs : [])) {
      const chapterIds = (Array.isArray(a.chapterIds) ? a.chapterIds : []).map(String).filter((id) => valid.has(id) && !used.has(id));
      chapterIds.forEach((id) => used.add(id));
      if (!chapterIds.length) continue;
      const arc = { id: memArcId(), title: String(a.title || 'Untitled Arc').slice(0, 60), gist: String(a.gist || '').slice(0, 400), chapterIds };
      refreshArcSpan(ch, arc);
      arcs.push(arc);
    }
    // sweep any chapter the model missed into a trailing arc so coverage is total
    const missed = mems.filter((m) => !used.has(m.id));
    if (missed.length) { const arc = { id: memArcId(), title: 'Unsorted', gist: '', chapterIds: missed.map((m) => m.id) }; refreshArcSpan(ch, arc); arcs.push(arc); }
    arcs.sort((a, b) => (a.from || 0) - (b.from || 0));
    ch.memTree = { arcs, builtAt: Date.now() };
    await saveChronicle(chatId, ch);
    broadcastChronicle(chatId, ch, userId);
    spindle.log.info('[vellum_tracker] memory tree built: ' + arcs.length + ' arcs over ' + mems.length + ' chapters');
    return { ok: true, arcs: arcs.length, chapters: mems.length };
  } catch (e) { spindle.log.warn('[vellum_tracker] buildMemoryTree: ' + (e && e.message)); return { ok: false, reason: 'error' }; }
  finally { buildingTree.delete(chatId); }
}

// ---- user edits ----
function memTreeEditArc(ch, arcId, patch) {
  const a = (ch.memTree.arcs || []).find((x) => x.id === arcId);
  if (!a) return false;
  if (typeof patch.title === 'string') a.title = patch.title.slice(0, 60);
  if (typeof patch.gist === 'string') a.gist = patch.gist.slice(0, 400);
  a.userEdited = true;
  return true;
}
function memTreeAddArc(ch, title) {
  const a = { id: memArcId(), title: String(title || 'New Arc').slice(0, 60), gist: '', chapterIds: [], userEdited: true };
  ch.memTree.arcs.push(a);
  return a;
}
function memTreeDeleteArc(ch, arcId) {
  const i = (ch.memTree.arcs || []).findIndex((x) => x.id === arcId);
  if (i < 0) return false;
  ch.memTree.arcs.splice(i, 1); // its chapters become unassigned
  return true;
}
// Move a chapter into an arc (or out, if arcId is falsy). Removes from any other arc.
function memTreeMoveChapter(ch, chapterId, arcId) {
  for (const a of (ch.memTree.arcs || [])) { const i = (a.chapterIds || []).indexOf(chapterId); if (i >= 0) { a.chapterIds.splice(i, 1); refreshArcSpan(ch, a); } }
  if (arcId) { const a = (ch.memTree.arcs || []).find((x) => x.id === arcId); if (!a) return false; if (!a.chapterIds.includes(chapterId)) a.chapterIds.push(chapterId); refreshArcSpan(ch, a); }
  ch.memTree.arcs.sort((a, b) => (a.from || 0) - (b.from || 0));
  return true;
}

// ============================================================================
// DEEP MEMORY — optional LLM tree-traversal over the summary index.
// Instead of scoring all summaries, the controller is shown the AXES (the
// character/topic/plot/day branches) + a compact chapter list, and asked which
// chapters answer the current scene — drilling from an axis to a concrete
// finding ("A has called B 'honey' since Day 2; A hated it, now loves it").
// Returns a Set of memory ids to guarantee, fed into selectMemories(approved).
// Opt-in (rides the Deep Recall toggle); falls back to flat scoring on any miss.
// ============================================================================
const MEM_TREE_SYS = 'You are a story librarian. You are given the BRANCHES of a story\'s memory index (characters, topics, plot threads, days) and a compact list of CHAPTERS (id · title · day · who · topics). Given the CURRENT SCENE, decide which chapters hold the history most relevant to what is happening NOW — especially recurring things the scene echoes (a pet name, a promise, an object, a grudge). Output STRICT JSON only: {"chapters":["id","id"],"reason":"one clause on what thread you followed"}. Pick 1-6 chapter ids, the ones whose past directly informs this moment. Prefer following a specific topic/character branch to its origin and evolution over generic matches. No prose outside the JSON.';

const _memTreeCache = new Map(); // chatId -> { sig, ids:Set, at }
function _memSceneSig(q) { return vhash(String(q || '').slice(-800)); }

async function runMemoryTree(chatId, queryText, userId) {
  try {
    const ch = await loadChronicle(chatId);
    const mems = ch.memories || [];
    if (mems.length < 4) return null; // not enough to bother; flat scoring suffices
    if (!hasPerm('generation') || !(spindle.generate && (spindle.generate.raw || spindle.generate.quiet))) return null;
    const sig = _memSceneSig(queryText);
    const cached = _memTreeCache.get(chatId);
    if (cached && cached.sig === sig && Date.now() - cached.at < 90000) return cached.ids;

    const idx = buildMemoryIndex(ch);
    const axisLines = [];
    const top = (axis, n) => Object.entries(idx[axis]).sort((a, b) => b[1].length - a[1].length).slice(0, n).map(([k, v]) => k + ' (' + v.length + ')').join(', ');
    if (Object.keys(idx.characters).length) axisLines.push('Characters: ' + top('characters', 16));
    if (Object.keys(idx.topics).length) axisLines.push('Topics: ' + top('topics', 20));
    if (Object.keys(idx.plots).length) axisLines.push('Plots: ' + top('plots', 12));
    if (Object.keys(idx.days).length) axisLines.push('Days: ' + Object.keys(idx.days).join(', '));
    const chapterList = mems.slice().sort((a, b) => (a.fromTurn || 0) - (b.fromTurn || 0)).map((m) =>
      m.id + ' \u00b7 ' + (m.title || ('t' + m.fromTurn + '-' + m.toTurn)) + (m.day ? ' \u00b7 Day ' + m.day : '')
      + (m.characters && m.characters.length ? ' \u00b7 ' + m.characters.slice(0, 4).join('/') : '')
      + (m.topics && m.topics.length ? ' \u00b7 [' + m.topics.slice(0, 4).join(', ') + ']' : '')
    ).join('\n');
    const user = 'MEMORY INDEX (branches):\n' + axisLines.join('\n')
      + (arcTreeBlock(ch) ? ('\n\nARCS (curated story movements):\n' + arcTreeBlock(ch)) : '')
      + '\n\nCHAPTERS:\n' + chapterList + '\n\nCURRENT SCENE:\n' + String(queryText || '').slice(-1400);
    let raw = '';
    try { raw = await internalGenerate([{ role: 'system', content: MEM_TREE_SYS }, { role: 'user', content: user }], { temperature: 0.1, max_tokens: 400 }, userId); }
    catch (e) { return null; }
    let obj = null;
    try { obj = JSON.parse(String(raw).replace(/<think[\s\S]*?<\/think>/gi, '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim().match(/\{[\s\S]*\}/)[0]); } catch (e) { return null; }
    const valid = new Set(mems.map((m) => m.id));
    const ids = new Set((Array.isArray(obj.chapters) ? obj.chapters : []).map((x) => String(x)).filter((x) => valid.has(x)));
    if (!ids.size) return null;
    _memTreeCache.set(chatId, { sig, ids, at: Date.now() });
    _prewarmCache.delete(chatId); // new memory-tree picks → next generation re-assembles
    spindle.log.info('[vellum_tracker] memory-tree picked ' + ids.size + ' chapters' + (obj.reason ? ': ' + obj.reason : ''));
    return ids;
  } catch (e) { spindle.log.warn('[vellum_tracker] runMemoryTree: ' + (e && e.message)); return null; }
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
  // Shared finisher: apply scene-mention boost (#3) + cooldown penalty (#2),
  // record components for the trace, and push.
  const push = (id, baseScore, recency, kind, label, why, line, mentionTitle) => {
    const mention = sceneMentionBoost(mentionTitle, layers);
    const cool = cooldownPenalty(ch, id);
    const fb = feedbackAdjust(ch, id);
    const finalScore = baseScore + mention - cool + fb;
    const why2 = [];
    if (mention >= 100) why2.push('named in the latest message');
    else if (mention > 0) why2.push('referenced in the latest message');
    if (why) why2.push(why);
    if (fb > 0) why2.push('model uses this (+' + fb + ')');
    else if (fb < 0) why2.push('injected but ignored (' + fb + ')');
    if (cool > 0) why2.push('recently shown (−' + cool + ')');
    cands.push({ id, score: finalScore, base: baseScore, mention, cool, fb, recency, kind, label, why: why2.join('; '), line, len: line.length });
  };
  Object.values(ch.arcs || {}).forEach((t) => {
    if (pinnedArcIds.has(t.id)) return;
    const r = rate(t.title, t.status, '');
    const line = '◉ ' + t.title + ' [' + dl(t.lastDay) + ']: ' + (t.status || '');
    if (r.score > 0 || sceneMentionBoost(t.title, layers) > 0) push('arc:' + t.id, r.score + 0.5, t.lastTurn || 0, 'arc', t.title, r.why, line, t.title);
  });
  Object.values(ch.threads || {}).forEach((t) => {
    if (pinnedThreadIds.has(t.id)) return;
    const r = rate(t.title, t.status, '');
    const line = '🧵 ' + t.title + ' [' + dl(t.lastDay) + ']: ' + (t.status || '');
    if (r.score > 0 || sceneMentionBoost(t.title, layers) > 0) push('thread:' + t.id, r.score + 0.5, t.lastTurn || 0, 'thread', t.title, r.why, line, t.title);
  });
  (ch.events || []).forEach((e, i) => {
    const r = rate(e.text, '', '');
    if (r.score > 0) push('event:' + vhash(e.text), r.score, i, 'event', e.text.slice(0, 48), r.why, '▸ ' + dl(e.day) + ': ' + e.text, e.text);
  });
  (ch.shifts || []).forEach((s, i) => {
    const r = rate(s.text, '', '');
    if (r.score > 0) push('shift:' + vhash(s.text), r.score, i, 'shift', s.text.slice(0, 48), r.why, '⚲ ' + dl(s.day) + ': ' + s.text, s.text);
  });
  // Chapter summaries are NOT pooled here — they have their own dedicated
  // selectMemories() with a recency floor + tag-aware scoring + own budget, so
  // they're never crowded out by short events in the shared recall pool.
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

// --- Conversation phase detection (#7). Coarse regex classifier over the
// newest scene text; reweights the recall budget. Gentle by design. ---
function detectPhase(queryText) {
  const t = String(queryText || '').toLowerCase();
  if (!t.trim()) return 'unknown';
  const action = (t.match(/\b(grab|strike|hit|slash|sword|blade|run|ran|lunge|blood|fight|attack|dodge|shout|scream|blow|punch|kick|fell|threw|charge|clash)\w*/g) || []).length;
  const dialogue = (t.match(/"[^"]{3,}"|“[^”]{3,}”|\b(said|asked|replied|whispered|murmured|answered)\b/g) || []).length;
  const intro = (t.match(/\b(enters?|arriv\w+|approach\w+|appears?|new|first time|stranger|door opens?)\b/g) || []).length;
  const transition = (t.match(/\b(later|next (morning|day|night)|hours? (later|passed)|meanwhile|elsewhere|the following|by (dawn|dusk|nightfall))\b/g) || []).length;
  const scores = { action, dialogue, intro, transition };
  let best = 'unknown', bv = 0;
  for (const k of Object.keys(scores)) if (scores[k] > bv) { bv = scores[k]; best = k; }
  return bv >= 1 ? best : 'unknown';
}

// --- Injection cooldown ring buffer (#2). Persisted in the chronicle so it
// survives worker idle-unload. Records the ids injected over the last few turns
// and yields a decaying penalty so the same entries don't dominate every turn.
const COOLDOWN = { window: 3, penaltyByAge: [5, 3, 1] };

function cooldownPenalty(ch, id) {
  const log = (ch && ch.injLog) || [];
  // log is newest-last; age 0 = most recent turn that injected it
  for (let i = log.length - 1; i >= 0; i--) {
    if (Array.isArray(log[i]) && log[i].includes(id)) {
      const age = (log.length - 1) - i;
      if (age < COOLDOWN.penaltyByAge.length) return COOLDOWN.penaltyByAge[age];
      return 0;
    }
  }
  return 0;
}

// Record the ids injected this turn into the cooldown ring (bounded).
function recordInjection(ch, ids) {
  if (!ch.injLog) ch.injLog = [];
  ch.injLog.push(Array.from(new Set(ids)).slice(0, 40));
  while (ch.injLog.length > COOLDOWN.window) ch.injLog.shift();
}

/* --- Relevance feedback loop (#1) + threshold auto-tune (#16) ---
 * After a turn is injected we note the ids; after the model responds we scan the
 * new assistant text for references to those entries. Entries the model actually
 * uses get a positive boost; entries injected repeatedly and never referenced go
 * stale (penalty). All counters live on ch.fb (persisted, bounded). */
const FB = { boostCap: 8, stalePenalty: 4, staleAfter: 3, maxEntries: 200 };

// Mark these ids as injected this turn (pending a reference check next turn).
function noteInjectedForFeedback(ch, ids) {
  if (!ch.fb) ch.fb = {};
  ch._pendingFb = Array.from(new Set(ids)).slice(0, 40);
  for (const id of ch._pendingFb) {
    const e = ch.fb[id] || (ch.fb[id] = { inj: 0, ref: 0, miss: 0 });
    e.inj++;
  }
  // bound the table: drop least-active ids if it grows too big
  const keys = Object.keys(ch.fb);
  if (keys.length > FB.maxEntries) {
    keys.sort((a, b) => (ch.fb[a].inj + ch.fb[a].ref) - (ch.fb[b].inj + ch.fb[b].ref));
    for (let i = 0; i < keys.length - FB.maxEntries; i++) delete ch.fb[keys[i]];
  }
}

// After the model's reply, check which injected entries it actually referenced.
// `referencedText` is the new assistant turn; `lastInj` is what we injected.
function applyFeedback(ch, referencedText, injectedTrace) {
  if (!ch.fb || !injectedTrace || !injectedTrace.length) return;
  const refTokens = new Set(recallTokens(referencedText || ''));
  const refPhrase = normForPhrase(referencedText || '');
  let used = 0, missed = 0;
  for (const t of injectedTrace) {
    const id = t.id;
    if (!id || !ch.fb[id]) continue;
    // referenced if a distinctive label token or the label phrase appears in the reply
    const label = String(t.label || '');
    const lblPhrase = normForPhrase(label).trim();
    const toks = recallTokens(label).filter((w) => w.length >= 4 && !RECALL_STOP.has(w));
    let hit = (lblPhrase.length >= 4 && refPhrase.includes(' ' + lblPhrase + ' '));
    if (!hit) for (const w of toks) if (refTokens.has(w)) { hit = true; break; }
    const e = ch.fb[id];
    if (hit) { e.ref++; e.miss = 0; used++; } else { e.miss++; missed++; }
  }
  // Threshold auto-tune (#16), heavily clamped + slow: if we're injecting lots
  // that never gets referenced, nudge minScore up; if almost everything is used,
  // nudge down. Stays within ±2 of the default and moves at most 0.25/turn.
  if (ch.tune) {
    const total = used + missed;
    if (total >= 3) {
      const precision = used / total;
      const target = precision < 0.25 ? RECALL.minScore + 2 : precision > 0.75 ? RECALL.minScore - 1 : RECALL.minScore;
      const cur = Number.isFinite(ch.tune.minScore) ? ch.tune.minScore : RECALL.minScore;
      const next = cur + Math.max(-0.25, Math.min(0.25, target - cur));
      ch.tune.minScore = Math.max(RECALL.minScore - 2, Math.min(RECALL.minScore + 2, next));
      ch.tune.samples = (ch.tune.samples || 0) + 1;
      ch.tune.lastPrecision = Math.round(precision * 100) / 100;
    }
  }
  ch._pendingFb = null;
}

// Per-id feedback adjustment folded into scoring: + when referenced often,
// − when injected repeatedly but ignored (stale).
function feedbackAdjust(ch, id) {
  const e = ch.fb && ch.fb[id];
  if (!e) return 0;
  let adj = 0;
  if (e.ref > 0) adj += Math.min(FB.boostCap, e.ref * 2);
  if (e.inj >= FB.staleAfter && e.ref === 0) adj -= FB.stalePenalty;
  if (e.miss >= FB.staleAfter && e.ref === 0) adj -= 1;
  return adj;
}

// Current (possibly auto-tuned) minScore gate.
function tunedMinScore(ch) {
  const v = ch && ch.tune && Number.isFinite(ch.tune.minScore) ? ch.tune.minScore : RECALL.minScore;
  return Math.max(1, v);
}

// Does the LATEST scene layer (weight 3, the newest message) name this entry?
// A strong, cooldown-overriding signal (#3): what's happening NOW wins a slot.
function sceneMentionBoost(title, layers) {
  if (!layers || !layers.length) return 0;
  const top = layers[0];
  if (!top || top.weight < 3) return 0;
  const name = normForPhrase(title).trim();
  if (name.length >= 4 && top.text.includes(' ' + name + ' ')) return 100; // exact name in newest msg
  // distinctive single token of the title present in the newest message (skip
  // shared surnames so a Targaryen title doesn't fire on "Targaryen" alone)
  const toks = recallTokens(title).filter((w) => w.length >= 4 && !RECALL_STOP.has(w) && !NAME_SURNAMES.has(w));
  for (const t of toks) if (top.tokens.includes(t)) return 40;
  return 0;
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
  const kin = kinTokens(ch);

  const present = [];
  const relevant = [];
  for (const k of keys) {
    const c = cast[k];
    if (presentIds.has(c.id)) { present.push({ c, s: 1000, recent: c.lastTurn || 0 }); continue; }
    // Relevance for NON-present characters must be NAME/ALIAS driven — that's the
    // real signal a character is in play. Role/appearance words (guard, tall,
    // woman…) are common and cause false matches, so they barely count.
    const nameHit = nameSignal(c, qtokens, qphrase, kin);
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
// Scene-gated (#11): a fact whose holder is NAMED in the scene outranks a mere
// shared-word hit, and high-irony entries (wrong beliefs, explosive secrets) get
// a priority bump when their subject is present.
function buildKnowledgeDigest(ch, query, opts) {
  const o = opts || {};
  const budget = Number.isFinite(o.budgetChars) ? o.budgetChars : 700;
  const qtokens = uniqTokens(recallTokens(query || ''));
  const qphrase = normForPhrase(query || '');
  if (qtokens.length < 2) return '';
  const tokOverlap = (txt) => { const e = new Set(recallTokens(txt)); let n = 0; for (const t of qtokens) if (e.has(t)) n++; return n; };
  // Bonus when a NAME phrase appears verbatim in the recent scene.
  const namedInScene = (name) => {
    const n = normForPhrase(name || '').trim();
    if (n.length >= 3 && qphrase.includes(' ' + n + ' ')) return 6;
    const toks = recallTokens(name || '').filter((t) => t.length >= 3 && !RECALL_STOP.has(t));
    for (const t of toks) if (qtokens.includes(t)) return 3;
    return 0;
  };
  const out = [];
  const kn = (ch.knowledge || []).map((k) => {
    let s = tokOverlap(k.who + ' ' + k.fact) + namedInScene(k.who);
    if (k.reliability === 'wrong' && namedInScene(k.who) > 0) s += 3; // dramatic irony: present + wrong belief
    return { k, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 7);
  for (const { k } of kn) {
    let tag = k.reliability;
    if (k.reliability === 'wrong') tag = 'WRONGLY believes';
    else if (k.reliability === 'unaware') tag = 'does NOT know';
    out.push('\u25C7 ' + k.who + ' ' + tag + ': ' + k.fact + (k.reliability === 'wrong' && k.truth === 'false' ? ' (it is not true)' : ''));
  }
  const sc = (ch.secrets || []).filter((x) => !x.revealed).map((x) => {
    let s = tokOverlap(x.secret + ' ' + x.keeper + ' ' + (x.from || '')) + namedInScene(x.keeper) + (namedInScene(x.from) > 0 ? 2 : 0);
    if (x.danger === 'explosive' && (namedInScene(x.keeper) > 0 || namedInScene(x.from) > 0)) s += 3;
    return { x, s };
  }).filter((y) => y.s > 0).sort((a, b) => b.s - a.s).slice(0, 6);
  for (const { x } of sc) {
    out.push('\u26BF ' + x.keeper + ' hides from ' + (x.from || 'others') + ': ' + x.secret + ' [' + x.danger + ']');
  }
  let used = 0; const kept = [];
  for (const line of out) { if (used + line.length + 1 > budget) continue; kept.push(line); used += line.length + 1; }
  return kept.join('\n');
}

/* --- Entity-graph multi-hop recall (#12) ---
 * vellum's structured edge: the chronicle already ties characters to arcs,
 * threads, secrets and knowledge by name. When a character is NAMED in the scene
 * (or marked present), pull the connected entries that DIDN'T already match
 * lexically — surfacing "what this person is entangled in" even when the scene
 * text doesn't mention it. One hop, bounded, lowest priority (leftover budget).
 * `excludeIds` are the ids already injected by lexical recall (no dupes). */
function buildGraphRecall(ch, query, excludeIds, opts) {
  const o = opts || {};
  const budget = Number.isFinite(o.budgetChars) ? o.budgetChars : INJECT_BUDGET.graph;
  const exclude = new Set(excludeIds || []);
  const qtokens = uniqTokens(recallTokens(query || ''));
  const qphrase = normForPhrase(query || '');
  if (qtokens.length < 2) return { lines: [], trace: [], ids: [] };

  // Anchor characters: present + scene-named (cap a few so the hop stays tight).
  const cast = ch.cast || {};
  const presentIds = new Set(ch.presentIds || []);
  const kin = kinTokens(ch);
  const anchors = [];
  for (const k of Object.keys(cast)) {
    const c = cast[k];
    const present = presentIds.has(c.id);
    const sig = nameSignal(c, qtokens, qphrase, kin);
    // Anchor on present cast, or any character distinctly named in the scene
    // (full name = 6, a distinctive first-name/alias token = 3).
    if (present || sig >= 3) anchors.push({ c, strength: present ? 100 : sig });
  }
  anchors.sort((a, b) => b.strength - a.strength);
  const top = anchors.slice(0, 3);
  if (!top.length) return { lines: [], trace: [], ids: [] };

  // Does an entry's text reference an anchor by name/alias?
  const mentionsAnchor = (text, c) => {
    const p = normForPhrase(text || '');
    const full = normForPhrase(c.name).trim();
    if (full.length >= 3 && p.includes(' ' + full + ' ')) return true;
    const toks = recallTokens(c.name).filter((t) => t.length >= 3 && !new Set(['the','a','ser','lord','lady','king','queen','prince','princess']).has(t) && !kin.has(t));
    const pset = new Set(recallTokens(text || ''));
    for (const t of toks) if (pset.has(t)) return true;
    for (const a of (c.aka || [])) { const at = normForPhrase(a).trim(); if (at.length >= 3 && p.includes(' ' + at + ' ')) return true; }
    return false;
  };
  const dl = (d) => (d ? 'D' + d : '—');
  const cands = [];
  for (const { c } of top) {
    Object.values(ch.arcs || {}).forEach((t) => { const id = 'arc:' + t.id; if (!exclude.has(id) && mentionsAnchor(t.title + ' ' + (t.status || ''), c)) cands.push({ id, kind: 'arc', label: t.title, recent: t.lastTurn || 0, anchor: c.name, line: '◉ ' + t.title + ' [' + dl(t.lastDay) + ']: ' + (t.status || '') }); });
    Object.values(ch.threads || {}).forEach((t) => { const id = 'thread:' + t.id; if (!exclude.has(id) && mentionsAnchor(t.title + ' ' + (t.status || ''), c)) cands.push({ id, kind: 'thread', label: t.title, recent: t.lastTurn || 0, anchor: c.name, line: '🧵 ' + t.title + ' [' + dl(t.lastDay) + ']: ' + (t.status || '') }); });
    (ch.secrets || []).forEach((s) => { if (s.revealed) return; const id = 'secret:' + vhash(s.secret); if (exclude.has(id)) return; if (castKey(s.keeper) === castKey(c.name) || mentionsAnchor(s.keeper + ' ' + (s.from || ''), c)) cands.push({ id, kind: 'secret', label: s.secret.slice(0, 40), recent: s.lastTurn || 0, anchor: c.name, line: '⚿ ' + s.keeper + ' hides from ' + (s.from || 'others') + ': ' + s.secret + ' [' + s.danger + ']' }); });
    (ch.knowledge || []).forEach((k) => { const id = 'know:' + vhash(k.who + k.fact); if (exclude.has(id)) return; if (castKey(k.who) === castKey(c.name)) { let tag = k.reliability === 'wrong' ? 'WRONGLY believes' : k.reliability === 'unaware' ? 'does NOT know' : k.reliability; cands.push({ id, kind: 'knowledge', label: k.fact.slice(0, 40), recent: k.lastTurn || 0, anchor: c.name, line: '◇ ' + k.who + ' ' + tag + ': ' + k.fact }); } });
    // Relations: surface bonds tied to the scene-present character (the unique
    // continuity win — "Cersei is Daeron's betrothed" even if unsaid this turn).
    (ch.relations || []).forEach((r) => {
      const id = 'rel:' + r.id;
      if (exclude.has(id)) return;
      if (r.a !== c.id && r.b !== c.id) return;
      const other = r.a === c.id ? r.b : r.a;
      const om = ch.cast[other];
      const oName = om ? om.name : other;
      const lbl = r.label ? (c.name + ' \u2014 ' + r.label) : (c.name + ' \u2194 ' + oName);
      const tags = [r.category]; if (r.sentiment && r.sentiment !== 'neutral') tags.push(r.sentiment); if (r.status && r.status !== 'active') tags.push(r.status);
      cands.push({ id, kind: 'relation', label: (r.label || (c.name + '/' + oName)).slice(0, 40), recent: r.lastTurn || 0, anchor: c.name, line: '\u21ce ' + lbl + ' (' + tags.join(', ') + ')' });
    });
  }
  // dedupe by id, prefer most-recent, then pack to budget
  const seen = new Set();
  const uniq = [];
  cands.sort((a, b) => (b.recent || 0) - (a.recent || 0));
  for (const c of cands) { if (seen.has(c.id)) continue; seen.add(c.id); uniq.push(c); }
  const lines = [], trace = [], ids = [];
  let used = 0;
  for (const c of uniq) {
    if (lines.length >= 6) break;
    if (used + c.line.length + 1 > budget) continue;
    lines.push(c.line); ids.push(c.id);
    trace.push({ id: c.id, kind: c.kind, label: c.label, score: '↔', why: 'connected to ' + c.anchor + ' (in scene)' });
    used += c.line.length + 1;
  }
  return { lines, trace, ids };
}

// How strongly the SCENE names this character (not just shares a common word).
// Full-name phrase in scene = strong; an alias/first-name token hit = moderate.
function nameSignal(c, qtokens, qphrase, kin) {
  const KIN = kin || NAME_SURNAMES;
  let s = 0;
  const full = normForPhrase(c.name).trim();
  if (full.length >= 3 && qphrase.includes(' ' + full + ' ')) s += 6;       // exact full name in scene
  // distinctive name tokens (skip generic titles AND shared kin tokens — a lone
  // "Targaryen"/"Lannister"/any-shared-name must NOT flag every kin as "named").
  const GENERIC = new Set(['the', 'a', 'an', 'ser', 'lord', 'lady', 'king', 'queen', 'prince', 'princess', 'maester', 'septa', 'septon', 'man', 'woman', 'girl', 'boy', 'guard', 'soldier', 'stranger']);
  const ntoks = recallTokens(c.name).filter((t) => t.length >= 3 && !GENERIC.has(t) && !KIN.has(t));
  const qset = new Set(qtokens);
  for (const t of ntoks) if (qset.has(t)) s += 3;                            // a distinctive given-name token in scene
  // If the character only shares a KIN token with the scene (no given-name/full
  // match), give a tiny nudge — not enough to read as "named".
  if (s === 0) {
    const sur = recallTokens(c.name).filter((t) => KIN.has(t));
    for (const t of sur) if (qset.has(t)) { s += 0.5; break; }
  }
  for (const a of (c.aka || [])) {
    const at = normForPhrase(a).trim();
    if (at.length >= 3 && qphrase.includes(' ' + at + ' ')) { s += 4; break; }
  }
  // Content-derived aliases (#5): role descriptors / epithets mined from the
  // character's role/appearance. A weaker signal than an explicit aka, but
  // catches "the kingslayer" / "her twin" when the name itself isn't said.
  for (const a of (c.derivedAka || [])) {
    const at = normForPhrase(a).trim();
    if (at.length >= 4 && qphrase.includes(' ' + at + ' ')) { s += 3; break; }
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
  maxMemories: 0,     // ring-buffer cap (0 = unlimited; file-backed storage)
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

const SUMMARY_SYS = 'You are a story archivist compressing a roleplay excerpt into one dense, factual chapter-memory for long-term recall AND indexing it for retrieval. Output STRICT JSON only, no prose outside it: {"summary":"3-6 tight past-tense sentences covering EVERYTHING that matters from the excerpt — who was involved, where, key actions, decisions, revelations, emotional turns, and what changed by the end; pack facts, drop atmosphere and filler","title":"a 3-6 word chapter title","keywords":["8-14 lowercase names/places/objects/topics a future scene might key on"],"characters":["exact names of every character involved"],"location":"primary place, short","topics":["3-8 lowercase themes/motifs/recurring-things this chapter is about, e.g. \\"pet name\\", \\"the betrothal\\", \\"the hidden dragon\\""],"plots":["1-4 plot threads/arcs this chapter advances, short labels"],"stakes":"one clause: what is at risk or changing","day":<integer story-day if stated else null>}. Rules: ALWAYS use the real character names provided — never write "{{user}}", "User", "{{char}}", or "you"; be comprehensive but compact (no repetition, no vibes); every distinct beat must be recoverable from the summary; topics should capture SPECIFIC recurring things (a pet name, an object, a promise) a future scene might echo, not generic words.';

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
  const lowList = (v, n) => Array.isArray(v) ? v.map((k) => String(k).toLowerCase().trim()).filter(Boolean).slice(0, n) : [];
  const strList = (v, n) => Array.isArray(v) ? v.map((k) => String(k).trim()).filter(Boolean).slice(0, n) : [];
  const day = Number.isFinite(obj.day) ? obj.day : null;
  return {
    summary: summary.slice(0, SUMMARY.maxChars),
    title: String(obj.title || '').trim().slice(0, 60),
    keywords: lowList(obj.keywords, 14),
    characters: strList(obj.characters, 12),
    location: String(obj.location || '').trim().slice(0, 60),
    topics: lowList(obj.topics, 8),
    plots: strList(obj.plots, 4),
    stakes: String(obj.stakes || '').trim().slice(0, 120),
    day,
  };
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
    title: parsed.title || '',
    keywords: parsed.keywords,
    characters: parsed.characters || [],
    location: parsed.location || '',
    topics: parsed.topics || [],
    plots: parsed.plots || [],
    stakes: parsed.stakes || '',
  });
  if (SUMMARY.maxMemories && ch.memories.length > SUMMARY.maxMemories) ch.memories.shift();
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

const CAST_SYS = 'You are a meticulous story-bible archivist reading a roleplay transcript. Extract EVERY named or distinctly-referenced character (including those only spoken about, and including the human player\u2019s own character), AND the relationships between them. For each, infer details from the WHOLE excerpt, not one line. Output STRICT JSON only: {"characters":[{"name":"Canonical Full Name","aka":["other names/nicknames/titles used"],"age":"e.g. 32 / mid-30s / unknown","appearance":"distinguishing looks, terse","role":"their function/relationship in the story","mentioned_only":true|false}],"relations":[{"a":"Character A (exact name)","b":"Character B (exact name)","label":"how A relates to B, from A\u2019s side, e.g. \\"Tywin\u2019s daughter\\" / \\"betrothed to Daeron\\"","category":"familial|romantic|alliance|rivalry|social|neutral","status":"active|past|broken|secret","sentiment":"warm|strained|hostile|complex|neutral"}]}. Rules: ALWAYS use the real names given to you \u2014 never output "{{user}}", "User", "{{char}}", or "you" as a name; pick the fullest form as the canonical name and list shorter spellings/nicknames/titles in aka; set mentioned_only=true only if they never appear or act on-page; keep age/appearance/role under ~14 words. For relations: only between NAMED characters; status=past for former/dissolved bonds (e.g. "once considered for betrothal" = neutral + past); category=neutral for faded or hypothetical links; never invent unsupported details (use "unknown"); merge obvious duplicates. No prose outside the JSON.';

function parseCastJson(text) {
  let t = String(text || '').replace(/<think[\s\S]*?<\/think>/gi, '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  let obj = null;
  try { obj = JSON.parse(t); } catch (e) {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch (e2) { obj = null; } }
  }
  if (!obj || !Array.isArray(obj.characters)) return null;
  const list = obj.characters.map((c) => ({
    name: String(c.name || '').trim().slice(0, 60),
    aka: Array.isArray(c.aka) ? c.aka.map((a) => String(a).trim()).filter(Boolean).slice(0, 8) : [],
    age: String(c.age || '').trim().slice(0, 40),
    appearance: String(c.appearance || '').trim().slice(0, 120),
    role: String(c.role || '').trim().slice(0, 120),
    mentionedOnly: !!c.mentioned_only,
  })).filter((c) => c.name && /[a-z]/i.test(c.name));
  // Relations ride alongside the character list (parsed from the same JSON).
  list._relations = Array.isArray(obj.relations) ? obj.relations.map((r) => ({
    a: String(r.a || '').trim().slice(0, 60),
    b: String(r.b || '').trim().slice(0, 60),
    label: String(r.label || '').trim().slice(0, 120),
    category: String(r.category || 'neutral').trim().toLowerCase(),
    status: String(r.status || 'active').trim().toLowerCase(),
    sentiment: String(r.sentiment || 'neutral').trim().toLowerCase(),
  })).filter((r) => r.a && r.b) : [];
  return list;
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
    // Skip unnamed / incidental figures ("a servant", "the guard") unless they
    // resolve to the player or main character.
    if (isIncidentalName(c.name) && !(nc && (c.name === nc.user || c.name === nc.char))) continue;
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
    if (touched) { refreshDerivedAliases(m); enriched++; }
  }
  // Fold any relations the scan produced (rides on list._relations).
  const relAdded = applyRelations(ch, list && list._relations, nc);
  return { added, enriched, relations: relAdded };
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
function applyMemList(ch, list, nc, opts) {
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
    // No cap — per-character memory journal is unlimited (file-backed storage).
    added++;
    if (opts && opts.pulse) pushPulse(ch, { kind: 'memory', icon: '\uD83D\uDCD6', who: (m ? m.name : e.who), text: (m ? m.name : e.who) + ' \u2014 ' + e.memory, weight: e.weight });
  }
  return added;
}

// ---- KNOWLEDGE / SECRETS: who knows / believes / suspects what (dramatic irony) ----
const KNOW_SYS = 'You are a continuity analyst mapping the INFORMATION STATE of a roleplay \u2014 the engine of dramatic irony. From the whole transcript, extract (a) notable knowledge each character holds and (b) secrets being kept. Output STRICT JSON only: {"knowledge":[{"who":"exact character name","fact":"the thing, one clause","reliability":"knows|believes|suspects|wrong|unaware","truth":"true|false|unknown","source":"how they got it, brief"}],"secrets":[{"secret":"the concealed thing, one clause","keeper":"exact name of who hides it","from":"exact name(s) of who it is hidden from","method":"lie|omission|misdirection|disguise","exposure":"how it might surface, brief","danger":"minor|major|explosive"}]}. Rules: ALWAYS use the real character names given to you \u2014 never write "{{user}}", "User", "{{char}}", or "you". ONLY attribute knowledge or secrets to NAMED, significant characters (named persons or clearly recurring figures). NEVER use an unnamed/incidental figure as a who/keeper/from \u2014 skip descriptions like "a servant", "a guard", "a maid with linens", "the crowd", "someone", "a stranger"; if the only holder of a fact is unnamed and incidental, omit that entry entirely. Focus on facts that create tension or irony (someone believes something false, someone hides something, asymmetric knowledge); reliability=wrong means they believe something untrue; truth is the actual state regardless of belief; never invent \u2014 only what the text supports; up to ~12 knowledge + ~8 secrets, the most dramatically charged. No prose outside the JSON.';

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
// Relation signature: unordered pair + category, so "A↔B familial" dedupes
// regardless of which side is `a`, and a familial vs romantic bond between the
// same two people are distinct edges.
function relSig(aId, bId, category) {
  const pair = [String(aId || ''), String(bId || '')].sort().join('|');
  return (pair + '|' + String(category || '')).toLowerCase().slice(0, 160);
}

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

﻿const LIVING_SYS = "You are the living-state tracker for an ongoing roleplay. Read the RECENT excerpt and report ONLY what CHANGED or is newly revealed in it \u2014 not the whole history. Output STRICT JSON only: {\"relations\":[{\"a\":\"Name\",\"b\":\"Name\",\"dAffection\":<int -40..40>,\"dTrust\":<int -40..40>,\"reason\":\"why, one clause\"}],\"knowledge\":[{\"who\":\"Name\",\"fact\":\"one clause\",\"reliability\":\"knows|believes|suspects|wrong|unaware\",\"truth\":\"true|false|unknown\",\"source\":\"brief\"}],\"secrets\":[{\"secret\":\"one clause\",\"keeper\":\"Name\",\"from\":\"Name(s)\",\"method\":\"lie|omission|misdirection|disguise\",\"exposure\":\"brief\",\"danger\":\"minor|major|explosive\"}],\"memories\":[{\"who\":\"Name\",\"about\":\"Name\",\"memory\":\"one vivid sentence in their POV\",\"kind\":\"interaction|promise|betrayal|gift|shared|wound|observation\",\"weight\":\"trivial|minor|significant|defining\",\"sentiment\":\"positive|negative|neutral|complex\"}]}. Rules: use ONLY the real names provided \u2014 never placeholders; only NAMED significant characters. relations: dAffection/dTrust are the CHANGE this excerpt caused to how A feels about B, positive for warming/earning trust, negative for hurt/betrayal, 0 if unchanged \u2014 omit pairs with no change. Only report knowledge/secrets/memories that are NEW in this excerpt. Keep every list short. If nothing changed, return empty arrays. No prose outside the JSON.";
function parseLivingJson(text) {
  let t = String(text || "").replace(/<think[\s\S]*?<\/think>/gi, "").replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  let obj = null;
  try { obj = JSON.parse(t); } catch (e) { const m = t.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch (e2) { obj = null; } } }
  if (!obj) return null;
  return {
    relations: Array.isArray(obj.relations) ? obj.relations : [],
    knowledge: Array.isArray(obj.knowledge) ? obj.knowledge : [],
    secrets: Array.isArray(obj.secrets) ? obj.secrets : [],
    memories: Array.isArray(obj.memories) ? obj.memories : [],
  };
}
﻿
// Apply scored relation deltas from the living pass. Resolves names, creates the
// edge if missing, applies the delta, pulses on a sentiment change or big swing.
function applyLivingRelations(ch, list, nc) {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  const turn = ch.turns || 0;
  for (const d of list) {
    const a = canonName(d.a || d.from || d.subject, nc);
    const b = canonName(d.b || d.to || d.other, nc);
    const ma = resolveOrAddCast(ch, a), mb = resolveOrAddCast(ch, b);
    if (!ma || !mb || ma.id === mb.id) continue;
    const dAff = Math.max(-40, Math.min(40, Number(d.dAffection) || 0));
    const dTr = Math.max(-40, Math.min(40, Number(d.dTrust) || 0));
    if (!dAff && !dTr) continue;
    // find any existing edge between the pair (ignore category), else create one
    let r = ch.relations.find((x) => (x.a === ma.id && x.b === mb.id) || (x.a === mb.id && x.b === ma.id));
    if (!r) {
      r = relationAdd(ch, { a, b, category: 'neutral', sentiment: 'neutral' }, { source: 'auto' });
      if (!r) continue;
    }
    if (r.userEdited && r.lockScores) continue; // respect a user who pinned scores
    // orient the delta to the stored edge direction (a feels about b)
    const flip = (r.a === mb.id && r.b === ma.id);
    const res = applyRelDelta(r, flip ? dAff : dAff, flip ? dTr : dTr, d.reason, turn);
    if (res.changed) {
      n++;
      const arrow = (res.after.affection + res.after.trust) >= (res.before.affection + res.before.trust) ? '\u25B2' : '\u25BC';
      const nameA = ch.cast[r.a] ? ch.cast[r.a].name : a;
      const nameB = ch.cast[r.b] ? ch.cast[r.b].name : b;
      const moved = res.before.sentiment !== res.after.sentiment;
      pushPulse(ch, {
        kind: 'relation', icon: arrow,
        who: nameA,
        text: nameA + ' \u2192 ' + nameB + ': ' + (moved ? (res.before.sentiment + ' \u2192 ' + res.after.sentiment + ' ') : '')
          + '(aff ' + (dAff >= 0 ? '+' : '') + dAff + ', trust ' + (dTr >= 0 ? '+' : '') + dTr + ')'
          + (d.reason ? ' \u2014 ' + d.reason : ''),
        relId: r.id, sentiment: res.after.sentiment, big: moved || Math.abs(dAff) + Math.abs(dTr) >= 40,
      });
    }
  }
  return n;
}

// The Living pass: one combined LLM call over the RECENT window that returns
// deltas for relations + new knowledge/secrets/memories. Throttled and gated by
// the per-chat `living` toggle. Runs in the background after a turn.
const livingBusy = new Set();
async function runLivingUpdate(chatId, userId) {
  if (!chatId || livingBusy.has(chatId)) return;
  if (!hasPerm('generation') || !(spindle.generate && (spindle.generate.raw || spindle.generate.quiet))) return;
  livingBusy.add(chatId);
  try {
    const ch = await loadChronicle(chatId);
    if (!ch.living) return;
    let msgs; try { msgs = await readStoredMessages(chatId); } catch (e) { return; }
    if (!msgs || !msgs.length) return;
    const nc = await resolveNameContext(chatId, msgs);
    const turns = assistantTurns(msgs);
    // recent window only — the living pass is about CHANGE, not full history
    const recent = turns.slice(-8);
    const excerpt = sampleHistory(recent, { maxTurns: 8, headN: 1, tailN: 7, charBudget: 9000, nameCtx: nc });
    if (!excerpt.trim()) return;
    // give the model the current relationship scores so deltas are grounded
    let relCtx = '';
    if (ch.relations && ch.relations.length) {
      relCtx = '\n\nCurrent relationship scores (affection/trust, -100..100):\n' + ch.relations.slice(0, 24).map((r) => {
        const na = ch.cast[r.a] ? ch.cast[r.a].name : r.a, nb = ch.cast[r.b] ? ch.cast[r.b].name : r.b;
        return '- ' + na + ' \u2192 ' + nb + ': aff ' + (r.affection || 0) + ', trust ' + (r.trust || 0) + ' (' + r.sentiment + ')';
      }).join('\n');
    }
    const sys = LIVING_SYS + (namesBlock(nc) ? ('\n\n' + namesBlock(nc)).trimEnd() : '');
    let raw = '';
    try { raw = await internalGenerate([{ role: 'system', content: sys }, { role: 'user', content: 'Recent excerpt:\n\n' + excerpt + relCtx }], { temperature: 0.2, max_tokens: 1600 }, userId); }
    catch (e) { spindle.log.warn('[vellum_tracker] living gen: ' + (e && e.message)); return; }
    const res = parseLivingJson(raw);
    if (!res) return;
    const before = (ch.pulse || []).length;
    const rN = applyLivingRelations(ch, res.relations, nc);
    const kr = applyKnowResult(ch, { knowledge: res.knowledge || [], secrets: res.secrets || [] }, nc, { pulse: true });
    const mN = applyMemList(ch, res.memories || [], nc, { pulse: true });
    const newPulses = (ch.pulse || []).slice(before);
    if (rN || kr.addedK || kr.addedS || mN || newPulses.length) {
      await saveChronicle(chatId, ch);
      broadcastChronicle(chatId, ch, userId);
      if (newPulses.length) spindle.sendToFrontend({ type: 'vellum_pulse', chatId, events: newPulses, unseen: unseenPulse(ch) }, userId);
      spindle.log.info('[vellum_tracker] living: +' + rN + ' rel, +' + kr.addedK + 'k/' + kr.addedS + 's, +' + mN + ' mem');
    }
  } catch (err) {
    spindle.log.warn('[vellum_tracker] runLivingUpdate: ' + (err && err.message));
  } finally { livingBusy.delete(chatId); }
}

// Fold a parsed knowledge/secrets result into the chronicle. Returns counts.
function applyKnowResult(ch, res, nc, opts) {
  if (!Array.isArray(ch.knowledge)) ch.knowledge = [];
  if (!Array.isArray(ch.secrets)) ch.secrets = [];
  const turnNow = ch.turns || 0;
  let addedK = 0, addedS = 0;
  for (const k of res.knowledge) {
    k.who = canonName(k.who, nc);
    k.fact = applyNamesToText(k.fact, nc);
    if (!k.who || !k.fact) continue;
    if (isIncidentalName(k.who) && !(nc && (k.who === nc.user || k.who === nc.char))) continue; // skip unnamed/incidental holders
    const sig = knowSig(k);
    if (isTombstoned(ch, 'know', sig)) continue; // user deleted — don't resurrect
    const ex = ch.knowledge.find((x) => knowSig(x) === sig);
    if (ex) { if (ex.userEdited) continue; ex.reliability = k.reliability; ex.truth = k.truth; if (k.source) ex.source = k.source; ex.lastTurn = turnNow; continue; }
    ch.knowledge.push(Object.assign({ turn: turnNow, lastTurn: turnNow }, k));
    addedK++;
    if (opts && opts.pulse) pushPulse(ch, { kind: 'knowledge', icon: '\u25C7', who: k.who, text: k.who + ' ' + (k.reliability === 'wrong' ? 'wrongly believes' : k.reliability) + ': ' + k.fact });
  }
  for (const s of res.secrets) {
    s.keeper = canonName(s.keeper, nc);
    s.from = (s.from || '').split(/\s*(?:,|;|\band\b|\/)\s*/).map((p) => canonName(p, nc)).filter(Boolean).join(', ');
    s.secret = applyNamesToText(s.secret, nc);
    if (s.exposure) s.exposure = applyNamesToText(s.exposure, nc);
    if (!s.secret) continue;
    if (isIncidentalName(s.keeper) && !(nc && (s.keeper === nc.user || s.keeper === nc.char))) continue; // skip unnamed/incidental keepers
    const sig = secSig(s);
    if (isTombstoned(ch, 'sec', sig)) continue; // user deleted — don't resurrect
    const ex = ch.secrets.find((x) => secSig(x) === sig);
    if (ex) { if (ex.userEdited) continue; ex.danger = s.danger; if (s.exposure) ex.exposure = s.exposure; ex.lastTurn = turnNow; continue; }
    ch.secrets.push(Object.assign({ turn: turnNow, lastTurn: turnNow, revealed: false }, s));
    addedS++;
    if (opts && opts.pulse) pushPulse(ch, { kind: 'secret', icon: '\u26BF', who: s.keeper, text: s.keeper + ' hides from ' + (s.from || 'others') + ': ' + s.secret + ' [' + s.danger + ']' });
  }
  // No cap — knowledge & secrets are unlimited (file-backed storage).
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
  refreshDerivedAliases(m);
  return m;
}

/* ============================================================================
 * MANUAL CRUD for arcs, threads, events, shifts, knowledge, secrets,
 * memory-journal entries, and chapter memories. Every chronicle data type gets
 * add / edit / delete. Edits set a `userEdited` flag so future auto-scans don't
 * overwrite them; deletes record a tombstone where one exists so re-import /
 * re-scan never resurrects them. All operate by stable id.
 * ========================================================================== */

// ---- arcs & threads (tracks) ----
function trackAdd(ch, group, title, status) {
  const map = group === 'thread' ? (ch.threads || (ch.threads = {})) : (ch.arcs || (ch.arcs = {}));
  const t = String(title || '').trim();
  if (!t) return null;
  const key = normKey(t) || vid('tk');
  const turn = ch.turns || 0;
  if (!map[key]) map[key] = { id: key, title: t, firstTurn: turn, firstDay: ch.lastDay, lastTurn: turn, lastDay: ch.lastDay, status: '', history: [], source: 'user' };
  const m = map[key];
  m.title = t;
  const st = String(status || '').trim();
  if (st && (!m.history.length || m.history[m.history.length - 1].status !== st)) m.history.push({ turn, day: ch.lastDay, status: st });
  if (st) m.status = st;
  m.userEdited = true;
  return m;
}
function trackEdit(ch, group, id, title, status) {
  const map = group === 'thread' ? ch.threads : ch.arcs;
  const m = map && map[id];
  if (!m) return null;
  if (typeof title === 'string' && title.trim()) m.title = title.trim().slice(0, 200);
  if (typeof status === 'string') {
    m.status = status.trim().slice(0, 400);
    const turn = ch.turns || 0;
    m.history.push({ turn, day: ch.lastDay, status: m.status });
    m.lastTurn = turn; m.lastDay = ch.lastDay;
  }
  m.userEdited = true;
  return m;
}
function trackDelete(ch, group, id) {
  const map = group === 'thread' ? ch.threads : ch.arcs;
  if (map && map[id]) { delete map[id]; return true; }
  return false;
}

// ---- events & shifts (logs) ----
function logAdd(ch, kind, text, day) {
  const arr = kind === 'shift' ? (ch.shifts || (ch.shifts = [])) : (ch.events || (ch.events = []));
  const t = String(text || '').trim();
  if (!t) return null;
  const entry = { id: vid(kind === 'shift' ? 'sh' : 'ev'), turn: ch.turns || 0, day: Number.isFinite(day) ? day : (ch.lastDay || 1), text: t, source: 'user' };
  arr.push(entry);
  return entry;
}
function logEdit(ch, kind, id, text, day) {
  const arr = kind === 'shift' ? ch.shifts : ch.events;
  const e = Array.isArray(arr) && arr.find((x) => x.id === id);
  if (!e) return null;
  if (typeof text === 'string' && text.trim()) e.text = text.trim().slice(0, 600);
  if (Number.isFinite(day)) e.day = day;
  e.userEdited = true;
  return e;
}
function logDelete(ch, kind, id) {
  const key = kind === 'shift' ? 'shifts' : 'events';
  if (!Array.isArray(ch[key])) return false;
  const i = ch[key].findIndex((x) => x.id === id);
  if (i < 0) return false;
  ch[key].splice(i, 1);
  return true;
}

// ---- knowledge & secrets ----
function knowledgeAdd(ch, input) {
  if (!Array.isArray(ch.knowledge)) ch.knowledge = [];
  const who = String(input.who || '').trim(), fact = String(input.fact || '').trim();
  if (!who || !fact) return null;
  const REL = new Set(['knows', 'believes', 'suspects', 'wrong', 'unaware']);
  const e = { id: vid('kn'), who: who.slice(0, 60), fact: fact.slice(0, 240), reliability: REL.has(input.reliability) ? input.reliability : 'knows', truth: ['true', 'false', 'unknown'].includes(input.truth) ? input.truth : 'unknown', source: String(input.source || '').slice(0, 120), turn: ch.turns || 0, lastTurn: ch.turns || 0, userEdited: true };
  ch.knowledge.push(e);
  return e;
}
function knowledgeEditEntry(ch, id, input) {
  const e = Array.isArray(ch.knowledge) && ch.knowledge.find((x) => x.id === id);
  if (!e) return null;
  if (typeof input.who === 'string' && input.who.trim()) e.who = input.who.trim().slice(0, 60);
  if (typeof input.fact === 'string' && input.fact.trim()) e.fact = input.fact.trim().slice(0, 240);
  if (['knows', 'believes', 'suspects', 'wrong', 'unaware'].includes(input.reliability)) e.reliability = input.reliability;
  if (['true', 'false', 'unknown'].includes(input.truth)) e.truth = input.truth;
  if (typeof input.source === 'string') e.source = input.source.slice(0, 120);
  e.userEdited = true;
  return e;
}
function secretAdd(ch, input) {
  if (!Array.isArray(ch.secrets)) ch.secrets = [];
  const secret = String(input.secret || '').trim(), keeper = String(input.keeper || '').trim();
  if (!secret || !keeper) return null;
  const DG = new Set(['minor', 'major', 'explosive']);
  const e = { id: vid('sc'), secret: secret.slice(0, 240), keeper: keeper.slice(0, 60), from: String(input.from || '').slice(0, 120), method: String(input.method || 'omission').slice(0, 30), exposure: String(input.exposure || '').slice(0, 160), danger: DG.has(input.danger) ? input.danger : 'major', revealed: false, turn: ch.turns || 0, lastTurn: ch.turns || 0, userEdited: true };
  ch.secrets.push(e);
  return e;
}
function secretEditEntry(ch, id, input) {
  const e = Array.isArray(ch.secrets) && ch.secrets.find((x) => x.id === id);
  if (!e) return null;
  if (typeof input.secret === 'string' && input.secret.trim()) e.secret = input.secret.trim().slice(0, 240);
  if (typeof input.keeper === 'string' && input.keeper.trim()) e.keeper = input.keeper.trim().slice(0, 60);
  if (typeof input.from === 'string') e.from = input.from.slice(0, 120);
  if (typeof input.exposure === 'string') e.exposure = input.exposure.slice(0, 160);
  if (['minor', 'major', 'explosive'].includes(input.danger)) e.danger = input.danger;
  if (typeof input.revealed === 'boolean') e.revealed = input.revealed;
  e.userEdited = true;
  return e;
}

// ---- memory journal entries ----
function memJournalAdd(ch, input) {
  if (!ch.memJournal) ch.memJournal = {};
  const who = String(input.who || '').trim(), memory = String(input.memory || '').trim();
  if (!who || !memory) return null;
  const m = findCastMember(ch, who);
  const key = m ? m.id : castKey(who);
  if (!key) return null;
  if (!ch.memJournal[key]) ch.memJournal[key] = { name: m ? m.name : who, entries: [] };
  const W = new Set(['trivial', 'minor', 'significant', 'defining']);
  const S = new Set(['positive', 'negative', 'neutral', 'complex']);
  const e = { id: vid('mj'), about: String(input.about || '').slice(0, 60), memory: memory.slice(0, 400), kind: String(input.kind || 'interaction').slice(0, 20), weight: W.has(input.weight) ? input.weight : 'minor', sentiment: S.has(input.sentiment) ? input.sentiment : 'neutral', day: Number.isFinite(input.day) ? input.day : null, turn: ch.turns || 0, userEdited: true };
  ch.memJournal[key].entries.push(e);
  return { key, entry: e };
}
function memJournalEdit(ch, charKey, id, input) {
  const bucket = ch.memJournal && ch.memJournal[charKey];
  const e = bucket && (bucket.entries || []).find((x) => x.id === id);
  if (!e) return null;
  if (typeof input.memory === 'string' && input.memory.trim()) e.memory = input.memory.trim().slice(0, 400);
  if (typeof input.about === 'string') e.about = input.about.slice(0, 60);
  if (['trivial', 'minor', 'significant', 'defining'].includes(input.weight)) e.weight = input.weight;
  if (['positive', 'negative', 'neutral', 'complex'].includes(input.sentiment)) e.sentiment = input.sentiment;
  if (typeof input.kind === 'string') e.kind = input.kind.slice(0, 20);
  e.userEdited = true;
  return e;
}

// ---- chapter memories (manual add; edit/delete already exist) ----
function chapterMemoryAdd(ch, input) {
  if (!Array.isArray(ch.memories)) ch.memories = [];
  const text = String(input.text || '').trim();
  if (!text) return null;
  const kw = Array.isArray(input.keywords) ? input.keywords : String(input.keywords || '').split(/[,;]/);
  const e = { id: vid('m'), fromTurn: null, toTurn: null, day: Number.isFinite(input.day) ? input.day : null, text: text.slice(0, 2000), keywords: kw.map((k) => String(k).toLowerCase().trim()).filter(Boolean).slice(0, 14), userAdded: true, edited: true };
  ch.memories.push(e);
  return e;
}

/* ============================================================================
 * RELATIONS — edges between cast members ("Cersei is Tywin's daughter").
 * Stored once as ch.relations = [{ id, a, b, label, category, status,
 * sentiment, source, ... }] where a/b are canonical cast ids. The label is
 * written from a's perspective; the reverse view renders the raw edge rather
 * than auto-inverting the wording (siblings/in-laws make inversion unreliable).
 * ========================================================================== */
const REL_CATEGORIES = new Set(['familial', 'romantic', 'alliance', 'rivalry', 'social', 'neutral']);
const REL_STATUS = new Set(['active', 'past', 'broken', 'secret']);
const REL_SENTIMENT = new Set(['warm', 'strained', 'hostile', 'complex', 'neutral']);

/* --- Relation scoring: two axes, each -100..+100 ---------------------------
 * affection = warmth/liking (love .. hatred)
 * trust     = reliance/faith (trusts .. betrayed/wary)
 * The textual `sentiment` is DERIVED from the pair, so it self-updates as the
 * scores move. Two axes (not one) capture nuance a single bar can't:
 *   high aff + low trust  = infatuated but wary  -> complex
 *   low aff  + high trust = respected adversary  -> complex
 * Relations also decay slowly toward neutral each turn when not reinforced. */
const REL_CLAMP = (n) => Math.max(-100, Math.min(100, Math.round(Number(n) || 0)));
function deriveSentiment(affection, trust) {
  const a = REL_CLAMP(affection), t = REL_CLAMP(trust);
  const mag = Math.max(Math.abs(a), Math.abs(t));
  if (mag < 12) return 'neutral';
  // strong disagreement between the two axes reads as complex
  if (Math.abs(a - t) >= 70) return 'complex';
  const avg = (a + t) / 2;
  if (avg >= 45) return 'warm';
  if (avg <= -45) return 'hostile';
  if (avg < 0) return 'strained';
  if (a >= 25 && t >= 25) return 'warm';
  return 'complex';
}
// Map a legacy textual sentiment to seed scores (for migration).
function sentimentToScores(s) {
  switch (s) {
    case 'warm': return { affection: 55, trust: 50 };
    case 'hostile': return { affection: -60, trust: -55 };
    case 'strained': return { affection: -25, trust: -20 };
    case 'complex': return { affection: 30, trust: -30 };
    default: return { affection: 0, trust: 0 };
  }
}
// Ensure a relation has numeric axes + history (migrates old text-only edges).
function ensureRelScores(r) {
  if (typeof r.affection !== 'number' || typeof r.trust !== 'number') {
    const seed = sentimentToScores(r.sentiment);
    if (typeof r.affection !== 'number') r.affection = seed.affection;
    if (typeof r.trust !== 'number') r.trust = seed.trust;
  }
  r.affection = REL_CLAMP(r.affection); r.trust = REL_CLAMP(r.trust);
  if (!Array.isArray(r.history)) r.history = [];
  r.sentiment = deriveSentiment(r.affection, r.trust);
  return r;
}
// Apply a scored delta to a relation; records history + re-derives sentiment.
// Returns { before, after, changed } for notifications.
function applyRelDelta(r, dAff, dTrust, reason, turn) {
  ensureRelScores(r);
  const before = { affection: r.affection, trust: r.trust, sentiment: r.sentiment };
  r.affection = REL_CLAMP(r.affection + (Number(dAff) || 0));
  r.trust = REL_CLAMP(r.trust + (Number(dTrust) || 0));
  r.sentiment = deriveSentiment(r.affection, r.trust);
  r.lastTurn = turn;
  if (Number(dAff) || Number(dTrust)) {
    r.history.push({ turn, affection: r.affection, trust: r.trust, reason: String(reason || '').slice(0, 120) });
    if (r.history.length > 60) r.history.shift();
  }
  const changed = before.affection !== r.affection || before.trust !== r.trust;
  return { before, after: { affection: r.affection, trust: r.trust, sentiment: r.sentiment }, changed };
}
// Gentle per-turn decay toward neutral for relations not touched this turn.
function decayRelations(ch, turn) {
  for (const r of (ch.relations || [])) {
    if (r.userEdited && r.lockScores) continue;
    if (r.lastTurn === turn) continue;
    ensureRelScores(r);
    const pull = (v) => { if (v > 0) return Math.max(0, v - Math.max(1, Math.round(v * 0.02))); if (v < 0) return Math.min(0, v + Math.max(1, Math.round(Math.abs(v) * 0.02))); return 0; };
    r.affection = pull(r.affection); r.trust = pull(r.trust);
    r.sentiment = deriveSentiment(r.affection, r.trust);
  }
}

/* --- Pulse: the activity log + notification feed ---------------------------
 * Every meaningful auto-change (knowledge learned, secret formed/revealed,
 * relationship shift, memory recorded) appends a pulse event. It persists on
 * the chronicle (survives reload), drives the in-window toast + Pulse tab, and
 * is emitted live to the frontend. Bounded ring buffer. */
const PULSE_CAP = 200;
function pushPulse(ch, ev) {
  if (!Array.isArray(ch.pulse)) ch.pulse = [];
  const e = Object.assign({ id: vid('p'), turn: ch.turns || 0, day: ch.lastDay || 1, at: Date.now() }, ev);
  ch.pulse.push(e);
  if (ch.pulse.length > PULSE_CAP) {
    const over = ch.pulse.length - PULSE_CAP;
    ch.pulse.splice(0, over);
    ch.pulseSeen = Math.max(0, (ch.pulseSeen || 0) - over);
  }
  return e;
}
function unseenPulse(ch) { return Math.max(0, (ch.pulse ? ch.pulse.length : 0) - (ch.pulseSeen || 0)); }

// Resolve a name to a cast id, creating a lightweight 'mentioned' card if the
// person isn't tracked yet (so a relation can name someone off-page). Returns
// null for blank/incidental names.
function resolveOrAddCast(ch, name) {
  const n = String(name || '').trim();
  if (!n || castKey(n).length < 2) return null;
  if (isIncidentalName(n)) return null;
  let m = findCastMember(ch, n);
  if (!m) {
    const key = castKey(n);
    m = ch.cast[key] = { id: key, name: n, aka: [], source: 'auto', status: 'mentioned', age: '', appearance: '', role: '', note: '', firstTurn: ch.turns || 0, lastTurn: ch.turns || 0, firstDay: ch.lastDay, lastDay: ch.lastDay };
  }
  return m;
}

function relationAdd(ch, input, opts) {
  if (!Array.isArray(ch.relations)) ch.relations = [];
  const o = opts || {};
  const aName = input.a || input.from || input.subject;
  const bName = input.b || input.to || input.other;
  const ma = resolveOrAddCast(ch, aName);
  const mb = resolveOrAddCast(ch, bName);
  if (!ma || !mb || ma.id === mb.id) return null;
  const category = REL_CATEGORIES.has(input.category) ? input.category : 'neutral';
  const sig = relSig(ma.id, mb.id, category);
  if (o.respectTombstone !== false && isTombstoned(ch, 'rel', sig)) return null; // user deleted — don't resurrect
  const existing = ch.relations.find((r) => relSig(r.a, r.b, r.category) === sig);
  const turn = ch.turns || 0;
  if (existing) {
    if (existing.userEdited && o.source !== 'user') return existing; // protect manual edits from auto
    // Keep the first-seen label/perspective on auto-fold (avoids "A's daughter"
    // flipping to "father of A" when the reverse edge is seen); manual always sets.
    if (input.label && (o.source === 'user' || !existing.label)) existing.label = String(input.label).slice(0, 120);
    if (REL_STATUS.has(input.status)) existing.status = input.status;
    if (REL_SENTIMENT.has(input.sentiment)) existing.sentiment = input.sentiment;
    existing.lastTurn = turn;
    if (o.source === 'user') existing.userEdited = true;
    return existing;
  }
  const rel = {
    id: vid('rel'), a: ma.id, b: mb.id,
    label: String(input.label || '').slice(0, 120),
    category,
    status: REL_STATUS.has(input.status) ? input.status : 'active',
    sentiment: REL_SENTIMENT.has(input.sentiment) ? input.sentiment : 'neutral',
    source: o.source === 'user' ? 'user' : 'auto',
    firstTurn: turn, lastTurn: turn,
  };
  // seed numeric axes from the given sentiment (or explicit scores), + history
  if (typeof input.affection === 'number' || typeof input.trust === 'number') {
    rel.affection = REL_CLAMP(input.affection); rel.trust = REL_CLAMP(input.trust);
  } else { const s = sentimentToScores(rel.sentiment); rel.affection = s.affection; rel.trust = s.trust; }
  rel.history = [];
  ensureRelScores(rel);
  if (o.source === 'user') rel.userEdited = true;
  ch.relations.push(rel);
  return rel;
}

function relationEdit(ch, id, input) {
  const r = Array.isArray(ch.relations) && ch.relations.find((x) => x.id === id);
  if (!r) return null;
  ensureRelScores(r);
  if (input.a) { const m = resolveOrAddCast(ch, input.a); if (m) r.a = m.id; }
  if (input.b) { const m = resolveOrAddCast(ch, input.b); if (m) r.b = m.id; }
  if (typeof input.label === 'string') r.label = input.label.slice(0, 120);
  if (REL_CATEGORIES.has(input.category)) r.category = input.category;
  if (REL_STATUS.has(input.status)) r.status = input.status;
  // explicit numeric scores from the editor (sliders); else allow sentiment to seed
  let scored = false;
  if (input.affection !== undefined && input.affection !== '') { r.affection = REL_CLAMP(input.affection); scored = true; }
  if (input.trust !== undefined && input.trust !== '') { r.trust = REL_CLAMP(input.trust); scored = true; }
  if (scored) { r.sentiment = deriveSentiment(r.affection, r.trust); r.lockScores = true; }
  else if (REL_SENTIMENT.has(input.sentiment)) { r.sentiment = input.sentiment; const s = sentimentToScores(input.sentiment); r.affection = s.affection; r.trust = s.trust; }
  r.userEdited = true;
  return r;
}

function relationDelete(ch, id) {
  if (!Array.isArray(ch.relations)) return false;
  const i = ch.relations.findIndex((x) => x.id === id);
  if (i < 0) return false;
  const r = ch.relations[i];
  addTombstone(ch, 'rel', relSig(r.a, r.b, r.category));
  ch.relations.splice(i, 1);
  return true;
}

// Fold an auto-extracted relation list (from the cast scan) into ch.relations.
// Resolves names to cast ids, dedupes, honors tombstones + userEdited.
function applyRelations(ch, list, nc) {
  if (!Array.isArray(list)) return 0;
  let added = 0;
  for (const r of list) {
    const a = canonName(r.a || r.from || r.subject, nc);
    const b = canonName(r.b || r.to || r.other, nc);
    const before = ch.relations.length;
    const res = relationAdd(ch, { a, b, label: r.label, category: r.category, status: r.status, sentiment: r.sentiment }, { source: 'auto' });
    if (res && ch.relations.length > before) added++;
  }
  return added;
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
      const active = await spindle.chats.getActive(userId || _lastUserId);
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
          return { id: m.id, role: m.role, content, name: (m.name || '').trim(), isUser: m.is_user === true || m.role === 'user', hidden: !!(m.extra && m.extra.hidden) };
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


// Rebuild structural data from the CURRENT transcript while preserving the
// curated/LLM layers — used when turns are DELETED or swiped so the chronicle
// stays true to what's actually in the chat (no stale arcs/events from turns
// that no longer exist). Structural fold (arcs/threads/events/shifts) is rebuilt
// from scratch; cast/knowledge/secrets/relations/memJournal/memTree are kept;
// memories that covered now-deleted turns are clamped away.
async function resyncFromTranscript(chatId, userId) {
  if (!chatId) return false;
  let msgs;
  try { msgs = await readStoredMessages(chatId); } catch (e) { return false; }
  if (!msgs) return false;
  const ch = await loadChronicle(chatId);
  const fresh = rebuildFromMessages(msgs);
  // Replace structural fold with the truth from the transcript.
  ch.arcs = fresh.arcs;
  ch.threads = fresh.threads;
  ch.events = fresh.events;
  ch.shifts = fresh.shifts;
  ch.present = fresh.present;
  ch.presentIds = fresh.presentIds;
  ch.turns = fresh.turns;
  ch.lastDay = fresh.lastDay;
  ch._sig = fresh._sig || ch._sig;
  // Clamp distilled memories + coverage to the new turn count (drop chapters
  // that summarized turns which no longer exist).
  if (Array.isArray(ch.memories)) ch.memories = ch.memories.filter((m) => (m.toTurn || 0) <= fresh.turns);
  if ((ch.covered || 0) > fresh.turns) ch.covered = fresh.turns;
  // Prune memTree arc chapter refs that point at dropped memories.
  if (ch.memTree && Array.isArray(ch.memTree.arcs)) {
    const live = new Set((ch.memories || []).map((m) => m.id));
    for (const a of ch.memTree.arcs) a.chapterIds = (a.chapterIds || []).filter((id) => live.has(id));
    ch.memTree.arcs = ch.memTree.arcs.filter((a) => (a.chapterIds || []).length);
  }
  _prewarmCache.delete(chatId);
  await saveChronicle(chatId, ch);
  broadcastChronicle(chatId, ch, userId);
  // Refresh the live window from the newest surviving ledger/BTS turn.
  let lastLed = null, lastBts = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== 'assistant' || typeof m.content !== 'string') continue;
    const led = parseLedger(m.content), bts = parseBts(m.content);
    if (led || bts) { lastLed = led; lastBts = bts; break; }
  }
  if (lastLed || lastBts) {
    const ledger = lastLed || { raw: '', time: '', location: '', weather: '', present: '', thoughts: '', arcs: '', offscreen: '', sceneTension: '', bondTension: '' };
    lastStateByChat.set(chatId, { ledger, bts: lastBts, updatedAt: Date.now() });
    try { await syncChatVars(chatId, ledger, lastBts); } catch (e) {}
    broadcast(chatId, ledger, lastBts, ch, await resolveUserName(chatId));
  } else {
    // no ledgered turns left → clear the live window
    lastStateByChat.delete(chatId);
    try { spindle.sendToFrontend({ type: 'vellum_tracker_empty' }, userId); } catch (e) {}
  }
  spindle.log.info('[vellum_tracker] resynced from transcript: ' + fresh.turns + ' turns');
  return true;
}

// Debounce per chat so a burst of deletes/swipes triggers one resync.
const _resyncTimers = new Map();
function scheduleResync(chatId, userId) {
  if (!chatId) return;
  rememberUser(userId);
  if (_resyncTimers.has(chatId)) clearTimeout(_resyncTimers.get(chatId));
  _resyncTimers.set(chatId, setTimeout(() => {
    _resyncTimers.delete(chatId);
    resyncFromTranscript(chatId, userId || _lastUserId).catch((e) => spindle.log.warn('[vellum_tracker] resync: ' + (e && e.message)));
  }, 1200));
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
    // restore any messages we hid before wiping, so none are stranded hidden
    try { const old = await loadChronicle(chatId); await restoreHidden(chatId, old); } catch (e) {}
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
  // No cap — events & shifts are unlimited (file-backed storage).
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

﻿// "Hide summarized turns" (token-saving, LumiBooks-style hide-on-file):
// Once early turns are distilled into chapter memories, mark the corresponding
// chat messages HIDDEN via spindle.chat.setMessagesHidden. The host assembler
// excludes hidden messages from the outgoing prompt, the breakdown, AND vector
// retrieval (unlike dropping them in the interceptor, which the host snapshots
// BEFORE interceptors run, so the breakdown never shrinks). A recent tail stays
// verbatim and a compact STORY SO FAR recap is injected by the interceptor.
const HIDE_KEEP_RECENT = 4;
function buildStorySoFar(ch) {
  const mems = (ch.memories || []).slice().sort((a, b) => (a.fromTurn || 0) - (b.fromTurn || 0));
  if (!mems.length) return '';
  const dl = (d) => (d ? 'Day ' + d + ': ' : '');
  const lines = mems.map((m) => '\u2022 ' + dl(m.day) + (m.text || '').trim());
  let out = lines.join('\n');
  if (out.length > 12000) out = out.slice(0, 12000) + '\u2026';
  return out;
}
async function syncHideOnFile(chatId, ch) {
  if (!spindle.chat || !spindle.chat.setMessagesHidden) return { hid: 0, shown: 0 };
  let msgs;
  try { msgs = await readStoredMessages(chatId); } catch (e) { return { hid: 0, shown: 0 }; }
  if (!msgs || !msgs.length) return { hid: 0, shown: 0 };
  if (!Array.isArray(ch.hiddenByVellum)) ch.hiddenByVellum = [];
  const ours = new Set(ch.hiddenByVellum);
  const covered = ch.covered || 0;
  let totalAsst = 0; for (const m of msgs) if (m.role === 'assistant') totalAsst++;
  const dropUpTo = Math.min(covered, Math.max(0, totalAsst - HIDE_KEEP_RECENT));
  const toHide = [], toShow = [];
  let asst = 0;
  for (const m of msgs) {
    if (!m.id || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const turn = asst + 1;
    if (m.role === 'assistant') asst++;
    const shouldHide = ch.hideSummarized && turn <= dropUpTo;
    if (shouldHide) { if (!m.hidden) toHide.push(m.id); ours.add(m.id); }
    else if (ours.has(m.id) && m.hidden) { toShow.push(m.id); ours.delete(m.id); }
  }
  try {
    for (let i = 0; i < toHide.length; i += 500) await spindle.chat.setMessagesHidden(chatId, toHide.slice(i, i + 500), true);
    for (let i = 0; i < toShow.length; i += 500) await spindle.chat.setMessagesHidden(chatId, toShow.slice(i, i + 500), false);
  } catch (e) { spindle.log.warn('[vellum_tracker] hide-on-file: ' + (e && e.message)); }
  ch.hiddenByVellum = Array.from(ours);
  if (toHide.length || toShow.length) spindle.log.info('[vellum_tracker] hide-on-file: hid ' + toHide.length + ', restored ' + toShow.length + ' (covered=' + covered + ')');
  return { hid: toHide.length, shown: toShow.length };
}
async function restoreHidden(chatId, ch) {
  if (!spindle.chat || !spindle.chat.setMessagesHidden) return;
  const ids = Array.isArray(ch.hiddenByVellum) ? ch.hiddenByVellum.slice() : [];
  if (!ids.length) return;
  try { for (let i = 0; i < ids.length; i += 500) await spindle.chat.setMessagesHidden(chatId, ids.slice(i, i + 500), false); }
  catch (e) { spindle.log.warn('[vellum_tracker] restoreHidden: ' + (e && e.message)); }
  ch.hiddenByVellum = [];
  spindle.log.info('[vellum_tracker] hide-on-file: restored ' + ids.length + ' hidden messages');
}

const lastInjectionByChat = new Map();
// Pre-warm cache (#10): reuse the assembled injection when the scene query is
// unchanged (swipes / regenerations / rapid retries hit the same fingerprint),
// so the heavy scoring pass doesn't re-run on the hot path.
const _prewarmCache = new Map(); // chatId -> { fp, content, ids, recall, recallTrace, castBlock, castCount, castTrace, phase }
function sceneFingerprint(query) { return vhash(String(query || '').slice(-1400)); }
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

  // Hide-on-file: when enabled, the OLD summarized messages are already hidden
  // from the prompt at the assembler level (via setMessagesHidden in handle()),
  // so we don't touch the array here. Instead, prepend a compact STORY SO FAR
  // recap so the model still has the condensed past. Recent turns stay verbatim.
  let storyRecap = '';
  let _hideCh = null;
  try {
    const cid0 = context && (context.chatId || context.chat_id);
    if (cid0) {
      _hideCh = await loadChronicle(cid0);
      if (_hideCh && _hideCh.hideSummarized && (_hideCh.hiddenByVellum || []).length) {
        storyRecap = buildStorySoFar(_hideCh);
      }
    }
  } catch (eHide) { spindle.log.warn('[vellum_tracker] hideSummarized recap: ' + (eHide && eHide.message)); }

  // Scene-relevant chronicle recall (budgeted, retrieval-gated — never a full dump).
  let injectedContent = '';
  try {
    const chatId = context && (context.chatId || context.chat_id);
    if (!chatId) {
      spindle.log.warn('[vellum_tracker] interceptor: no context.chatId — cannot inject');
    } else {
      const ch = _hideCh || await loadChronicle(chatId);
      if (chronicleHasContent(ch)) {
        const query = queryFromMessages(out, RECALL.queryMessages);
        // Pre-warm reuse (#10): identical scene query (swipe/regeneration) → reuse
        // the already-assembled injection without re-scoring or re-recording.
        const fp = sceneFingerprint(query);
        // Deep Memory: when Deep Recall is on, refresh the LLM memory-tree pick in
        // the background for this scene (non-blocking; warms _memTreeCache for the
        // next generation). selectMemories uses the cached result if present.
        if (ch.deepRecall && (ch.memories || []).length >= 4) {
          const mc = _memTreeCache.get(chatId);
          if (!mc || mc.sig !== _memSceneSig(query)) {
            const uid = context && (context.userId || context.user_id);
            setTimeout(() => { runMemoryTree(chatId, query, uid); }, 50);
          }
        }
        const warm = _prewarmCache.get(chatId);
        if (warm && warm.fp === fp && warm.content) {
          injectedContent = warm.content;
          lastInjectionByChat.set(chatId, { at: Date.now(), phase: warm.phase, cast: warm.castBlock || '', castCount: warm.castCount || 0, castTrace: warm.castTrace || [], recall: warm.recall || [], recallTrace: warm.recallTrace || [], chars: warm.content.length, cached: true });
          try { await spindle.variables.chat.set(chatId, 'vellum_injection_json', JSON.stringify(lastInjectionByChat.get(chatId)).slice(0, 40000)); } catch (eW) {}
          spindle.log.info('[vellum_tracker] reused pre-warmed injection (' + warm.content.length + ' chars)');
        } else {
        const { arcIds, threadIds } = pinnedIdSets(ch);
        // Budget allocator (#4.5): one ceiling split across sub-blocks. Phase
        // (#7) scales the recall slice. Cast/knowledge keep their caps; recall
        // gets the remainder up to its cap.
        const phase = detectPhase(query);
        const phaseMult = PHASE_BUDGET_MULT[phase] || 1.0;
        const castBudget = INJECT_BUDGET.cast;
        const knowBudget = INJECT_BUDGET.knowledge;
        const recallBudget = Math.round(Math.min(INJECT_BUDGET.recall, RECALL.budgetChars) * phaseMult);

        const cast = buildCastDigest(ch, query);
        const castBlock = cast.text;
        const knowBlock = buildKnowledgeDigest(ch, query, { budgetChars: knowBudget });
        const ap = deepApproved(chatId, ch);
        const tunedMin = tunedMinScore(ch);
        const sel = selectRelevant(ch, query, arcIds, threadIds, Object.assign({ budgetChars: recallBudget, minScore: tunedMin }, ap ? { approved: ap } : {}));
        const lines = sel.lines;

        // Entity-graph multi-hop hook (#12) — fills only leftover global budget.
        const usedSoFar = (castBlock ? castBlock.length : 0) + (knowBlock ? knowBlock.length : 0) + lines.join('\n').length;
        const graphRoom = Math.min(INJECT_BUDGET.graph, Math.max(0, INJECT_BUDGET.total - usedSoFar));
        const graph = graphRoom > 80 ? buildGraphRecall(ch, query, sel.ids, { budgetChars: graphRoom }) : { lines: [], trace: [], ids: [] };

        // Story Memory (chapter summaries) — own budget, recency floor + tag scoring.
        // If Deep Recall is on, use the cached memory-tree picks (LLM traversal).
        const memTreeIds = ch.deepRecall ? (_memTreeCache.get(chatId) && _memTreeCache.get(chatId).ids) : null;
        const mem = selectMemories(ch, query, { budgetChars: INJECT_BUDGET.memory, nc: null, approved: memTreeIds || null });

        let content = '';
        if (castBlock) content += '[CAST — established characters, for continuity. Keep ages, looks, and roles consistent; do not contradict these.]\n' + castBlock + '\n\n';
        if (knowBlock) content += '[KNOWLEDGE & SECRETS — the information state, for dramatic irony. Honor exactly who knows, believes, suspects, or is ignorant of what; never let a character act on knowledge they do not have, and never casually expose a secret unless the scene earns it.]\n' + knowBlock + '\n\n';
        if (mem.lines.length) content += '[STORY MEMORY — distilled chapters of what already happened, newest understanding of the past. Treat as established history; weave it in, do not recite it.]\n' + mem.lines.join('\n') + '\n\n';
        if (lines.length) content += '[CHRONICLE RECALL — entries relevant to the current scene, retrieved from long-term memory. Honor them as established history; do not recite them in prose.]\n' + lines.join('\n');
        if (graph.lines.length) content += (lines.length ? '\n' : '') + '\n[CONNECTED CONTEXT — tied to characters in the scene via the story graph.]\n' + graph.lines.join('\n');
        content = content.trim();
        // Global ceiling safety clamp.
        if (content.length > INJECT_BUDGET.total) content = content.slice(0, INJECT_BUDGET.total);
        if (content) {
          injectedContent = content;
          // Record what we injected into the cooldown ring (#2) + feedback (#1).
          const injIds = sel.ids.concat(graph.ids).concat(mem.ids);
          recordInjection(ch, injIds);
          noteInjectedForFeedback(ch, injIds);
          try { await saveChronicle(chatId, ch); } catch (eSave) {}
          lastInjectionByChat.set(chatId, {
            at: Date.now(),
            phase,
            cast: castBlock || '',
            castCount: castBlock ? castBlock.split('\n').filter(Boolean).length : 0,
            castTrace: cast.trace || [],
            recall: mem.lines.concat(lines).concat(graph.lines),
            recallTrace: (mem.trace || []).concat(sel.trace || []).concat(graph.trace || []),
            chars: content.length,
          });
          try { await spindle.variables.chat.set(chatId, 'vellum_injection_json', JSON.stringify(lastInjectionByChat.get(chatId)).slice(0, 40000)); } catch (e3) {}
          _prewarmCache.set(chatId, { fp, content, ids: injIds, recall: mem.lines.concat(lines).concat(graph.lines), recallTrace: (mem.trace || []).concat(sel.trace || []).concat(graph.trace || []), castBlock: castBlock || '', castCount: castBlock ? castBlock.split('\n').filter(Boolean).length : 0, castTrace: cast.trace || [], phase });
          spindle.log.info(`[vellum_tracker] injected ${content.length} chars (${lines.length} recall +${graph.lines.length} graph, cast=${!!castBlock}, phase=${phase})`);
        } else {
          lastInjectionByChat.set(chatId, { at: Date.now(), cast: '', castCount: 0, recall: [], chars: 0 });
          _prewarmCache.set(chatId, { fp, content: '', ids: [], recall: [], recallTrace: [], castBlock: '', castCount: 0, castTrace: [], phase });
          spindle.log.info('[vellum_tracker] nothing to inject this turn (no cast/recall matched)');
        }
        }
      } else {
        spindle.log.info('[vellum_tracker] chronicle empty — nothing to inject yet');
      }
    }
  } catch (err) {
    spindle.log.warn(`[vellum_tracker] recall inject: ${err?.message || err}`);
  }

  // Inject at index 0 as system message(s) + Prompt Breakdown entries. When
  // hide-on-file is active, prepend a STORY SO FAR recap of the hidden chapters.
  const heads = [], bk = [];
  if (storyRecap) {
    heads.push({ role: 'system', content: '[STORY SO FAR \u2014 earlier chapters of this scene, condensed to save context (the raw turns are hidden from the prompt). Treat as established history; do not recap it in prose.]\n' + storyRecap });
    bk.push({ messageIndex: heads.length - 1, name: 'VELLUM Story So Far' });
  }
  if (injectedContent) {
    heads.push({ role: 'system', content: injectedContent });
    bk.push({ messageIndex: heads.length - 1, name: 'VELLUM Recall' });
  }
  if (heads.length) {
    return { messages: [...heads, ...out], breakdown: bk };
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
  if (!chatId) return;
  let parsed = content ? parseLedger(content) : null;
  let btsRaw = content ? parseBts(content) : null;
  // Fallback: the event payload sometimes lacks the final content (empty,
  // streamed, or content-stripped). Read the newest stored assistant message so
  // the live window + cast still update on a new turn.
  if (!parsed && !btsRaw) {
    try {
      const msgs = await readStoredMessages(chatId);
      if (msgs && msgs.length) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (!m || m.role !== 'assistant' || typeof m.content !== 'string') continue;
          const led = parseLedger(m.content), bts = parseBts(m.content);
          if (led || bts) { parsed = led; btsRaw = bts; content = m.content; break; }
        }
      }
    } catch (e) { /* best effort */ }
  }
  if (!parsed && !btsRaw) return;
  const ledger = parsed || { raw: '', time: '', location: '', weather: '', present: '', thoughts: '', arcs: '', offscreen: '', sceneTension: '', bondTension: '' };
  lastStateByChat.set(chatId, { ledger, bts: btsRaw, updatedAt: Date.now() });
  await syncChatVars(chatId, ledger, btsRaw);
  const chForRapport = await loadChronicle(chatId); // present-character rapport for the window
  const userName = await resolveUserName(chatId);
  broadcast(chatId, ledger, btsRaw, chForRapport, userName);

  // Fold this turn into the long-term chronicle (only when the state is new).
  try {
    const ch = chForRapport;
    const sig = sigOf(ledger, btsRaw);
    if (sig !== ch._sig) {
      ch._sig = sig;
      ch.turns = (ch.turns || 0) + 1;
      // Relevance feedback (#1/#16): did THIS new turn reference what we injected
      // before it? Scan against the last injection's trace, then update counters.
      try {
        const inj = lastInjectionByChat.get(chatId);
        const trace = inj && Array.isArray(inj.recallTrace) ? inj.recallTrace : null;
        if (trace && trace.length) applyFeedback(ch, content, trace);
      } catch (eFb) { /* feedback is best-effort */ }
      const day = extractDay(ledger.time) || ch.lastDay || 1;
      foldTurn(ch, ch.turns, day, ledger, btsRaw);
      decayRelations(ch, ch.turns); // relationships fade slightly when not reinforced
      await saveChronicle(chatId, ch);
      _prewarmCache.delete(chatId); // chronicle changed → next interceptor re-scores
      broadcastChronicle(chatId, ch);
      // After the live state is saved, opportunistically archive older turns in
      // the background (non-blocking — the user's generation already finished).
      if (userId) setTimeout(() => { maybeSummarize(chatId, userId); }, 1500);
      // Hide-on-file: once summaries advance, hide the now-covered raw turns so
      // they leave the prompt + breakdown + embeddings (real token savings).
      if (ch.hideSummarized) setTimeout(async () => {
        try { const c2 = await loadChronicle(chatId); const r = await syncHideOnFile(chatId, c2); if (r.hid || r.shown) await saveChronicle(chatId, c2); } catch (e) {}
      }, 2600);
      // Living tracker: auto-update relations/knowledge/secrets/memories from the
      // recent turn and emit pulse notifications (opt-in, background, throttled).
      if (userId && ch.living) setTimeout(() => { runLivingUpdate(chatId, userId); }, 2200);
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
    rememberUser(payload?.userId || payload?.user_id);
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

// Deleting (or swiping away) turns must keep the chronicle/cast TRUE to the
// actual transcript — resync from the real messages so stale data is purged.
spindle.on('MESSAGE_DELETED', async (payload) => {
  try {
    const chatId = payload?.chatId || payload?.chat_id;
    rememberUser(payload?.userId || payload?.user_id);
    scheduleResync(chatId, payload?.userId || payload?.user_id);
  } catch (err) { spindle.log.warn(`[vellum_tracker] MESSAGE_DELETED: ${err?.message || err}`); }
});
spindle.on('MESSAGE_SWIPED', async (payload) => {
  try {
    const chatId = payload?.chatId || payload?.chat_id;
    rememberUser(payload?.userId || payload?.user_id);
    // A swipe that adds/deletes/navigates changes the active content of a turn;
    // resync so the tracker reflects the now-active swipe.
    scheduleResync(chatId, payload?.userId || payload?.user_id);
  } catch (err) { spindle.log.warn(`[vellum_tracker] MESSAGE_SWIPED: ${err?.message || err}`); }
});

/* ---------- frontend messages ----------
 * get_state : re-broadcast the cached state for a chat (used when the window opens).
 * parse_content : parse explicit content the frontend supplies (fallback path).
 */
spindle.onFrontendMessage(async (payload, userId) => {
  try {
    rememberUser(userId);
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
        let rapport = [];
        try { const ch = await loadChronicle(chatId); const un = await resolveUserName(chatId); rapport = computeRapport(ch, un); } catch (e) {}
        spindle.sendToFrontend({ type: 'vellum_tracker_update', chatId, ledger: state.ledger, bts: state.bts, rapport, updatedAt: state.updatedAt }, userId);
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
    if (payload?.type === 'set_hide_summarized' || payload?.type === 'get_hide_summarized') {
      const chatId = await resolveChatId(payload.chatId, userId);
      if (!chatId) { spindle.sendToFrontend({ type: 'vellum_hide_summarized', enabled: false, covered: 0, memories: 0 }, userId); return; }
      const ch = await loadChronicle(chatId);
      if (payload.type === 'set_hide_summarized') {
        ch.hideSummarized = !!payload.enabled;
        _prewarmCache.delete(chatId); // affects outgoing context → invalidate cache
        // Apply immediately: hide now-covered turns, or restore everything on off.
        if (ch.hideSummarized) { try { await syncHideOnFile(chatId, ch); } catch (e) { spindle.log.warn('[vellum_tracker] toggle-hide: ' + (e && e.message)); } }
        else { try { await restoreHidden(chatId, ch); } catch (e) {} }
        await saveChronicle(chatId, ch);
      }
      spindle.sendToFrontend({ type: 'vellum_hide_summarized', enabled: !!ch.hideSummarized, covered: ch.covered || 0, memories: (ch.memories || []).length, hidden: (ch.hiddenByVellum || []).length }, userId);
      return;
    }
    if (payload?.type === 'set_living' || payload?.type === 'get_living') {
      const chatId = await resolveChatId(payload.chatId, userId);
      if (!chatId) { spindle.sendToFrontend({ type: 'vellum_living', enabled: false }, userId); return; }
      const ch = await loadChronicle(chatId);
      if (payload.type === 'set_living') { ch.living = !!payload.enabled; await saveChronicle(chatId, ch); }
      spindle.sendToFrontend({ type: 'vellum_living', enabled: !!ch.living }, userId);
      return;
    }
    if (payload?.type === 'run_living') {
      const chatId = await resolveChatId(payload.chatId, userId);
      if (chatId) { const ch = await loadChronicle(chatId); if (!ch.living) { ch.living = true; await saveChronicle(chatId, ch); } await runLivingUpdate(chatId, userId); }
      return;
    }
    if (payload?.type === 'get_memtree') {
      const chatId = await resolveChatId(payload.chatId, userId);
      const ch = chatId ? await loadChronicle(chatId) : null;
      const view = ch ? memTreeView(ch) : { arcs: [], unassigned: [], index: {}, builtAt: 0, chapters: 0 };
      spindle.sendToFrontend(Object.assign({ type: 'vellum_memtree' }, view), userId);
      return;
    }
    if (payload?.type === 'build_memtree') {
      const chatId = await resolveChatId(payload.chatId, userId);
      if (!chatId) { spindle.sendToFrontend({ type: 'vellum_memtree_done', ok: false, reason: 'no_active_chat' }, userId); return; }
      spindle.sendToFrontend({ type: 'vellum_memtree_building' }, userId);
      const r = await buildMemoryTree(chatId, userId);
      const ch = await loadChronicle(chatId);
      spindle.sendToFrontend(Object.assign({ type: 'vellum_memtree_done' }, r, memTreeView(ch)), userId);
      return;
    }
    if (payload?.type === 'memtree_edit' || payload?.type === 'memtree_add_arc' || payload?.type === 'memtree_delete_arc' || payload?.type === 'memtree_move') {
      const chatId = await resolveChatId(payload.chatId, userId);
      if (!chatId) return;
      const ch = await loadChronicle(chatId);
      let ok = false;
      if (payload.type === 'memtree_edit') ok = memTreeEditArc(ch, payload.arcId, payload.patch || payload);
      else if (payload.type === 'memtree_add_arc') ok = !!memTreeAddArc(ch, payload.title);
      else if (payload.type === 'memtree_delete_arc') ok = memTreeDeleteArc(ch, payload.arcId);
      else if (payload.type === 'memtree_move') ok = memTreeMoveChapter(ch, payload.chapterId, payload.arcId || null);
      if (ok) { await saveChronicle(chatId, ch); }
      spindle.sendToFrontend(Object.assign({ type: 'vellum_memtree' }, memTreeView(ch)), userId);
      return;
    }
    if (payload?.type === 'get_pulse') {
      const chatId = await resolveChatId(payload.chatId, userId);
      const ch = chatId ? await loadChronicle(chatId) : null;
      spindle.sendToFrontend({ type: 'vellum_pulse_list', events: ch ? (ch.pulse || []) : [], unseen: ch ? unseenPulse(ch) : 0, living: !!(ch && ch.living) }, userId);
      return;
    }
    if (payload?.type === 'pulse_seen') {
      const chatId = await resolveChatId(payload.chatId, userId);
      if (chatId) { const ch = await loadChronicle(chatId); ch.pulseSeen = (ch.pulse || []).length; await saveChronicle(chatId, ch); spindle.sendToFrontend({ type: 'vellum_pulse_unseen', unseen: 0 }, userId); }
      return;
    }
    if (payload?.type === 'pulse_clear') {
      const chatId = await resolveChatId(payload.chatId, userId);
      if (chatId) { const ch = await loadChronicle(chatId); ch.pulse = []; ch.pulseSeen = 0; await saveChronicle(chatId, ch); broadcastChronicle(chatId, ch, userId); spindle.sendToFrontend({ type: 'vellum_pulse_list', events: [], unseen: 0, living: !!ch.living }, userId); }
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
      if (payload.kind === 'knowledge' && Array.isArray(ch.knowledge)) {
        let idx = (typeof payload.id === 'string' && payload.id) ? ch.knowledge.findIndex((x) => x.id === payload.id) : (typeof payload.index === 'number' ? payload.index : -1);
        if (idx >= 0 && ch.knowledge[idx]) { addTombstone(ch, 'know', knowSig(ch.knowledge[idx])); ch.knowledge.splice(idx, 1); }
      } else if (payload.kind === 'secret' && Array.isArray(ch.secrets)) {
        let idx = (typeof payload.id === 'string' && payload.id) ? ch.secrets.findIndex((x) => x.id === payload.id) : (typeof payload.index === 'number' ? payload.index : -1);
        if (idx >= 0 && ch.secrets[idx]) { addTombstone(ch, 'sec', secSig(ch.secrets[idx])); ch.secrets.splice(idx, 1); }
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
      if (payload.id && ch.cast[payload.id]) { delete ch.cast[payload.id]; if (Array.isArray(ch.relations)) ch.relations = ch.relations.filter((r) => r.a !== payload.id && r.b !== payload.id); await saveChronicle(chatId, ch); broadcastChronicle(chatId, ch, userId); }
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
    if (payload?.type === 'track_add' || payload?.type === 'track_edit' || payload?.type === 'track_delete'
      || payload?.type === 'log_add' || payload?.type === 'log_edit' || payload?.type === 'log_delete'
      || payload?.type === 'knowledge_add' || payload?.type === 'knowledge_edit'
      || payload?.type === 'secret_add' || payload?.type === 'secret_edit'
      || payload?.type === 'mem_add' || payload?.type === 'mem_edit'
      || payload?.type === 'memory_add'
      || payload?.type === 'relation_add' || payload?.type === 'relation_edit' || payload?.type === 'relation_delete') {
      const chatId = await resolveChatId(payload.chatId, userId);
      if (!chatId) return;
      const ch = await loadChronicle(chatId);
      let ok = false;
      const tp = payload.type;
      if (tp === 'track_add') ok = !!trackAdd(ch, payload.group, payload.title, payload.status);
      else if (tp === 'track_edit') ok = !!trackEdit(ch, payload.group, payload.id, payload.title, payload.status);
      else if (tp === 'track_delete') ok = trackDelete(ch, payload.group, payload.id);
      else if (tp === 'log_add') ok = !!logAdd(ch, payload.kind, payload.text, payload.day);
      else if (tp === 'log_edit') ok = !!logEdit(ch, payload.kind, payload.id, payload.text, payload.day);
      else if (tp === 'log_delete') ok = logDelete(ch, payload.kind, payload.id);
      else if (tp === 'knowledge_add') ok = !!knowledgeAdd(ch, payload.entry || payload);
      else if (tp === 'knowledge_edit') ok = !!knowledgeEditEntry(ch, payload.id, payload.entry || payload);
      else if (tp === 'secret_add') ok = !!secretAdd(ch, payload.entry || payload);
      else if (tp === 'secret_edit') ok = !!secretEditEntry(ch, payload.id, payload.entry || payload);
      else if (tp === 'mem_add') ok = !!memJournalAdd(ch, payload.entry || payload);
      else if (tp === 'mem_edit') ok = !!memJournalEdit(ch, payload.charKey, payload.id, payload.entry || payload);
      else if (tp === 'memory_add') ok = !!chapterMemoryAdd(ch, payload.entry || payload);
      else if (tp === 'relation_add') ok = !!relationAdd(ch, payload.entry || payload, { source: 'user' });
      else if (tp === 'relation_edit') ok = !!relationEdit(ch, payload.id, payload.entry || payload);
      else if (tp === 'relation_delete') ok = relationDelete(ch, payload.id);
      if (ok) { await saveChronicle(chatId, ch); broadcastChronicle(chatId, ch, userId); }
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
