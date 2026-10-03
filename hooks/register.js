// fanyi: talk to Claude Code in your own language while Claude works in English.
//
// - A prompt in your language is translated to English before Claude reads it.
// - Each text block of Claude's reply that isn't already in your language gets a streamed
//   translation drawn under it. It's display-only: the stored conversation stays English.
// - Whether a text needs translating is decided by the translator server: by script for a
//   language not written in Latin script, by the model otherwise.
// - Settings (on/off, engine, language, detection) live in the plugin's store and are changed
//   from a settings pane (the ⚙ beside the toggle above the prompt, or /fanyi settings).
//
// Translation runs in the plugin's own MCP server (mcp/translator.mjs), so the mod
// itself makes no network requests.

// Tool names Claude sees for the plugin's translator server
const TRANSLATOR_TOOL = /^mcp__plugin_.+_translator__/
// How often a streaming translation is polled, in milliseconds
const POLL_MS = 300
// How many prompts and reply blocks to remember per session
const MAX_ENTRIES = 500

// Reply block text → { text: translation so far, done, skipped?, retrying? }
const replies = new Map()
// English prompt sent to Claude → what the user typed
const prompts = new Map()

// Finished translations are kept in the plugin's store too, so a restarted or resumed session
// draws them again without paying for them twice. One store key holds both lists:
// { v: 1, replies: [[blockKey(english), translation], ...], prompts: [[english, typed], ...] },
// oldest first, under a key per engine and language. A reply that needed no translation is saved
// as ''. The store holds 4 MiB of JSON in all; the oldest entries go past STORE_BUDGET.
const STORE_BUDGET = 3_000_000
const MAX_SAVED_PROMPTS = 300
// Writes are gathered for this long, so a long reply is one write, not one per block
const SAVE_DELAY_MS = 1000
// { key, promise } of the saved translations for the current engine and language
let saved = null
let saveTimer = null

// The store key of a reply block: two 32-bit FNV-1a hashes and the length (the English text
// itself would double what the store holds)
export function blockKey(text) {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0') + text.length.toString(36)
}

// The saved translations for the current engine and language, read once per load of the module
async function loadSaved($) {
  const s = await getSettings($)
  const key = 'translations:' + (s.engine === 'apple' ? 'apple' : 'api:' + s.model) + ':' + s.language
  if (!saved || saved.key !== key) {
    const promise = $.store
      .get(key)
      .then((v) => {
        const ok = v && v.v === 1
        const pairs = (list) => (ok && Array.isArray(list) ? list.filter((p) => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string') : [])
        return { key, replies: new Map(pairs(v && v.replies)), prompts: new Map(pairs(v && v.prompts)) }
      })
      .catch(() => ({ key, replies: new Map(), prompts: new Map() }))
    saved = { key, promise }
  }
  return saved.promise
}

// Keeps a finished translation and schedules a write of the store
async function save($, list, key, value) {
  const s = await loadSaved($)
  s[list].delete(key)
  s[list].set(key, value)
  if (saveTimer) return
  saveTimer = $.clock.after(SAVE_DELAY_MS, async () => {
    saveTimer = null
    while (s.prompts.size > MAX_SAVED_PROMPTS) s.prompts.delete(s.prompts.keys().next().value)
    let size = 0
    for (const [k, v] of s.prompts) size += k.length + v.length + 8
    for (const [k, v] of s.replies) size += k.length + v.length + 8
    for (const [k, v] of s.replies) {
      if (size <= STORE_BUDGET) break
      s.replies.delete(k)
      size -= k.length + v.length + 8
    }
    try {
      await $.store.set(s.key, { v: 1, replies: [...s.replies], prompts: [...s.prompts] })
    } catch (err) {
      $.ui.log('Could not save translations: ' + (err.message || err))
    }
  })
}

// Settings, kept in the store and changed from the settings pane or /fanyi
const SETTINGS_KEY = 'settings'
// base_url and model start from the plugin's userConfig (see register)
const DEFAULT_SETTINGS = {
  enabled: true,
  engine: 'api',
  language: 'zh-Hans',
  detection: 'device',
  base_url: 'https://opencode.ai/zen/go/v1',
  model: 'deepseek-v4.1-flash',
}
let settings = null
// Bumped when the engine or language changes, so translations still running for the old ones
// are dropped instead of drawn
let generation = 0

async function getSettings($) {
  if (!settings) {
    let stored = null
    try {
      stored = await $.store.get(SETTINGS_KEY)
    } catch {}
    settings = { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) }
  }
  return settings
}

async function isEnabled($) {
  return (await getSettings($)).enabled
}

// Changes some settings, keeps them and redraws; another engine or language starts translations over
async function updateSettings($, change) {
  const prev = await getSettings($)
  settings = { ...prev, ...change }
  try {
    await $.store.set(SETTINGS_KEY, settings)
  } catch (err) {
    $.ui.log('Could not save the fanyi settings: ' + (err.message || err))
  }
  if (['engine', 'language', 'base_url', 'model'].some((k) => settings[k] !== prev[k])) {
    generation++
    replies.clear()
    phrases.clear()
    waiting.length = 0
    queued.length = 0
  }
  $.ui.invalidate('ui.render')
}

// The settings the translator server needs with each call
async function settingArgs($) {
  const s = await getSettings($)
  return { engine: s.engine, language: s.language, detection: s.detection, base_url: s.base_url, model: s.model }
}

// Sets a key and drops the oldest entries past MAX_ENTRIES
function remember(map, key, value) {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value)
}

// The translator server's name as the session runs it, once connected
let server = null

// A failure that only means the translator server is not connected yet (a session starting or
// resuming draws its replies before plugin servers are up): waited out, never reported
class NotConnected extends Error {}
const NOT_CONNECTED = /no connected MCP tool|not connected|no MCP server|is not running/i

// Calls one of the translator server's tools and returns its text; throws on a tool error
async function callTool($, tool, args) {
  if (!server) {
    const c = await $.mcp.connect('translator')
    if (!c.isConnected) throw new NotConnected('translator not connected: ' + (c.message || c.reason))
    server = c.server
  }
  let r
  try {
    r = await $.mcp.call(server, tool, args)
  } catch (err) {
    if (NOT_CONNECTED.test(String(err.message || err))) {
      server = null
      throw new NotConnected(String(err.message || err))
    }
    throw err
  }
  const out = (r.content || []).map((c) => c.text || '').join('')
  if (r.isError) {
    if (NOT_CONNECTED.test(out)) {
      server = null
      throw new NotConnected(out)
    }
    throw new Error(out)
  }
  return out
}
// How long a translation waits for the translator server to connect, and how often it looks
const CONNECT_WAIT_MS = 60000
const CONNECT_POLL_MS = 2000

function logFailure($, err) {
  $.ui.log('Translation failed: ' + (err.message || err))
}

// One-shot translation; returns null when the text needs none or on any failure, so the
// caller falls back to the original
async function translate($, text, to) {
  for (let waited = 0; ; waited += CONNECT_POLL_MS) {
    try {
      const r = JSON.parse(await callTool($, 'translate', { text, to, session: await $.session.id(), ...(await settingArgs($)) }))
      return r.skipped ? null : r.text || null
    } catch (err) {
      if (err instanceof NotConnected && waited < CONNECT_WAIT_MS) {
        await sleep($, CONNECT_POLL_MS)
        continue
      }
      logFailure($, err)
      return null
    }
  }
}

// At most this many translations run at once: a burst (a resumed session, a long reply) would
// otherwise hit the endpoint's rate limit and some blocks would fail
const MAX_ACTIVE = 3
// Waits before the 2nd and 3rd attempt of a failed translation, in milliseconds
const RETRY_MS = [2000, 6000]
let active = 0
const waiting = []

// Queues a reply block's translation; `text` is keyed by its trimmed form
function enqueue($, text) {
  waiting.push(text)
  pump($)
}

function pump($) {
  while (active < MAX_ACTIVE && waiting.length) {
    const text = waiting.shift()
    active++
    translateReply($, text).finally(() => {
      active--
      pump($)
    })
  }
}

const sleep = ($, ms) => new Promise((resolve) => $.clock.after(ms, resolve))

// Translates one reply block, retrying a failed attempt; the box says so meanwhile
async function translateReply($, text) {
  const key = text.trim()
  const gen = generation
  let waited = 0
  for (let attempt = 0; ; attempt++) {
    try {
      return await streamOnce($, text, key, gen)
    } catch (err) {
      // Not connected yet: wait for the server without spending an attempt or reporting it
      if (err instanceof NotConnected && waited < CONNECT_WAIT_MS) {
        waited += CONNECT_POLL_MS
        attempt--
        await sleep($, CONNECT_POLL_MS)
        continue
      }
      if (gen !== generation) return
      if (attempt >= RETRY_MS.length) return dropReply($, key, err)
      logFailure($, err)
      remember(replies, key, { text: '', done: false, retrying: true })
      $.ui.invalidate('ui.render')
      await sleep($, RETRY_MS[attempt])
    }
  }
}

// One attempt: start a job, then poll and redraw as text arrives; settles when it is done or fails
function streamOnce($, text, key, gen) {
  return new Promise(async (resolve, reject) => {
    let job
    try {
      const r = JSON.parse(await callTool($, 'translate_start', { text, to: 'local', session: await $.session.id(), ...(await settingArgs($)) }))
      if (gen !== generation) return resolve()
      if (r.skipped) return resolve(skipReply($, key))
      job = r.job
    } catch (err) {
      return reject(err)
    }
    // Skip a tick while the previous poll is still in flight
    let busy = false
    const timer = $.clock.every(POLL_MS, async () => {
      if (busy) return
      busy = true
      try {
        const r = JSON.parse(await callTool($, 'translate_poll', { job }))
        // The engine or language changed meanwhile: this translation is no longer wanted
        if (gen !== generation) {
          timer.cancel()
          return resolve()
        }
        if (r.error) throw new Error(r.error)
        if (r.skipped) {
          timer.cancel()
          return resolve(skipReply($, key))
        }
        const prev = replies.get(key)
        if (!prev || prev.text !== r.text || r.done) {
          remember(replies, key, { text: r.text, done: r.done })
          $.ui.invalidate('ui.render')
        }
        if (r.done) {
          timer.cancel()
          if (r.text) save($, 'replies', blockKey(key), r.text)
          resolve()
        }
      } catch (err) {
        timer.cancel()
        reject(err)
      } finally {
        busy = false
      }
    })
  })
}

// Marks a reply block as already in the user's language: no box, and saved so it isn't checked again
function skipReply($, key) {
  remember(replies, key, { text: '', done: true, skipped: true })
  save($, 'replies', blockKey(key), '')
  $.ui.invalidate('ui.render')
}

// Removes a reply's translation box after a failure and reports why
function dropReply($, key, err) {
  replies.delete(key)
  $.ui.invalidate('ui.render')
  logFailure($, err)
}

// The translation entry of a reply block not seen yet: the saved one when there is one, else a
// new one whose translation starts now
async function entryFor($, text) {
  const key = text.trim()
  const s = await loadSaved($)
  // Another hook may have started it while the store was read
  const seen = replies.get(key)
  if (seen) return seen
  const hit = s.replies.get(blockKey(key))
  const entry = hit === undefined ? { text: '', done: false } : { text: hit, done: true, skipped: hit === '' }
  remember(replies, key, entry)
  if (hit === undefined) $.clock.after(0, () => enqueue($, text))
  return entry
}

// Short strings the engine draws that aren't reply blocks: a question dialog's text and a
// tool row's title. Translated in one request per batch and drawn in place of the English.
// Trimmed text → translation ('' when it needs none)
const phrases = new Map()
// Trimmed texts whose translation is running
const pending = new Set()
// Trimmed texts waiting for the next batch
const queued = []
let batchTimer = null

// The translations of `texts`, each undefined while its translation is still running or
// when the text needs none; a text not seen yet is queued for the next batch
async function translations($, texts) {
  const s = await loadSaved($)
  const out = []
  for (const text of texts) {
    const key = typeof text === 'string' ? text.trim() : ''
    if (!key) {
      out.push(undefined)
      continue
    }
    let hit = phrases.get(key)
    if (hit === undefined) {
      hit = s.replies.get(blockKey(key))
      if (hit !== undefined) remember(phrases, key, hit)
    }
    if (hit !== undefined) {
      out.push(hit || undefined)
      continue
    }
    out.push(undefined)
    if (!pending.has(key)) {
      pending.add(key)
      queued.push(key)
      if (!batchTimer) batchTimer = $.clock.after(0, () => flushPhrases($))
    }
  }
  return out
}

// Translates every queued phrase, retrying a failed batch; a batch that fails for good is
// forgotten, so the next draw of its phrases tries again
async function flushPhrases($) {
  batchTimer = null
  const keys = queued.splice(0)
  if (!keys.length) return
  const gen = generation
  let texts = null
  let waited = 0
  for (let attempt = 0; ; attempt++) {
    try {
      texts = await translateMany($, keys)
      break
    } catch (err) {
      if (err instanceof NotConnected && waited < CONNECT_WAIT_MS) {
        waited += CONNECT_POLL_MS
        attempt--
        await sleep($, CONNECT_POLL_MS)
        continue
      }
      if (gen !== generation) break
      logFailure($, err)
      if (attempt >= RETRY_MS.length) break
      await sleep($, RETRY_MS[attempt])
    }
  }
  for (const key of keys) pending.delete(key)
  if (!texts || gen !== generation) return
  keys.forEach((key, i) => {
    remember(phrases, key, texts[i])
    save($, 'replies', blockKey(key), texts[i])
  })
  $.ui.invalidate('ui.render')
}

// One translator call, distinguishing a text that needs no translation ('') from a failure (throws)
async function translateOnce($, text) {
  const r = JSON.parse(await callTool($, 'translate', { text, to: 'local', session: await $.session.id(), ...(await settingArgs($)) }))
  return r.skipped ? '' : r.text || ''
}

// A numbered line per phrase, the translator's output split back by the numbers
const LINE = /^\s*(\d+)\s*[.)、．]\s*(.*?)\s*$/
function translateMany($, keys) {
  if (keys.length === 1) return translateOnce($, keys[0]).then((t) => [t])
  const batch = keys.map((key, i) => i + 1 + '. ' + key.replace(/\s*\n\s*/g, ' ')).join('\n')
  return translateOnce($, batch).then(async (out) => {
    if (out === '') return keys.map(() => '')
    const texts = new Array(keys.length)
    let n = 0
    for (const line of out.split('\n')) {
      const m = line.match(LINE)
      const i = m ? Number(m[1]) - 1 : -1
      if (m && i >= 0 && i < keys.length && texts[i] === undefined) {
        texts[i] = m[2]
        n++
      }
    }
    if (n === keys.length && texts.every((t) => t)) return texts
    // The model dropped or merged lines: translate them one by one instead
    const each = []
    for (const key of keys) each.push(await translateOnce($, key))
    return each
  })
}

// A text with its translation on the line under it, as the reply boxes show them
const bilingual = (original, translated) => (translated && translated !== original ? original + '\n' + translated : original)
// The same on one line, for a field the dialog draws as a single line (an option's description)
const inline = (original, translated) => (translated && translated !== original ? original + ' → ' + translated : original)

// The question dialog's questions, the question drawn with its translation under it and each
// option's description with its translation after it (the dialog draws a description as one
// line). An option's label is what Claude receives as the answer and the dialog refuses a
// rewrite of it, so its translation starts the description's translation instead.
async function translateQuestions($, asked) {
  const texts = []
  for (const q of asked) {
    texts.push(q.question, q.header, q.description, q.placeholder)
    for (const o of q.options || []) texts.push(o.label, o.description)
  }
  const got = await translations($, texts)
  if (got.every((t) => t === undefined)) return null
  let i = 0
  const take = (original) => got[i++] ?? original
  return asked.map((q) => {
    const question = take(q.question)
    const header = take(q.header)
    const description = take(q.description)
    const placeholder = take(q.placeholder)
    const out = {
      ...q,
      question: bilingual(q.question, question),
      // The dialog draws the header as a short chip, with room for one language only; a
      // translation that outgrows it stays English
      header: typeof header === 'string' && header.length <= 12 ? header : q.header,
      ...(typeof q.description === 'string' && { description: inline(q.description, description) }),
      ...(typeof q.placeholder === 'string' && { placeholder: inline(q.placeholder, placeholder) }),
    }
    if (Array.isArray(q.options)) {
      out.options = q.options.map((o) => {
        const label = take(o.label)
        const desc = take(o.description)
        const translated = [label !== o.label ? label : '', desc !== o.description ? desc : ''].filter(Boolean).join(' · ')
        if (!translated) return o
        return { ...o, description: typeof o.description === 'string' && o.description ? inline(o.description, translated) : translated }
      })
    }
    return out
  })
}

// The transcript row of an answered question (AskUserQuestion: `User answered Claude's
// questions`) with each question drawn bilingual. The row pairs answers with questions by the
// question's text, so the texts in the call's input, in its result and in the result's answer
// keys change together.
async function translateAnswered($, input, output) {
  const lists = [input && input.questions, output && output.questions].filter(Array.isArray)
  if (!lists.length) return null
  const texts = [...new Set(lists.flat().map((q) => q && q.question).filter((q) => typeof q === 'string'))]
  const got = await translations($, texts)
  const drawn = new Map(texts.map((t, i) => [t, bilingual(t, got[i])]))
  const questions = (list) => (Array.isArray(list) ? list.map((q) => (q && drawn.has(q.question) ? { ...q, question: drawn.get(q.question) } : q)) : list)
  const rekey = (obj) => (obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.fromEntries(Object.entries(obj).map(([k, v]) => [drawn.get(k) ?? k, v])) : obj)
  let answers = output && output.answers
  if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
    answers = {}
    for (const [k, v] of Object.entries(output.answers)) answers[drawn.get(k) ?? k] = await drawnAnswer($, v)
  }
  const response = output && typeof output.response === 'string' ? await drawnAnswer($, output.response) : undefined
  const same = got.every((t) => t === undefined) && (!answers || Object.entries(answers).every(([k, v]) => output.answers[k] === v)) && response === (output && output.response)
  if (same) return null
  return {
    input: input && Array.isArray(input.questions) ? { ...input, questions: questions(input.questions) } : input,
    output:
      output && typeof output === 'object'
        ? {
            ...output,
            ...(Array.isArray(output.questions) && { questions: questions(output.questions) }),
            ...(answers && { answers }),
            ...(response !== undefined && { response }),
            ...(output.annotations && { annotations: rekey(output.annotations) }),
          }
        : output,
  }
}

// Whether an answer is text the user typed, not an option's label (or, multi-select, labels
// joined by commas): only typed text is translated to English
function typedAnswer(asked, question, value) {
  const q = Array.isArray(asked) ? asked.find((x) => x && x.question === question) : null
  const labels = new Set(((q && q.options) || []).map((o) => o && o.label))
  return !labels.size || !value.split(', ').every((v) => labels.has(v))
}

// The result of an answered question with the text the user typed translated to English, as a
// prompt is; what was typed is kept (with the prompts) so the row draws it. Null when nothing
// was translated.
async function translateAnswers($, asked, result) {
  const out = { ...result }
  let changed = false
  const toEnglish = async (typed) => {
    const en = await translate($, typed, 'en')
    if (!en || en === typed) return null
    remember(prompts, en, typed)
    save($, 'prompts', en, typed)
    changed = true
    return en
  }
  if (result.answers && typeof result.answers === 'object' && !Array.isArray(result.answers)) {
    const answers = {}
    for (const [question, value] of Object.entries(result.answers)) {
      const typed = typeof value === 'string' && value.trim() && typedAnswer(asked, question, value)
      answers[question] = (typed && (await toEnglish(value))) || value
    }
    out.answers = answers
  }
  if (typeof result.response === 'string' && result.response.trim()) out.response = (await toEnglish(result.response)) || result.response
  return changed ? out : null
}

// An answer as the row draws it: what the user typed, with the English that was sent in
// parentheses; an answer that was sent as given draws as is
async function drawnAnswer($, value) {
  if (typeof value !== 'string') return value
  const typed = prompts.get(value) ?? (await loadSaved($)).prompts.get(value)
  return typed ? typed + ' (' + value + ')' : value
}

// The settings pane, and what it offers
const PANE = 'fanyi-settings'
const LANGUAGES = [
  ['zh-Hans', '简体中文'],
  ['zh-Hant', '繁體中文'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['pt-BR', 'Português (Brasil)'],
  ['it', 'Italiano'],
  ['ru', 'Русский'],
  ['uk', 'Українська'],
  ['pl', 'Polski'],
  ['nl', 'Nederlands'],
  ['tr', 'Türkçe'],
  ['vi', 'Tiếng Việt'],
  ['id', 'Bahasa Indonesia'],
  ['th', 'ไทย'],
  ['hi', 'हिन्दी'],
  ['ar', 'العربية'],
]
// Whether Apple's on-device engine can run here: null until the translator has been asked
let appleCaps = null
// The API key's state, { isSet, source, hint }: null until asked
let keyStatus = null
// The models the API offers: null until fetched, { models } or { error }, or { loading: true }
let modelList = null

// Asks the translator what this machine offers; the first time on a Mac it builds the helper
async function loadCapabilities($) {
  try {
    appleCaps = JSON.parse(await callTool($, 'capabilities', {})).apple
  } catch (err) {
    appleCaps = { available: false, reason: String(err.message || err) }
  }
  $.ui.invalidate('ui.render')
}

async function loadKeyStatus($) {
  try {
    keyStatus = JSON.parse(await callTool($, 'api_key_status', {}))
  } catch (err) {
    keyStatus = { isSet: false, source: null, error: String(err.message || err) }
  }
  $.ui.invalidate('ui.render')
}

// Fetches the API's model list for the pane's picker
async function loadModels($) {
  modelList = { loading: true }
  $.ui.invalidate('ui.render')
  try {
    const s = await getSettings($)
    modelList = JSON.parse(await callTool($, 'list_models', { base_url: s.base_url, session: await $.session.id() }))
  } catch (err) {
    modelList = { error: String(err.message || err) }
  }
  $.ui.invalidate('ui.render')
}

async function saveApiKey($, key) {
  try {
    keyStatus = JSON.parse(await callTool($, 'set_api_key', { key }))
    $.ui.toast(key.trim() ? 'API key saved' : 'Saved API key removed')
    // A new key may see other models
    if (key.trim()) $.clock.after(0, () => loadModels($))
  } catch (err) {
    $.ui.toast('Could not save the API key: ' + (err.message || err), { timeoutMs: 8000 })
  }
  $.ui.invalidate('ui.render')
}

async function saveBaseUrl($, value) {
  const url = value.trim().replace(/\/+$/, '')
  if (!/^https?:\/\/\S+$/.test(url)) {
    $.ui.toast('The API host must start with http:// or https://')
    return
  }
  await updateSettings($, { base_url: url })
  modelList = null
  $.clock.after(0, () => loadModels($))
}

async function openSettings($) {
  if (!appleCaps) $.clock.after(0, () => loadCapabilities($))
  $.clock.after(0, () => loadKeyStatus($))
  if (!modelList || modelList.error) $.clock.after(0, () => loadModels($))
  await $.ui.open({ id: PANE, title: 'Fanyi settings', focus: true, closeOnEscape: true, rows: 22, columns: 64 })
}

// Switches the engine, refusing Apple's when this machine can't run it
async function chooseEngine($, engine) {
  if (engine === 'apple' && appleCaps && !appleCaps.available) {
    $.ui.toast('Apple on-device is unavailable: ' + appleCaps.reason, { timeoutMs: 8000 })
    $.ui.invalidate('ui.render')
    return
  }
  await updateSettings($, { engine })
}

// One line under the pickers explaining the current choice
function settingsNote(s) {
  if (s.engine === 'apple') {
    if (appleCaps && !appleCaps.available) return 'Apple on-device is unavailable: ' + appleCaps.reason
    return 'Apple on-device: nothing leaves this Mac, and a reply is translated in under a second. Weaker with technical terms. Language packs: System Settings → General → Language & Region → Translation Languages.'
  }
  const detect = s.detection === 'device' ? 'Languages are detected on this Mac when possible.' : 'The model decides whether a text needs translating.'
  return 'API: translations stream from ' + s.model + '. ' + detect
}

// The pane's API rows: host, key and model, the model picked from the API's own list
function apiSection($, s, { Box, Text, Select, Button, Input }) {
  const keyText = !keyStatus
    ? 'checking…'
    : keyStatus.isSet
      ? 'set ' + keyStatus.hint + (keyStatus.source === 'config' ? ' (plugin config)' : keyStatus.source === 'keychain' ? ' (Keychain)' : ' (saved)')
      : 'not set'
  const models = modelList && modelList.models ? modelList.models : []
  const options = (models.includes(s.model) ? models : [s.model, ...models]).map((id) => ({ value: id, label: id }))
  const listNote = !modelList || modelList.loading ? 'Loading models…' : modelList.error ? 'Could not list models: ' + modelList.error : models.length + ' models'
  return [
    Box({ marginTop: 1, children: [Text({ bold: true, children: 'API' })] }),
    Input({ key: 'fanyi-base-url', label: 'Host', value: s.base_url, placeholder: 'https://api.example.com/v1', submitLabel: 'Save', onSubmit: (v) => saveBaseUrl($, v) }),
    Input({ key: 'fanyi-api-key', label: 'Key', value: '', placeholder: keyText + ' · paste a new one, Enter', submitLabel: 'Save', onSubmit: (v) => saveApiKey($, v) }),
    Box({
      flexDirection: 'row',
      gap: 1,
      children: [
        Select({ key: 'fanyi-model', label: 'Model', value: s.model, options, onSelect: (v) => updateSettings($, { model: v }) }),
        Button({ key: 'fanyi-refresh-models', label: '↻ Refresh', plain: true, dimColor: true, onPress: () => loadModels($) }),
      ],
    }),
    Input({ key: 'fanyi-model-id', label: 'Custom model', value: '', placeholder: 'model id, for an API that lists none', submitLabel: 'Use', onSubmit: (v) => v.trim() && updateSettings($, { model: v.trim() }) }),
    Text({ dimColor: true, children: listNote }),
  ]
}

export function register(on, options = {}) {
  if (options.base_url) DEFAULT_SETTINGS.base_url = options.base_url
  if (options.model) DEFAULT_SETTINGS.model = options.model

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fanyi',
      description: 'Translation: /fanyi toggles it, /fanyi on|off sets it, /fanyi settings opens the settings',
      argumentHint: '[on|off|settings]',
    })
    await getSettings($)
    return next(e)
  })

  // /fanyi flips it; /fanyi on|off sets it; /fanyi settings opens the pane
  on('command.run', { command: 'fanyi' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'settings') {
      await openSettings($)
      return {}
    }
    if (arg && arg !== 'on' && arg !== 'off') return { text: 'Usage: /fanyi, /fanyi on, /fanyi off or /fanyi settings' }
    const value = arg ? arg === 'on' : !(await isEnabled($))
    await updateSettings($, { enabled: value })
    return { text: value ? 'Fanyi on: prompts in your language are translated to English, replies get a translation.' : 'Fanyi off: prompts are sent as typed, replies are not translated.' }
  })

  // A one-line toggle above the prompt: "Fanyi ● On  ⚙", clicked or pressed
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const drawn = await next(e)
    if (e.props.hasSurvey) return drawn
    const s = await getSettings($)
    const isOn = s.enabled
    const { Box, Text, Button } = $.ui.resolve(e)
    const toggle = Box({
      flexDirection: 'row',
      gap: 1,
      children: [
        Text({ dimColor: true, children: 'Fanyi' }),
        Text({ color: isOn ? 'green' : undefined, dimColor: !isOn, children: isOn ? '●' : '○' }),
        Button({
          key: 'fanyi-toggle',
          label: isOn ? 'On' : 'Off',
          plain: true,
          dimColor: !isOn,
          onPress: () => updateSettings($, { enabled: !isOn }),
        }),
        Text({ dimColor: true, children: '·' }),
        Button({ key: 'fanyi-settings', label: '⚙', plain: true, dimColor: true, onPress: () => openSettings($) }),
      ],
    })
    return drawn ? Box({ flexDirection: 'column', children: [toggle, drawn] }) : toggle
  })

  // The settings pane: one picker per setting, applied as soon as it's picked
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = await getSettings($)
    const { Box, Text, Select, Button, Input } = $.ui.resolve(e)
    const apple = 'Apple on-device' + (appleCaps === null ? ' (checking…)' : appleCaps.available ? '' : ' (unavailable)')
    const languages = LANGUAGES.some(([tag]) => tag === s.language) ? LANGUAGES : [[s.language, s.language], ...LANGUAGES]
    return Box({
      flexDirection: 'column',
      children: [
        Select({
          key: 'fanyi-enabled',
          label: 'Translation',
          value: s.enabled ? 'on' : 'off',
          options: [
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ],
          autoFocus: true,
          onSelect: (v) => updateSettings($, { enabled: v === 'on' }),
        }),
        Select({
          key: 'fanyi-engine',
          label: 'Engine',
          value: s.engine,
          options: [
            { value: 'api', label: 'API · ' + s.model },
            { value: 'apple', label: apple },
          ],
          onSelect: (v) => chooseEngine($, v),
        }),
        Select({
          key: 'fanyi-language',
          label: 'Your language',
          value: s.language,
          options: languages.map(([value, label]) => ({ value, label })),
          onSelect: (v) => updateSettings($, { language: v }),
        }),
        Select({
          key: 'fanyi-detection',
          label: 'Detection',
          value: s.detection,
          options: [
            { value: 'device', label: 'On this Mac' },
            { value: 'model', label: 'Ask the model' },
          ],
          onSelect: (v) => updateSettings($, { detection: v }),
        }),
        ...apiSection($, s, { Box, Text, Select, Button, Input }),
        Box({ marginTop: 1, children: [Text({ dimColor: true, children: settingsNote(s) })] }),
        Box({ marginTop: 1, children: [Button({ key: 'fanyi-close', label: 'Close', onPress: () => $.ui.close({ id: PANE }) })] }),
      ],
    })
  })

  // Input: a prompt in the user's language reaches Claude in English; the server decides
  // whether it needs translating
  on('prompt.submit', async ($, e, next) => {
    const t = e.text
    if (!t.trim() || t.startsWith('/') || t.startsWith('!')) return next(e)
    if (!(await isEnabled($))) return next(e)
    const en = await translate($, t, 'en')
    if (!en) return next(e)
    remember(prompts, en, t)
    save($, 'prompts', en, t)
    return next({ ...e, text: en })
  })

  // Output: once a reply block of the main conversation is stored, translate it in the
  // background so Claude's next step isn't held up
  on('session.append', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || e.message.type !== 'assistant') return result
    if (!(await isEnabled($))) return result
    for (const block of e.message.content) {
      const key = block.type === 'text' ? block.text.trim() : ''
      if (key && !replies.has(key)) {
        await entryFor($, block.text)
        $.ui.invalidate('ui.render')
      }
    }
    return result
  })

  // Display: keep Claude Code's own drawing of the reply and add a dim rounded box with
  // the translation under it, updated as it streams
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!(await isEnabled($))) return next(e)
    const key = e.props.text.trim()
    let entry = replies.get(key)
    // A block drawn with no translation in memory: its drawn text differs from the stored one
    // (the transcript can redraw a reply), the session was resumed or restarted, or its
    // translation failed. A saved translation is drawn as is; anything else is translated.
    if (!entry && key) entry = await entryFor($, e.props.text)
    const drawn = await next(e)
    if (!entry || entry.skipped) return drawn
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const title = entry.done ? 'Translation' : entry.retrying ? 'Translation · retrying…' : 'Translation · streaming…'
    const body = entry.text
      ? Markdown({ text: entry.text })
      : Text({ dimColor: true, italic: true, children: 'Translating…' })
    return Box({
      flexDirection: 'column',
      children: [
        drawn,
        Box({
          flexDirection: 'column',
          marginLeft: 2,
          marginTop: 1,
          paddingX: 1,
          borderStyle: 'round',
          borderDimColor: true,
          children: [Text({ dimColor: true, children: title }), body],
        }),
      ],
    })
  })

  // Display: show the prompt as typed, with the English that was sent dimmed under it
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!(await isEnabled($))) return next(e)
    const original = prompts.get(e.props.text) ?? (await loadSaved($)).prompts.get(e.props.text)
    if (!original) return next(e)
    const drawn = await next({ ...e, props: { ...e.props, text: original } })
    const { Box, Text } = $.ui.resolve(e)
    return Box({
      flexDirection: 'column',
      // Indented as a whole, so a long line wraps under itself
      children: [drawn, Box({ marginLeft: 2, children: [Text({ dimColor: true, children: '→ ' + e.props.text })] })],
    })
  })

  // Display: the question dialog (AskUserQuestion) with its question, header and descriptions
  // drawn with their translations. The dialog maps the answer back to the English question, so
  // Claude reads the same answer it would have without the mod.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    if (!(await isEnabled($))) return next(e)
    const asked = e.props.questions
    if (!Array.isArray(asked) || !asked.every((q) => q && typeof q === 'object')) return next(e)
    const questions = await translateQuestions($, asked)
    if (!questions) return next(e)
    return next({ ...e, props: { ...e.props, questions } })
  })

  // Display: a tool row whose title is the call's `description` (Bash, Agent) shows the
  // translation under it
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await isEnabled($))) return next(e)
    const input = e.props.input
    if (e.props.tool === 'AskUserQuestion') {
      const t = await translateAnswered($, input, e.props.output)
      return next(t ? { ...e, props: { ...e.props, input: t.input, ...(e.props.output !== undefined && { output: t.output }) } } : e)
    }
    if (!input || typeof input !== 'object' || typeof input.description !== 'string') return next(e)
    const [translated] = await translations($, [input.description])
    if (!translated) return next(e)
    return next({ ...e, props: { ...e.props, input: { ...input, description: bilingual(input.description, translated) } } })
  })

  // Display: the result row of an answered question, where the questions are drawn bilingual
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.tool !== 'AskUserQuestion' || e.props.isErrored || !(await isEnabled($))) return next(e)
    const t = await translateAnswered($, null, e.props.output)
    return next(t ? { ...e, props: { ...e.props, output: t.output } } : e)
  })

  // Input: text typed as an answer to a question (under "Other", or a text question) reaches
  // Claude in English, as a prompt does; an option picked is sent as it is
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const r = await next(e)
    if (!r || r.deny || !r.result || typeof r.result !== 'object' || r.isError) return r
    if (!(await isEnabled($))) return r
    const result = await translateAnswers($, e.questions, r.result)
    if (!result) return r
    return { result, ...(r.context && { context: r.context }) }
  })

  // The translator tools are for this mod only: let its own calls through, refuse Claude's
  on('tool.call', { tool: TRANSLATOR_TOOL }, async ($, e, next) => {
    if (next.origin.plugin === $.plugin.name) return next(e)
    return { deny: 'This tool is internal to the fanyi mod. Do not call it.' }
  })
}
