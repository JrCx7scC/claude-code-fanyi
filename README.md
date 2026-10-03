# Fanyi

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that lets you write to Claude Code in your own language while Claude works in English.

- **Your prompts:** a prompt in your language is translated to English before Claude reads it. Your message row shows what you typed, with the English that was sent dimmed underneath. A prompt that's already in English is sent as typed.
- **Claude's replies:** each text block of a reply gets a translation into your language in a dim box underneath. It streams in as it's generated and renders as Markdown. A block that's already in your language gets no box.
- **Questions and tool rows:** when Claude asks you a question (the AskUserQuestion dialog), the question and each option's description are drawn with their translation on the line under them, and the header chip is translated. An option's label is the answer Claude receives, so it stays English; its translation starts the line under the description. The title of a tool row (the description of a Bash command or a subagent) gets its translation under it too.
- **The conversation stays English.** Translations of replies are display-only, so the history Claude reads isn't changed. The one thing that does change is your prompt: Claude receives the English version.

## Requirements

- Claude Code v2.1.287 or later (`claude --version`)
- Node.js 18 or later, for the bundled translation server
- For the **API** engine: an API key for an OpenAI-compatible Chat Completions endpoint. The defaults use DeepSeek V4.1 Flash through an [OpenCode Go](https://opencode.ai/docs/go/) subscription.
- For the **Apple on-device** engine and on-device language detection: macOS 15 or later with the Xcode command line tools (`xcode-select --install`). The helper is compiled on your Mac the first time it's needed.

## Install

```bash
claude plugin marketplace add JrCx7scC/claude-code-fanyi
claude plugin install fanyi@claude-code-fanyi
```

Restart Claude Code, then run `/fanyi settings` to enter your API host and key and pick a model. Or pass the key at install time with `--config api_key=<your-key>`.

The mod calls its own translator server's tools. If Claude Code asks you to approve a `plugin:fanyi:translator` tool, allow it, or add `"mcp__plugin_fanyi_translator"` to `permissions.allow` in `~/.claude/settings.json`. Claude itself can't call these tools: the mod refuses them.

## Settings

A line above the prompt shows `Fanyi ● On · ⚙`. Click `On` / `Off` to switch translation, or `⚙` to open the settings pane. Without a mouse, press `Ctrl+X` then `Tab` to focus the line, and Enter to press. `/fanyi` toggles, `/fanyi on` and `/fanyi off` set it, and `/fanyi settings` opens the pane.

The pane applies each choice as soon as it's picked, and keeps it across sessions:

| Setting | Choices |
| :- | :- |
| Translation | On or off. While it's off, prompts are sent as typed and replies aren't translated. |
| Engine | **API**: your configured model, streamed. **Apple on-device**: Apple's Translation framework, so nothing leaves your Mac and a reply takes under a second, but technical terms come out worse. It needs the language packs in System Settings → General → Language & Region → Translation Languages. |
| Your language | The language prompts are translated from and replies into. Changing it starts translations over in the new language. |
| Language detection | **On this Mac**: NaturalLanguage tells which language a text is in, with no API call. **Ask the model**: the API model decides, at the cost of a short call. |
| API host | Base URL of any OpenAI-compatible Chat Completions API, without `/chat/completions`. Default `https://opencode.ai/zen/go/v1`. |
| API key | Paste it and press Enter. The pane shows only its last four characters. It's kept in the macOS Keychain, or in a file only you can read on other systems. Submit an empty key to remove it. |
| Model | Picked from the list the API returns from `/models`, with `↻ Refresh` to fetch it again. For an API that lists no models, type the id instead. |

The plugin's options, set with `/plugin configure fanyi@claude-code-fanyi`, are the starting values:

| Option | Default | What it does |
| :- | :- | :- |
| `api_key` | (none) | API key, used when none was entered in the pane. Stored in your system's secure credential store. |
| `base_url` | `https://opencode.ai/zen/go/v1` | API host until you change it in the pane |
| `model` | `deepseek-v4.1-flash` | Model until you pick another in the pane |
| `disable_thinking` | `true` | Sends `thinking: { type: "disabled" }`. On DeepSeek this cuts time to first token from 6–15 s to about 1.5 s. A model that only runs with reasoning on is detected on its first refusal and sent requests without the field. |

Every API request carries a `claude-code-fanyi/<version>` User-Agent and an `x-opencode-session` header set to the Claude Code session id. OpenCode Go requires both, and other providers ignore them.

### Deciding whether a text needs translating

Checked in this order, and the first that can tell decides:

1. **The script**, for a language not written in Latin script (Chinese, Japanese, Korean, Russian, Arabic, …). A prompt is translated when it contains your script; a reply is translated when less than half of its letters are in your script. Instant.
2. **On-device detection**, when it's selected and you're on a Mac. Text too short to tell, such as `ok` or a file path, is left as it is. A few milliseconds.
3. **The model**, otherwise. It answers with a marker instead of a translation when the text is already in the target language.

With your language set to English, nothing is translated.

## How it works

```
.claude-plugin/plugin.json   manifest: userConfig and the translator MCP server
hooks/register.js            the mod: Claude Code event hooks, the toggle and the settings pane
mcp/translator.mjs           dependency-free stdio MCP server: detection and both engines
mcp/markdown.mjs             keeps code and Markdown structure away from machine translation
apple/FanyiApple.swift       on-device helper: NaturalLanguage detection, Translation framework
```

- `prompt.submit` sends each prompt to the translator, which translates it to English or says it needs no translation.
- `session.append` starts a translation for each reply text block once it's stored. It runs in the background, so Claude's next step isn't held up.
- `ui.render` on `AssistantMessage` keeps Claude Code's own drawing of the reply and adds the translation box under it, redrawn as the translation streams in.
- `ui.render` on `UserMessage` shows your original prompt, with the English under it.
- `ui.render` on `AskUserQuestion` and `ToolUse` rewrites the dialog's questions and a tool row's description with their translations. The short strings of one draw are translated in one request; a saved translation is drawn from the store.
- `ui.render` on `AbovePrompt` draws the toggle, and on a `Pane` the settings.
- `tool.call` refuses the translator tools when Claude calls them. They're for the mod only.

The mod makes no network requests itself. All API traffic goes through the plugin's MCP server, so the mod works with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set.

With the Apple engine, Markdown is split before translation: code blocks, inline code, link targets, URLs, list markers, headings, quotes and table pipes are kept as they are, and only the prose is translated.

## Limitations

- Translation adds about 1.5–5 s (API) or under a second (Apple) before a prompt in your language is sent.
- The Apple engine doesn't stream; a reply's translation appears whole.
- The Apple engine needs your language as a tag from the list, and the matching language pack downloaded.
- Right after a start or `/resume`, replies wait (up to 60 s, quietly) for the translation server to connect before they're translated.
- Prompts are always translated to English, the language Claude works in.
- Prompts that start with `/` or `!` are never translated.
- Subagents' replies aren't translated.
- The dim `summary` line Claude Code draws before a tool call is a thinking block, which plugins can't redraw, so it stays English. A question's option labels stay English too (see above).
- A question dialog and a tool row show the English until their translation arrives, about a second later.
- Finished translations are saved in the plugin's own store, per engine and language, so after a restart or `/resume` a reply that was translated before is drawn from it. About 3 MB of the newest translations are kept.
- A failed translation is retried twice (after 2 s and 6 s); at most 3 translations run at once.

## Development

```bash
claude --plugin-dir ./           # load this checkout for one session; reloads on save
claude plugin validate .claude-plugin/plugin.json        # manifest, plus the hooks the mod registers
claude plugin validate .claude-plugin/marketplace.json   # the marketplace entry
claude plugin test ./            # run tests/*.test.ts
```

## License

[MIT](LICENSE)

