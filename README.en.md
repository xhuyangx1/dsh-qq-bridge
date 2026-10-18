# dsh-qq-bridge

[中文](README.md) | **English**

Drive [DeepSeek Harness](https://github.com/deepseek-ai) remotely from **QQ private chat**.

Send one message from your phone and the machine at home actually starts working.
Sessions are created **inside the running DSH process**, so you can watch it work
in the DSH web UI — and take over the very same conversation from your desk.

<p align="center">
  <img src="docs/qq-chat.png" alt="Sending a task from QQ" width="300" />
  &nbsp;&nbsp;&nbsp;
  <img src="docs/settings-page.png" alt="Control panel inside DSH settings" width="640" />
</p>

<p align="center">
  <sub>Left: send a message on QQ &nbsp;|&nbsp; Right: control panel in DSH settings</sub>
</p>

```
QQ message (private chat by default)
   ↓  NapCat (the QQ client already logged in on your machine)
   ↓  OneBot 11 WebSocket
dsh-qq-bridge (a DSH plugin)
   ↓  ctx.agents.create() — creates the session inside the DSH process
result + artifacts → split → sent back to QQ
```

## Why this design

Most bots shell out to `dsh headless` for every task. That works, but costs
**13–17 seconds of cold start** per message and the resulting session is invisible
to the DSH web UI.

This plugin instead calls `ctx.agents.create()` on the **live DSH process**.
The session it produces is an ordinary DSH session: it shows up in the sidebar,
streams into the web UI in real time, and you can keep typing in it from the desktop.

| | `internal` (default) | `acp` | `headless` |
| --- | --- | --- | --- |
| Shape | **in-process session** | long-lived subprocess | spawn per task |
| Cold start | **none** | 5–10 s | 13–17 s |
| **Visible in DSH web UI** | ✅ **watch & take over** | ❌ | ❌ |
| Use when | always | `internal` unavailable | last resort |

Fallback chain: `internal` → `acp` → `headless`. Each step degrades gracefully.

## Features

- **Instant ack** — replies “收到，正在处理…” (on it) within ~0.2 s, so you know the
  message landed. Long tasks then report progress every 3 s.
- **Two-way media** — images and files you send are downloaded into `inbox/` and
  handed to the model; artifacts it produces are sent back to QQ automatically.
- **Private-chat only** — with `privateOnly: true` the bot is completely silent in
  group chats.
- **Control panel in DSH settings** — start/stop NapCat, watch status and logs
  without touching a terminal.
- **No cold start** — no subprocess per message.

## Install

```bash
dsh plugin add https://github.com/xhuyangx1/dsh-qq-bridge
```

Then:

1. **Install and log in to NapCat** so that QQ exposes an OneBot 11 endpoint
   → [NapCat docs](https://napcat.napneko.icu/)
2. **Configure the allowlist** — edit the profile-level `cordis.patch.yml`,
   fill in at least `allowedUsers` (your QQ number), then flip `disabled` to `false`
3. Restart DSH

```yaml
- id: qq-bridge
  name: 'dsh-qq-bridge'
  disabled: false
  config:
    privateOnly: true
    allowedUsers:
      - YOUR_QQ_NUMBER
    napcat:
      dir: 'C:\\path\\to\\NapCat'
```

## ⚠️ Security

> **This plugin hands execution control of your machine to QQ.**
>
> - Always set `allowedUsers`. Otherwise anyone who can DM the bot can drive your box.
> - `privateOnly` defaults to `true`; enabling group chat is an explicit choice.
> - The bot runs with whatever permissions DSH has. Make sure you know what the
>   model is allowed to do.
> - **Never** add this bot to a public group.

## Private-chat-only mode (default)

```yaml
privateOnly: true
```

Nothing sent in a group chat is processed.

> ⚠️ **Do not implement “private only” by emptying `allowedGroups`.**
> An empty array means “don't restrict any group”, so clearing it opens the bot to
> **every** group. Use `privateOnly: true` instead.

Measured: zero replies in groups, ~0.2 s acknowledgement in DMs.

## Instant acknowledgement

The model may take anywhere from a few seconds to a minute, so the plugin replies
**the moment the message arrives**:

```
收到，正在处理…（run the tests）
```

(That is Chinese for “on it, working on it now”.)

Measured: **0.8 s from send to ack**. Long tasks then report progress after 3 s:

```
⏳ 进行中 24s · 第 3 步
▸ 终端 pnpm test --filter core ✓
▸ 读文件 /src/index.ts ✓
▸ 搜内容 ×4 route ✓
```

Progress is **reported only on tool switches** — calling the same tool four times in a
row collapses into one `▸ 搜内容 ×4` line instead of four.

> Why this matters: previously progress only started at 8 s with no ack at all, so the
> first several seconds were dead silence and you could not tell whether your message
> had been received at all.

Turn it off with `ackOnReceive: false`.

## Media, both directions

**Inbound** — send an image or a file in QQ and the plugin:

1. downloads it into `inbox/` under the working directory
2. appends the path to the task text
3. lets the model read it with its own `read` / `read_image` tools

QQ file messages are a special case: they carry **no `url`**, only a `file_id`:

```json
{ "file": "report.xlsx", "file_id": "9eac...", "file_size": "1298300" }
```

so the plugin calls OneBot's `get_file` to resolve it. NapCat answers with a **local
absolute path**, not an HTTP URL — the download path handles both.

**Outbound** — when the answer contains a file reference **on its own line**, the file
is uploaded to QQ:

```
**[report.xlsx](inbox/report.xlsx)**     ← markdown link
附件: /path/to/chart.png                  ← explicit marker
- [reel.mp4](reels/out/reel.mp4)         ← list item link
```

A path merely *mentioned inline* is **not** sent. This is deliberate: an earlier version
matched any path anywhere in the text, so discussing a file caused it to be sent twice,
and files mentioned in passing went out too.

## Commands

Send a message in a DM — no prefix required.

| Command | Effect |
| --- | --- |
| `/dsh <task>` | run a task on the machine, reply with the result |
| `/dsh stop` | interrupt the running task |
| `/dsh ping` | liveness + queue status |
| `/dsh new [name]` | start a fresh session (clears context) |
| `/dsh list` | list past sessions |
| `/dsh switch <n>` | switch to session n |
| `/dsh current` | show the current session and working directory |
| `/dsh dir` | show working directory |
| `/dsh dir <path>` | change working directory |
| `/dsh dir -` | back to the previous directory |
| `/dsh help` | show help |

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `privateOnly` | `false` | ignore group messages entirely |
| `allowedUsers` | `[]` | QQ numbers allowed to drive the bot; **empty = anyone** |
| `allowedGroups` | `[]` | group numbers; **empty = no restriction** |
| `backend` | `internal` | `internal` \| `acp` \| `headless` |
| `ackOnReceive` | `true` | reply “on it” immediately |
| `sendAttachments` | `true` | send back files that appear as standalone links |
| `resetOnIdleMins` | `180` | start a new session after this much idle time |
| `timeoutSeconds` | `600` | per-task timeout |
| `maxOutputChars` | `3000` | split replies longer than this |
| `maxConcurrent` | `2` | concurrent tasks |
| `progress.startAfterMs` | `3000` | start reporting progress after N ms |
| `napcat.dir` | — | NapCat install dir, used by the start button |

## Why NapCat instead of the official QQ bot platform

The official QQ bot platform identifies groups by `group_openid`, **not** by group
number, and sending proactive messages from the sandbox needs a separate approval.
For ordinary groups you have to run a local protocol bridge (NapCat / Lagrange), which
reuses the QQ client already logged in on your machine — no public IP, no ICP filing,
no review.

> Trade-off: a local protocol bridge is unofficial, so there is a theoretical
> risk-control risk. The plugin never touches QQ credentials; it only speaks
> OneBot, so switching bridges (e.g. to Lagrange) is just a `onebot.endpoint` change.

## Full installation

### 1. Install NapCat on the computer

Install NapCatQQ, log in with the bot's QQ account, then enable
**WebSocket server** in its network settings:

| Field | Value |
| --- | --- |
| Host | `127.0.0.1` |
| Port | `3001` |
| Token | optional; if set, put the same value in the plugin config |

(The plugin acts as the **client** and connects to NapCat, so “WebSocket server” mode
is the convenient choice.)

### 2. Install the plugin

Pass a **path**, and make sure `name` points at `lib/index.js` rather than the
directory — DSH loads plugins as native ESM, and a directory import fails with
`ERR_UNSUPPORTED_DIR_IMPORT`.

```bash
dsh plugin --profile web add /path/to/dsh-qq-bridge
```

### 3. Mount it in the profile patch

```yaml
- insert:
    - id: qq-bridge
      name: 'dsh-qq-bridge'
      disabled: false
      config:
        privateOnly: true
        allowedUsers:
          - YOUR_QQ_NUMBER
        napcat:
          dir: 'C:\\path\\to\\NapCat'
```

### 4. Restart DSH

The control panel shows up under **Settings → QQ 桥**.

## Five things that will bite you

These are not guesses — each one cost real debugging time. Read them before
touching the DSH internal API.

```js
// 1. The parameter is sessionId, not id.
//    Wrong: "agent id \"undefined\" does not match session id"
agents.create({ sessionId, meta: { cwd }, agentOptions })

// 2. agentOptions is mandatory. Without it the prompt's {{model}} variable is
//    empty and the turn dies with:
//    'prompt variable "{{model}}" has no value for this assembly'
const selection = defaultModel.currentSelection()
const agentOptions = { provider: selection.provider, model: selection.model }

// 3. Resolve services lazily. In apply() the loader has not published
//    agents/sessions yet, so ctx.get() returns undefined.

// 4. Mount an agent preset, or the session is an empty shell with NO tools.
//    Symptom: the model says it has no read / read_image tool available.
const resolved = await ctx.get('agentPresets').resolve()
setup = async (agentCtx) => { await ctx.get('agentPresets').mount(agentCtx, resolved.id) }
agents.create({ sessionId, meta: { cwd, agentPreset: resolved.id }, agentOptions, setup })

// 5. Use createUserMessage. Hand-rolling { role: 'user', ... } writes events
//    without an id, and the session then fails validation on reload:
//    "session event at seq N lacks an identified message (gateway/internal)"
//    Result: the entire conversation history becomes unopenable.
import { createUserMessage } from '@deepseek-ai/dsh-llm'
agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId: randomUUID() } }))
```

## Development

```bash
npm test       # 29 unit tests
npm run check  # syntax check every entry point
```

## License

[MIT](LICENSE)
