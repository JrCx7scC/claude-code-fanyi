#!/usr/bin/env node
// A dependency-free stdio MCP server that translates for the fanyi mod, through either
// - an OpenAI-compatible Chat Completions API, or
// - Apple's on-device Translation framework (macOS), through the bundled Swift helper,
// and decides whether a text needs translating at all.
//
// The mod passes its settings (engine, language, detection, API host and model) with every call,
// so changing them takes effect at once. The API key is kept here: in the macOS Keychain, or in a
// file only the user can read elsewhere, falling back to the plugin's userConfig.
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { proseOf, splitMarkdown } from './markdown.mjs'

const CONFIG_KEY = process.env.FANYI_API_KEY || ''
const DISABLE_THINKING = process.env.FANYI_DISABLE_THINKING !== 'false'
const DEFAULTS = {
  engine: 'api',
  language: 'zh-Hans',
  detection: 'device',
  base_url: process.env.FANYI_BASE_URL || 'https://opencode.ai/zen/go/v1',
  model: process.env.FANYI_MODEL || 'deepseek-v4.1-flash',
}
const PLUGIN_ROOT = new URL('..', import.meta.url).pathname
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'fanyi')
const VERSION = readVersion()

// What the model outputs instead of a translation when the text is already in the target language
const SKIP = '<<NO_TRANSLATION_NEEDED>>'
// Below this, the on-device recognizer's guess is ignored (short text such as "ok" or a path)
const MIN_CONFIDENCE = 0.6

const INTERNAL = 'Internal helper for the fanyi mod. Do not call this tool.'
const SETTINGS = {
  engine: { type: 'string', enum: ['api', 'apple'] },
  language: { type: 'string', description: 'The user language: a BCP 47 tag or a name' },
  detection: { type: 'string', enum: ['device', 'model'] },
  base_url: { type: 'string', description: 'OpenAI-compatible API base URL' },
  model: { type: 'string', description: 'Model id at that API' },
}
const TRANSLATE_INPUT = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    // en: the user's text, for Claude; local: Claude's text, for the user
    to: { type: 'string', enum: ['en', 'local'] },
    session: { type: 'string', description: 'Stable per-conversation id, sent as x-opencode-session' },
    ...SETTINGS,
  },
  required: ['text', 'to'],
}
const TOOLS = [
  // One-shot: returns { text } or { skipped }
  { name: 'translate', description: INTERNAL, inputSchema: TRANSLATE_INPUT },
  // Streaming: start returns { job } or { skipped } at once, poll returns the translation so far
  { name: 'translate_start', description: INTERNAL, inputSchema: TRANSLATE_INPUT },
  {
    name: 'translate_poll',
    description: INTERNAL,
    inputSchema: { type: 'object', properties: { job: { type: 'string' } }, required: ['job'] },
  },
  // What this machine offers: { apple: { available, reason? } }
  { name: 'capabilities', description: INTERNAL, inputSchema: { type: 'object', properties: {} } },
  // The models an API offers: { models: [id, ...] }
  {
    name: 'list_models',
    description: INTERNAL,
    inputSchema: { type: 'object', properties: { base_url: SETTINGS.base_url, session: { type: 'string' } } },
  },
  // Whether an API key is set, and where: { isSet, source, hint }
  { name: 'api_key_status', description: INTERNAL, inputSchema: { type: 'object', properties: {} } },
  // Saves an API key; an empty one removes the saved key
  {
    name: 'set_api_key',
    description: INTERNAL,
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
]

function readVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin/plugin.json'), 'utf8')).version || 'dev'
  } catch {
    return 'dev'
  }
}

// ---------------------------------------------------------------------------------------------
// Languages

const languages = new Map()

// A BCP 47 tag such as zh-Hans, ja or es, or a plain name such as "Simplified Chinese". A tag
// gives an English name for the prompts, the tag Apple's frameworks take and, for a language not
// written in Latin script, a pattern that tells its text apart from English at no cost.
function describeLanguage(value) {
  if (languages.has(value)) return languages.get(value)
  let info
  try {
    const locale = new Intl.Locale(value).maximize()
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(value) || value
    const scripts = { Hans: 'Han', Hant: 'Han', Jpan: 'Han|Hiragana|Katakana', Kore: 'Hangul|Han' }[locale.script] || locale.script
    const pattern = locale.script === 'Latn' ? null : new RegExp(scripts.split('|').map((s) => `\\p{Script=${s}}`).join('|'), 'gu')
    info = { name, tag: value, base: locale.language, isEnglish: locale.language === 'en', pattern }
  } catch {
    // Not a tag: used as the name, and neither the script nor Apple's frameworks can help
    info = { name: value, tag: null, base: null, isEnglish: false, pattern: null }
  }
  languages.set(value, info)
  return info
}

const baseOf = (tag) => (tag ? tag.split(/[-_]/)[0].toLowerCase() : null)

// Whether two tags name the same language in the same script: zh-Hans and zh-CN are the same,
// zh-Hant and zh-Hans aren't, since translating between them is a real conversion
function sameLanguage(a, b) {
  try {
    const x = new Intl.Locale(a).maximize()
    const y = new Intl.Locale(b).maximize()
    return x.language === y.language && x.script === y.script
  } catch {
    return baseOf(a) === baseOf(b)
  }
}

// Whether a text needs translating: true or false when it can be decided here, null when only the
// model can tell. In order: the script, for a language not written in Latin script; the
// on-device recognizer, when detection is 'device' and it's available; otherwise the model.
async function needsTranslation(text, to, settings) {
  const lang = describeLanguage(settings.language)
  if (lang.isEnglish) return false
  // Judge the prose only: identifiers and commands in code would count as English
  const prose = proseOf(text)
  if (!/\p{L}/u.test(prose)) return false
  text = prose
  if (lang.pattern) {
    const local = (text.match(lang.pattern) || []).length
    // Toward English: any text in the user's script. Toward the user's language: text that is
    // mostly something else, so an English reply quoting a word of theirs is still translated.
    if (to === 'en') return local > 0
    const letters = (text.match(/\p{L}/gu) || []).length
    return letters > 0 && local / letters < 0.5
  }
  if (settings.detection === 'device' && (await appleStatus()).available) {
    const { language, confidence } = await helper({ op: 'detect', text })
    // Too short or mixed to tell: leave it as it is
    if (!language || confidence < MIN_CONFIDENCE) return false
    return to === 'en' ? baseOf(language) !== 'en' : baseOf(language) !== lang.base
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Apple: the Swift helper, compiled on this Mac the first time it's needed

const execFileP = promisify(execFile)
const SWIFT_SOURCE = join(PLUGIN_ROOT, 'apple/FanyiApple.swift')
let apple = null
let child = null
const pending = new Map()
let nextRequest = 1

// Whether the Apple engine can run here, compiling the helper on first use
function appleStatus() {
  if (!apple) apple = buildHelper().then((path) => ({ available: true, path }), (err) => ({ available: false, reason: String(err.message || err) }))
  return apple
}

async function buildHelper() {
  if (process.platform !== 'darwin') throw new Error('Apple Translation needs macOS')
  const source = readFileSync(SWIFT_SOURCE)
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12)
  const path = join(DATA_DIR, `fanyi-apple-${hash}`)
  if (existsSync(path)) return path
  mkdirSync(DATA_DIR, { recursive: true })
  const building = `${path}.${process.pid}.tmp`
  try {
    await execFileP('xcrun', ['swiftc', '-parse-as-library', '-O', SWIFT_SOURCE, '-o', building], { timeout: 300_000 })
  } catch (err) {
    const why = String(err.stderr || err.message || err).trim().split('\n').slice(-3).join(' ')
    throw new Error('Could not build the Apple helper (needs the Xcode command line tools, macOS 15 or later): ' + why)
  }
  renameSync(building, path)
  return path
}

// Sends one request to the helper, starting it when it isn't running
async function helper(request) {
  const status = await appleStatus()
  if (!status.available) throw new Error(status.reason)
  if (!child) {
    child = spawn(status.path, [], { stdio: ['pipe', 'pipe', 'ignore'] })
    createInterface({ input: child.stdout }).on('line', (line) => {
      let reply
      try {
        reply = JSON.parse(line)
      } catch {
        return
      }
      const waiter = pending.get(reply.id)
      if (!waiter) return
      pending.delete(reply.id)
      if (reply.error) waiter.reject(new Error(reply.error))
      else waiter.resolve(reply)
    })
    child.on('exit', () => {
      child = null
      for (const waiter of pending.values()) waiter.reject(new Error('The Apple helper stopped'))
      pending.clear()
    })
  }
  const id = nextRequest++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ ...request, id }) + '\n')
  })
}

async function translateApple({ text, to }, settings) {
  const lang = describeLanguage(settings.language)
  if (!lang.tag) throw new Error('Apple Translation needs the language as a tag such as zh-Hans, not a name')
  let from = lang.tag
  let target = 'en'
  if (to === 'local') {
    // Claude usually writes English; ask the recognizer in case it didn't
    const { language, confidence } = await helper({ op: 'detect', text: proseOf(text) })
    from = language && confidence >= MIN_CONFIDENCE ? language : 'en'
    target = lang.tag
  }
  // Already in the target language (a mixed reply the script check let through): nothing to do
  if (sameLanguage(from, target)) return SKIP
  const { segments, rebuild } = splitMarkdown(text)
  if (!segments.length) return text
  const { texts } = await helper({ op: 'translate', from, to: target, texts: segments })
  return rebuild(texts)
}

// ---------------------------------------------------------------------------------------------
// API key: saved from the settings pane, else the plugin's userConfig

const KEYCHAIN = ['-s', 'claude-code-fanyi', '-a', 'api-key']
const KEY_FILE = join(DATA_DIR, 'api-key')
// { key, source } once read
let savedKey = null

async function readSavedKey() {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileP('security', ['find-generic-password', ...KEYCHAIN, '-w'])
      return stdout.trim()
    } catch {
      return ''
    }
  }
  try {
    return readFileSync(KEY_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

async function apiKey() {
  if (!savedKey) {
    const key = await readSavedKey()
    savedKey = key ? { key, source: process.platform === 'darwin' ? 'keychain' : 'file' } : { key: CONFIG_KEY, source: CONFIG_KEY ? 'config' : null }
  }
  return savedKey
}

async function setApiKey({ key }) {
  key = (key || '').trim()
  if (process.platform === 'darwin') {
    if (key) await execFileP('security', ['add-generic-password', '-U', ...KEYCHAIN, '-l', 'Claude Code fanyi API key', '-w', key])
    else await execFileP('security', ['delete-generic-password', ...KEYCHAIN]).catch(() => {})
  } else if (key) {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(KEY_FILE, key + '\n', { mode: 0o600 })
    chmodSync(KEY_FILE, 0o600)
  } else {
    rmSync(KEY_FILE, { force: true })
  }
  savedKey = null
  return apiKeyStatus()
}

async function apiKeyStatus() {
  const { key, source } = await apiKey()
  return JSON.stringify({ isSet: Boolean(key), source, hint: key ? '…' + key.slice(-4) : null })
}

// ---------------------------------------------------------------------------------------------
// API

function prompts(lang) {
  const rules = `Keep code, file paths, commands, identifiers and markdown unchanged. Output only the translation. If the text is already written entirely in the target language, output exactly ${SKIP} and nothing else.`
  return {
    en: `The user of a coding assistant writes in ${lang.name}. Translate the text into natural English for the assistant. ${rules}`,
    local: `Translate the text into ${lang.name}. ${rules}`,
  }
}

async function apiHeaders(session) {
  const { key } = await apiKey()
  if (!key) throw new Error('No API key set. Open /fanyi settings and enter one.')
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + key,
    // OpenCode Go requires a custom User-Agent and a stable per-conversation session id
    'User-Agent': 'claude-code-fanyi/' + VERSION,
    'x-opencode-session': session || 'fanyi-default',
  }
}

const baseUrl = (url) => url.replace(/\/+$/, '')

// An HTTP failure as one short line; an HTML error page is reduced to its status
function httpError(status, body) {
  const text = /^\s*</.test(body) ? '' : ' ' + body.slice(0, 200)
  return new Error('HTTP ' + status + text)
}

// Models that refuse to run with reasoning turned off (thinking-only models), learned on first use
const mustThink = new Set()

// Sends a chat request; when the model refuses `thinking: disabled`, sends it again without it
async function chat(args, settings, stream) {
  let res = await request(args, settings, stream)
  if (res.status === 400 && DISABLE_THINKING && !mustThink.has(settings.model)) {
    const body = await res.text()
    if (!/think|reason/i.test(body)) throw httpError(res.status, body)
    mustThink.add(settings.model)
    res = await request(args, settings, stream)
  }
  if (!res.ok) throw httpError(res.status, await res.text())
  return res
}

async function request({ text, to, session }, settings, stream) {
  const system = prompts(describeLanguage(settings.language))[to]
  if (!system) throw new Error('Unsupported direction: ' + to)
  return fetch(baseUrl(settings.base_url) + '/chat/completions', {
    method: 'POST',
    headers: await apiHeaders(session),
    body: JSON.stringify({
      model: settings.model,
      stream,
      // Translation needs no reasoning; turning it off cuts time to first token from
      // 6–15 s to about 1.5 s on DeepSeek. Providers that reject the field can turn it off.
      ...(DISABLE_THINKING && !mustThink.has(settings.model) && { thinking: { type: 'disabled' } }),
      max_tokens: 8192,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  })
}

async function listModels({ base_url, session }) {
  const res = await fetch(baseUrl(base_url || DEFAULTS.base_url) + '/models', {
    headers: await apiHeaders(session),
    signal: AbortSignal.timeout(30_000),
  })
  const body = await res.text()
  if (!res.ok) throw httpError(res.status, body)
  const ids = (JSON.parse(body).data || []).map((m) => m.id).filter((id) => typeof id === 'string')
  if (!ids.length) throw new Error('The API listed no models')
  return JSON.stringify({ models: [...new Set(ids)].sort() })
}

async function translateApi(args, settings) {
  const res = await chat(args, settings, false)
  const body = await res.text()
  const out = (JSON.parse(body).choices?.[0]?.message?.content || '').trim()
  if (!out) throw new Error('The API returned an empty translation')
  return out
}

// Reads the SSE stream and appends each content delta to the job
async function streamApi(job, args, settings) {
  const res = await chat(args, settings, true)
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      // Content only; reasoning_content is skipped
      const delta = JSON.parse(data).choices?.[0]?.delta?.content
      if (delta) job.text += delta
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Tools

const settingsOf = (args) => ({
  engine: args.engine || DEFAULTS.engine,
  language: args.language || DEFAULTS.language,
  detection: args.detection || DEFAULTS.detection,
  base_url: args.base_url || DEFAULTS.base_url,
  model: args.model || DEFAULTS.model,
})

async function translate(args) {
  const settings = settingsOf(args)
  if ((await needsTranslation(args.text, args.to, settings)) === false) return JSON.stringify({ skipped: true })
  const out = settings.engine === 'apple' ? await translateApple(args, settings) : await translateApi(args, settings)
  // A model asked to judge sometimes copies the text back instead of answering with the marker
  const same = out.trim() === args.text.trim()
  return JSON.stringify(out.trim() === SKIP || same ? { skipped: true } : { text: out })
}

// Job id → { text, done, error, skipped }
const jobs = new Map()
let nextJob = 1

async function startJob(args) {
  const settings = settingsOf(args)
  if ((await needsTranslation(args.text, args.to, settings)) === false) return JSON.stringify({ skipped: true })
  const id = String(nextJob++)
  const job = { text: '', done: false, error: null }
  jobs.set(id, job)
  runJob(job, args, settings)
  return JSON.stringify({ job: id })
}

async function runJob(job, args, settings) {
  try {
    // Apple translates a whole block at once (well under a second); the API streams
    if (settings.engine === 'apple') job.text = await translateApple(args, settings)
    else await streamApi(job, args, settings)
    if (!job.text.trim()) throw new Error('The translation came back empty')
  } catch (err) {
    job.error = String(err.message || err)
  }
  job.done = true
}

function pollJob({ job: id }) {
  const job = jobs.get(id)
  if (!job) throw new Error('Unknown job: ' + id)
  // A finished job is dropped once it has been read
  if (job.done) jobs.delete(id)
  const text = job.text.trim()
  if (text === SKIP) return JSON.stringify({ skipped: true, done: job.done, error: null })
  // Text that may still turn out to be the skip marker is held back
  const shown = SKIP.startsWith(text) ? '' : text
  return JSON.stringify({ text: shown, done: job.done, error: job.error })
}

async function capabilities() {
  const status = await appleStatus()
  return JSON.stringify({ apple: status.available ? { available: true } : { available: false, reason: status.reason } })
}

// ---------------------------------------------------------------------------------------------
// MCP over stdio

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
}

async function handle(req) {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: req.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fanyi-translator', version: VERSION },
      }
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call': {
      const args = req.params?.arguments || {}
      const run = {
        translate,
        translate_start: startJob,
        translate_poll: pollJob,
        capabilities,
        list_models: listModels,
        api_key_status: apiKeyStatus,
        set_api_key: setApiKey,
      }[req.params?.name]
      if (!run) throw new Error('Unknown tool: ' + req.params?.name)
      try {
        return { content: [{ type: 'text', text: await run(args) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: String(err.message || err) }], isError: true }
      }
    }
    case 'ping':
      return {}
    default:
      throw Object.assign(new Error('Method not found: ' + req.method), { code: -32601 })
  }
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } })
  }
  // Notifications have no id and get no reply
  if (req.id === undefined) return
  try {
    send({ id: req.id, result: await handle(req) })
  } catch (err) {
    send({ id: req.id, error: { code: err.code || -32603, message: String(err.message || err) } })
  }
})
