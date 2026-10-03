import { expect, mock, test } from 'claude-code/testing'
import { blockKey } from '../hooks/register.js'

// The streaming path (session.append → poll → redraw) needs the engine to store rows,
// which the test kit cannot stand in for, so it is checked in a real session.

test('a reply block with no translation draws unchanged', { options: { api_key: 'test-key' } }, async ($, on) => {
  let drawn = ''
  on('ui.render', { component: 'AssistantMessage' }, async ($, e) => {
    drawn = e.props.text
    const { Text } = $.ui.resolve(e)
    return Text({ children: drawn })
  })
  await $.ui.render({ component: 'AssistantMessage', surface: 'terminal', props: { text: 'untouched', isFirstOfReply: true } } as any)
  expect(drawn).toBe('untouched')
})

// The translator server, stood in for beneath the plugin: `fail` attempts fail first.
function translator(on: any, { fail = 0, offline = 0, apple = null as any, mergeBatches = false } = {}) {
  const calls: string[] = []
  let failures = fail
  // The server is not connected for its first `offline` connection attempts (a session starting)
  let down = offline
  on('mcp.connect', async ($: any, e: any) => {
    calls.push('connect')
    if (down > 0) { down--; return { value: { isConnected: false, reason: 'pending', message: 'starting' } } }
    return { value: { isConnected: true, server: 'plugin:fanyi:translator' } }
  })
  // The session id the plugin sends along, and its log lines
  on('session.id', async () => ({ value: 'test-session' }))
  const logged: string[] = []
  on('ui.log', async ($: any, e: any) => { logged.push(String(e?.text ?? e)); return { value: undefined } })
  on('mcp.call', async ($: any, e: any) => {
    calls.push(e.tool)
    ;(calls as any).lastArgs = e.args
    if (down > 0) return { value: { isError: true, content: [{ type: 'text', text: 'no connected MCP tool "' + e.tool + '"' }] } }
    if (e.tool === 'translate_start') {
      if (failures > 0) { failures--; return { value: { isError: true, content: [{ type: 'text', text: 'HTTP 429 rate limited' }] } } }
      if (/^Already /.test(e.args?.text ?? '')) return { value: { content: [{ type: 'text', text: JSON.stringify({ skipped: true }) }] } }
      return { value: { content: [{ type: 'text', text: JSON.stringify({ job: 'job-' + calls.length }) }] } }
    }
    if (e.tool === 'list_models') return { value: { content: [{ type: 'text', text: JSON.stringify({ models: ['deepseek-v4.1-flash', 'glm-5.3', 'kimi-k3'] }) }] } }
    if (e.tool === 'api_key_status') return { value: { content: [{ type: 'text', text: JSON.stringify({ isSet: true, source: 'config', hint: '…abcd' }) }] } }
    if (e.tool === 'set_api_key') return { value: { content: [{ type: 'text', text: JSON.stringify({ isSet: !!e.args.key, source: 'keychain', hint: e.args.key ? '…' + e.args.key.slice(-4) : null }) }] } }
    if (e.tool === 'capabilities') return { value: { content: [{ type: 'text', text: JSON.stringify({ apple: apple ?? { available: true } }) }] } }
    if (e.tool === 'translate') {
      const text = e.args?.text ?? ''
      if (/^Already /.test(text)) return { value: { content: [{ type: 'text', text: JSON.stringify({ skipped: true }) }] } }
      // To the user's language: each numbered line of a batch translated in place, unless the
      // stand-in is told to merge them (a model that ignores the numbering)
      if (e.args?.to === 'local') {
        const out = mergeBatches && /\n/.test(text) ? '译:' + text.replace(/\n/g, ' ') : text.split('\n').map((l: string) => l.replace(/^(\d+\. )?/, '$1译:')).join('\n')
        return { value: { content: [{ type: 'text', text: JSON.stringify({ text: out }) }] } }
      }
      return { value: { content: [{ type: 'text', text: JSON.stringify({ text: 'EN: ' + text }) }] } }
    }
    if (e.tool === 'translate_poll') return { value: { content: [{ type: 'text', text: JSON.stringify({ text: '译文：' + 'ok', done: true, error: null }) }] } }
    return { value: { isError: true, content: [{ type: 'text', text: 'unexpected ' + e.tool }] } }
  })
  ;(calls as any).logged = logged
  return calls
}
const draw = ($: any, text: string) =>
  $.ui.render({ component: 'AssistantMessage', surface: 'terminal', props: { text, isFirstOfReply: true } } as any)
const shows = (tree: unknown, s: string) => JSON.stringify(tree).includes(s)

test('a block drawn with no translation yet (redrawn text, a resumed session) is translated as drawn', { options: { api_key: 'k' } }, async ($, on) => {
  const clock = mock.clock(on)
  const calls = translator(on)
  on('ui.render', { component: 'AssistantMessage' }, async ($, e) => $.ui.resolve(e).Text({ children: e.props.text }))
  expect(shows(await draw($, 'Drawn text that was never stored as is.'), 'Translating')).toBe(true)
  await clock.advance(1000)
  expect(calls).toContain('translate_start')
  expect(shows(await draw($, 'Drawn text that was never stored as is.'), '译文：ok')).toBe(true)
})

test('a failed translation is retried, the box saying so meanwhile', { options: { api_key: 'k' } }, async ($, on) => {
  const clock = mock.clock(on)
  const calls = translator(on, { fail: 2 })
  on('ui.render', { component: 'AssistantMessage' }, async ($, e) => $.ui.resolve(e).Text({ children: e.props.text }))
  await draw($, 'A block whose first attempts are rate limited.')
  await clock.advance(100)
  expect(shows(await draw($, 'A block whose first attempts are rate limited.'), 'retrying')).toBe(true)
  await clock.advance(10000)
  expect(calls.filter((c) => c === 'translate_start').length).toBe(3)
  expect(shows(await draw($, 'A block whose first attempts are rate limited.'), '译文：ok')).toBe(true)
})

// The plugin's store, stood in for beneath the plugin: what a resumed session finds on disk.
function store(on: any, initial: Record<string, unknown> = {}) {
  const kept = new Map<string, unknown>(Object.entries(initial))
  on('store.get', async ($: any, e: any) => ({ value: kept.get(e.key) }))
  on('store.set', async ($: any, e: any) => { kept.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined } })
  on('store.keys', async () => ({ value: [...kept.keys()] }))
  on('store.delete', async ($: any, e: any) => { kept.delete(e.key); return { value: undefined } })
  return kept
}

test('a resumed session draws a block translated before from the store, without calling the API', { options: { api_key: 'k' } }, async ($, on) => {
  const clock = mock.clock(on)
  const calls = translator(on)
  const text = 'A reply block translated in an earlier session.'
  store(on, { 'translations:api:deepseek-v4.1-flash:zh-Hans': { v: 1, replies: [[blockKey(text), '早先的译文']], prompts: [['Translate me', '翻译我']] } })
  on('ui.render', { component: 'AssistantMessage' }, async ($, e) => $.ui.resolve(e).Text({ children: e.props.text }))
  on('ui.render', { component: 'UserMessage' }, async ($, e) => $.ui.resolve(e).Text({ children: e.props.text }))
  expect(shows(await draw($, text), '早先的译文')).toBe(true)
  await clock.advance(10000)
  expect(calls.filter((c) => c !== 'connect')).toEqual([])
  // The prompt typed in Chinese still shows as typed after the resume.
  const prompt = await $.ui.render({ component: 'UserMessage', surface: 'terminal', props: { text: 'Translate me' } } as any)
  expect(shows(prompt, '翻译我')).toBe(true)
})

test('a finished translation is saved to the store, so a later session does not pay for it again', { options: { api_key: 'k' } }, async ($, on) => {
  const clock = mock.clock(on)
  translator(on)
  const kept = store(on)
  const text = 'A reply block translated for the first time.'
  on('ui.render', { component: 'AssistantMessage' }, async ($, e) => $.ui.resolve(e).Text({ children: e.props.text }))
  await draw($, text)
  await clock.advance(5000)
  const saved = kept.get('translations:api:deepseek-v4.1-flash:zh-Hans') as any
  expect(saved?.v).toBe(1)
  expect(new Map(saved.replies).get(blockKey(text))).toBe('译文：ok')
})

test('/fanyi turns it off and on: off, a reply gets no translation box and nothing is translated', { options: { api_key: 'k' } }, async ($, on) => {
  const clock = mock.clock(on)
  const calls = translator(on)
  const kept = store(on)
  on('ui.render', { component: 'AssistantMessage' }, async ($, e) => $.ui.resolve(e).Text({ children: e.props.text }))
  const off = await $.command.run({ command: 'fanyi', args: 'off' } as any)
  expect(String(off.text)).toContain('off')
  expect((kept.get('settings') as any)?.enabled).toBe(false)
  expect(shows(await draw($, 'A reply while fanyi is off.'), 'Translat')).toBe(false)
  await clock.advance(5000)
  expect(calls.filter((c) => c !== 'connect')).toEqual([])
  const flipped = await $.command.run({ command: 'fanyi', args: '' } as any)
  expect(String(flipped.text)).toContain('on')
  expect((kept.get('settings') as any)?.enabled).toBe(true)
  expect(shows(await draw($, 'A reply while fanyi is off.'), 'Translating')).toBe(true)
  const bad = await $.command.run({ command: 'fanyi', args: 'maybe' } as any)
  expect(String(bad.text)).toContain('Usage')
})

test('a resumed session drawing replies before the translator has connected waits for it, logging no failure', { options: { api_key: 'k' } }, async ($, on) => {
  const clock = mock.clock(on)
  const calls = translator(on, { offline: 3 })
  store(on)
  on('ui.render', { component: 'AssistantMessage' }, async ($, e) => $.ui.resolve(e).Text({ children: e.props.text }))
  expect(shows(await draw($, 'A reply drawn while the translator starts.'), 'Translat')).toBe(true)
  await clock.advance(30000)
  expect(shows(await draw($, 'A reply drawn while the translator starts.'), '译文：ok')).toBe(true)
  expect((calls as any).logged).toEqual([])
})

test('the toggle above the prompt shows On or Off and switches when pressed', { options: { api_key: 'k' } }, async ($, on) => {
  translator(on)
  const kept = store(on)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => $.ui.resolve(e).Box({}))
  const band = () => $.ui.render({ component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false, isWorking: false } } as any)
  expect(shows(await band(), '"On"')).toBe(true)
  await ($.ui as any).press({ plugin: 'fanyi', key: 'fanyi-toggle' })
  expect((kept.get('settings') as any)?.enabled).toBe(false)
  expect(shows(await band(), '"Off"')).toBe(true)
  await ($.ui as any).press({ plugin: 'fanyi', key: 'fanyi-toggle' })
  expect((kept.get('settings') as any)?.enabled).toBe(true)
})

test('a reply already in the user\'s language gets no box, and that is saved', { options: { api_key: 'k' } }, async ($, on) => {
  const clock = mock.clock(on)
  translator(on)
  const kept = store(on)
  on('ui.render', { component: 'AssistantMessage' }, async ($, e) => $.ui.resolve(e).Text({ children: e.props.text }))
  const text = 'Already in the user language.'
  await draw($, text)
  await clock.advance(5000)
  expect(shows(await draw($, text), 'Translat')).toBe(false)
  const saved = kept.get('translations:api:deepseek-v4.1-flash:zh-Hans') as any
  expect(new Map(saved.replies).get(blockKey(text))).toBe('')
})

test('a prompt the server says needs no translation is sent as typed', { options: { api_key: 'k' } }, async ($, on) => {
  translator(on)
  store(on)
  let sent = ''
  on('prompt.submit', async ($, e) => { sent = e.text; return { text: e.text } })
  await $.prompt.submit({ text: 'Already English.' } as any)
  expect(sent).toBe('Already English.')
})

test('a prompt in the user\'s language is sent to Claude in English', { options: { api_key: 'k' } }, async ($, on) => {
  const calls = translator(on)
  store(on)
  let sent = ''
  on('prompt.submit', async ($, e) => { sent = e.text; return { text: e.text } })
  await $.prompt.submit({ text: '解释一下幂等' } as any)
  expect(calls).toContain('translate')
  expect(sent).toBe('EN: 解释一下幂等')
})

const pane = ($: any) => $.ui.render({ component: 'Pane', surface: 'terminal', requestId: 'fanyi-settings', props: { title: 'Fanyi settings', isFocused: true } } as any)

test('the settings pane changes the language, kept in the store and applied to the next call', { options: { api_key: 'k' } }, async ($, on) => {
  const calls = translator(on)
  const kept = store(on)
  on('ui.render', { component: 'Pane' }, async ($, e) => $.ui.resolve(e).Box({}))
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  expect(shows(await pane($), 'zh-Hans')).toBe(true)
  await ($.ui as any).select({ plugin: 'fanyi', key: 'fanyi-language', value: 'ja' })
  expect((kept.get('settings') as any).language).toBe('ja')
  await $.prompt.submit({ text: 'ログインを直して' } as any)
  expect((calls as any).lastArgs?.language).toBe('ja')
})

test('picking Apple on-device where it is unavailable keeps the engine and says why', { options: { api_key: 'k' } }, async ($, on) => {
  const clock = mock.clock(on)
  translator(on, { apple: { available: false, reason: 'Apple Translation needs macOS' } })
  const kept = store(on)
  const toasts: string[] = []
  on('ui.toast', async ($: any, e: any) => { toasts.push(String(e?.text ?? e)); return { value: undefined } })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.render', { component: 'Pane' }, async ($, e) => $.ui.resolve(e).Box({}))
  await $.command.run({ command: 'fanyi', args: 'settings' } as any)
  await clock.advance(10)
  expect(shows(await pane($), 'unavailable')).toBe(true)
  await ($.ui as any).select({ plugin: 'fanyi', key: 'fanyi-engine', value: 'apple' })
  expect((kept.get('settings') as any)?.engine ?? 'api').toBe('api')
  expect(toasts.join(' ')).toContain('needs macOS')
})

test('the settings pane lists the API\'s models, and the one picked is used for the next translation', { options: { api_key: 'k' } }, async ($, on) => {
  const clock = mock.clock(on)
  const calls = translator(on)
  const kept = store(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.render', { component: 'Pane' }, async ($, e) => $.ui.resolve(e).Box({}))
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  await $.command.run({ command: 'fanyi', args: 'settings' } as any)
  await clock.advance(10)
  const drawn = await pane($)
  expect(shows(drawn, 'kimi-k3')).toBe(true)
  expect(shows(drawn, '…abcd')).toBe(true)
  await ($.ui as any).select({ plugin: 'fanyi', key: 'fanyi-model', value: 'glm-5.3' })
  expect((kept.get('settings') as any).model).toBe('glm-5.3')
  await $.prompt.submit({ text: '解释一下' } as any)
  expect((calls as any).lastArgs?.model).toBe('glm-5.3')
})

test('an API key entered in the pane is saved through the translator, and the pane shows only its end', { options: { api_key: 'k' } }, async ($, on) => {
  const clock = mock.clock(on)
  const calls = translator(on)
  store(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.render', { component: 'Pane' }, async ($, e) => $.ui.resolve(e).Box({}))
  await $.command.run({ command: 'fanyi', args: 'settings' } as any)
  await clock.advance(10)
  await pane($)
  await ($.ui as any).input({ plugin: 'fanyi', key: 'fanyi-api-key', text: 'sk-secret-wxyz' })
  expect(calls).toContain('set_api_key')
  const drawn = await pane($)
  expect(shows(drawn, '…wxyz')).toBe(true)
  expect(shows(drawn, 'sk-secret')).toBe(false)
})

// The question dialog and tool rows: short strings translated in one batch and drawn in place

const QUESTIONS = [
  {
    question: 'Which one do you want?',
    header: 'Choice',
    multiSelect: false,
    options: [
      { label: 'Alpha', description: 'The first one' },
      { label: 'Beta', description: 'The second one' },
    ],
  },
]
const askDialog = ($: any, on: any) => {
  let seen: any = null
  on('ui.render', { component: 'AskUserQuestion' }, async ($: any, e: any) => {
    seen = e.props.questions
    return $.ui.resolve(e).Text({ children: 'dialog' })
  })
  return async () => {
    await $.ui.render({ component: 'AskUserQuestion', surface: 'terminal', props: { tool: 'AskUserQuestion', questions: QUESTIONS } } as any)
    return seen
  }
}

test('the question dialog draws the English first, then the question with its translation under it and each description with its translation after it, labels kept', { options: { api_key: 'k' } }, async ($, on) => {
  const clock = mock.clock(on)
  const calls = translator(on)
  const draw = askDialog($, on)
  expect(await draw()).toEqual(QUESTIONS)
  await clock.advance(100)
  expect(calls.filter((c) => c === 'translate').length).toBe(1)
  expect((calls as any).lastArgs.to).toBe('local')
  expect((calls as any).lastArgs.text).toBe('1. Which one do you want?\n2. Choice\n3. Alpha\n4. The first one\n5. Beta\n6. The second one')
  const drawn = await draw()
  expect(drawn[0].question).toBe('Which one do you want?\n译:Which one do you want?')
  expect(drawn[0].header).toBe('译:Choice')
  expect(drawn[0].multiSelect).toBe(false)
  expect(drawn[0].options.map((o: any) => o.label)).toEqual(['Alpha', 'Beta'])
  expect(drawn[0].options[0].description).toBe('The first one → 译:Alpha · 译:The first one')
  expect(drawn[0].options[1].description).toBe('The second one → 译:Beta · 译:The second one')
})

test('a batch the model merged is translated phrase by phrase instead', { options: { api_key: 'k' } }, async ($, on) => {
  const clock = mock.clock(on)
  const calls = translator(on, { mergeBatches: true })
  const draw = askDialog($, on)
  await draw()
  await clock.advance(100)
  // One batch, then one call per phrase
  expect(calls.filter((c) => c === 'translate').length).toBe(7)
  const drawn = await draw()
  expect(drawn[0].question).toBe('Which one do you want?\n译:Which one do you want?')
  expect(drawn[0].options[1].description).toBe('The second one → 译:Beta · 译:The second one')
})

test('a tool row whose title is its description shows the translation under it', { options: { api_key: 'k' } }, async ($, on) => {
  const clock = mock.clock(on)
  const calls = translator(on)
  let seen: any = null
  on('ui.render', { component: 'ToolUse' }, async ($: any, e: any) => {
    seen = e.props.input
    return $.ui.resolve(e).Text({ children: 'row' })
  })
  const row = (input: any) =>
    $.ui.render({ component: 'ToolUse', surface: 'terminal', props: { tool_use_id: 'toolu_1', tool: 'Bash', input, isRunning: false, isErrored: false, isInterrupted: false } } as any)
  await row({ command: 'ls', description: 'List the files' })
  expect(seen.description).toBe('List the files')
  await clock.advance(100)
  await row({ command: 'ls', description: 'List the files' })
  expect(seen).toEqual({ command: 'ls', description: 'List the files\n译:List the files' })
  // A row with no description is left alone and costs no call
  const before = calls.filter((c) => c === 'translate').length
  await row({ file_path: '/tmp/x' })
  expect(seen).toEqual({ file_path: '/tmp/x' })
  await clock.advance(100)
  expect(calls.filter((c) => c === 'translate').length).toBe(before)
})

test('the row of an answered question draws each question bilingual, its answers re-keyed to match', { options: { api_key: 'k' } }, async ($, on) => {
  const clock = mock.clock(on)
  translator(on)
  let seen: any = null
  on('ui.render', { component: 'ToolUse' }, async ($: any, e: any) => {
    seen = e.props
    return $.ui.resolve(e).Text({ children: 'row' })
  })
  let result: any = null
  on('ui.render', { component: 'ToolResult' }, async ($: any, e: any) => {
    result = e.props.output
    return $.ui.resolve(e).Text({ children: 'result' })
  })
  const output = { questions: QUESTIONS, answers: { 'Which one do you want?': 'Alpha' }, annotations: { 'Which one do you want?': { notes: 'n' } } }
  const row = () =>
    $.ui.render({ component: 'ToolUse', surface: 'terminal', props: { tool_use_id: 'toolu_q', tool: 'AskUserQuestion', input: { questions: QUESTIONS }, output, isRunning: false, isErrored: false, isInterrupted: false } } as any)
  await row()
  await clock.advance(100)
  await row()
  const q = 'Which one do you want?\n译:Which one do you want?'
  expect(seen.input.questions[0].question).toBe(q)
  expect(seen.output.questions[0].question).toBe(q)
  expect(seen.output.answers).toEqual({ [q]: 'Alpha' })
  expect(seen.output.annotations).toEqual({ [q]: { notes: 'n' } })
  await $.ui.render({ component: 'ToolResult', surface: 'terminal', props: { tool_use_id: 'toolu_q', tool: 'AskUserQuestion', output, isErrored: false } } as any)
  expect(result.questions[0].question).toBe(q)
  expect(result.answers).toEqual({ [q]: 'Alpha' })
})

test('text typed as an answer reaches Claude in English; a picked option is sent as it is; the row shows what was typed', { options: { api_key: 'k' } }, async ($, on) => {
  mock.clock(on)
  translator(on)
  // The engine's dialog, stood in for beneath the plugin: the user typed the first answer and picked the second
  on('tool.call', { tool: 'AskUserQuestion' }, async ($: any, e: any) => ({
    result: { questions: e.questions, answers: { 'Which one do you want?': '我想要第三个', 'Confirm?': 'Yes' } },
  }))
  let seen: any = null
  on('ui.render', { component: 'ToolResult' }, async ($: any, e: any) => {
    seen = e.props.output
    return $.ui.resolve(e).Text({ children: 'result' })
  })
  const questions = [...QUESTIONS, { question: 'Confirm?', header: 'Go', multiSelect: false, options: [{ label: 'Yes', description: 'Go ahead' }, { label: 'No', description: 'Stop' }] }]
  const r: any = await $.tool.call({ tool: 'AskUserQuestion', questions } as any)
  expect(r.result.answers).toEqual({ 'Which one do you want?': 'EN: 我想要第三个', 'Confirm?': 'Yes' })
  await $.ui.render({ component: 'ToolResult', surface: 'terminal', props: { tool_use_id: 'toolu_a', tool: 'AskUserQuestion', output: r.result, isErrored: false } } as any)
  expect(Object.values(seen.answers)).toEqual(['我想要第三个 (EN: 我想要第三个)', 'Yes'])
})
