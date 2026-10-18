/**
 * dsh-qq-bridge — 用 QQ 群聊机器人驱动 DeepSeek Harness。
 *
 * 链路：
 *   QQ 群消息 → NapCat/OneBot 11 反向 WS → 本插件 → `dsh headless` → 回群
 *
 * 设计取舍：
 * - 复用 headless 子进程而不是 DSH 内部 API：跨平台、跨版本，模型/密钥沿用
 *   启动 headless 时的环境与 profile 配置，插件本身不碰凭据。
 * - 任务从 stdin 喂给子进程：Windows 上不必和引号、编码搏斗；
 *   答案从 stdout 的 NDJSON 里取 `final` 事件。
 * - 每个群一个 session id：群里上下文连续，`/stop` 能精确打断对应进程。
 */
import { execFileSync as defaultExecFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { ProgressReporter } from './progress.js'
import { AcpClient } from './acp.js'
import { InternalRunner } from './internal.js'
import { NapCatController, napcatRunning, portListening } from './napcat.js'

export const name = 'dsh-qq-bridge'

export const inject = []

/**
 * 配置默认值。
 *
 * DSH 不会把 bundle 层的 config 和 profile 层的 config 做深合并后整体传进来，
 * 用户只写几个字段时，其余字段到这里就是 undefined。所以每个被读到的字段
 * 都必须有兜底——否则 `active < undefined` 恒为 false，队列永远不消费，
 * 群里发什么都没人跑。
 */
const DEFAULTS = {
  allowedGroups: [],
  allowedUsers: [],
  perGroupSession: true,
  commandPrefixes: ['/dsh', '/DSH'],
  requireMention: true,
  helpOnEmpty: true,
  cwd: '',
  timeoutSeconds: 600,
  maxOutputChars: 3000,
  maxConcurrent: 2,
  allowStopAnyGroup: false,
  // 空闲多久自动开新会话（分钟）。0 = 禁用。
  // 借鉴 cc-connect 的 reset_on_idle_mins：防止旧上下文（失败的调试日志）长期占据模型注意力。
  resetOnIdleMins: 180,
  // 是否把回答里标记的文件（"附件: /path"）自动发回聊天
  sendAttachments: true,
  // 收到任务后立刻回一句「收到，正在处理…」，让用户确认没丢消息
  ackOnReceive: true,
  // 只响应私聊，完全忽略群消息。
  // ⚠️ 不要用「allowedGroups 清空」来实现：空数组的语义是「不限制任何群」，
  //    那样反而放开了全部群聊。必须靠这个开关显式拦。
  privateOnly: false,
  // 执行后端：
  //   'internal' = 在当前 DSH 进程内建会话（最佳：无冷启动，且 Web 里能看到/接管）
  //   'acp'      = 常驻子进程（次选：快，但会话不在 Web 列表里）
  //   'headless' = 每次 spawn（兜底：最慢）
  // internal 需要 agents/sessions/agentDefaultModel 三个服务；缺失时自动回退 ACP。
  backend: 'internal',
  // ACP 模式下切换模型，值形如 ['aggregate','auto']；留空则用 profile 默认
  acpModel: undefined,
  // 每条任务前自动加的说明。让模型知道"用户看不到弹窗"，
  // 否则它会调 ask_user_question 然后一直等到超时。
  promptPreamble: [
    '【交互环境说明】',
    '你正在通过 QQ 与用户对话。用户看不到任何弹窗、对话框或 UI 确认框。',
    '- 不要使用 ask_user_question、命令审批或任何需要交互确认的工具；',
    '  这些调用在这里没有通道，会一直等不到答案。',
    '- 信息不足时，优先选最合理的方案直接执行，并在回答开头用一句话说明你的假设。',
    '- 确实必须让用户决策时，用普通文字列出选项（1./2./3.），让用户回复序号。',
    '- 生成的产物（文件、图片、报告）请在回答里写成 markdown 链接 [名字](路径)，',
    '  这样会自动发到用户的 QQ 上。',
  ].join('\n'),
  onebot: {
    endpoint: 'ws://127.0.0.1:3001',
    accessToken: '',
    reconnectDelayMs: 3000,
    maxReconnectDelayMs: 30000,
  },
  progress: {
    enabled: true,
    // 3 秒就出第一条进度：模型通常要 10-60 秒，
    // 阈值太高会让用户在这段空白里怀疑消息是不是没发出去。
    startAfterMs: 3000,
    minIntervalMs: 5000,
    maxMessages: 12,
  },
  command: {
    bin: 'dsh',
    dir: '',
    // 用哪个 profile 跑任务。undefined = 回退 headless；'' = 显式不传（测试用）
    profile: undefined,
    profileArgs: ['--json'],
    extraArgs: [],
    shell: false,
    // undefined = 启动时自动探测；也可写成 'json' / 'plain' 强制指定
    mode: undefined,
  },
}

/**
 * Windows 上 `dsh` 是 dsh.cmd 垫片，Node 的 spawn 不会像 shell 那样补扩展名，
 * 直接 spawn('dsh') 会 ENOENT。这里按 PATHEXT 把可执行文件找全，找不到就原样返回，
 * 让 spawn 自己报错（错误信息仍是准确的）。
 */
export function resolveBin (bin, env = process.env) {
  if (!bin) return bin
  if (process.platform !== 'win32') return bin
  // 已经带扩展名或带路径分隔符的，交给 spawn 处理
  if (/[\\/]/.test(bin) || /\.[A-Za-z0-9]+$/.test(bin)) return bin
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const dirs = (env.PATH ?? '').split(';').filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext.toLowerCase())
      try { if (statSync(candidate).isFile()) return candidate } catch {}
      const upper = join(dir, bin + ext.toUpperCase())
      try { if (statSync(upper).isFile()) return upper } catch {}
    }
  }
  return bin
}

/**
 * Windows 上 .cmd/.bat 不能用 spawn 直接跑：
 * Node 18.20+/20.12+ 为了修 CVE-2024-27980，对批处理文件不加 shell 就抛 EINVAL。
 * 所以解析到批处理时必须走 shell。参数里只有固定的开关和 UUID，没有引号风险。
 */
export function needsShell (bin) {
  if (process.platform !== 'win32') return false
  return /\.(cmd|bat)$/i.test(bin ?? '')
}

/**
 * 探测目标 dsh 的 headless 支持哪种调用形态。
 *
 * dsh 0.1.7 起 headless 才有 `--json` / `--session-id` / `-` 读 stdin；
 * 0.1.5 及更早只接受「任务作为位置参数」，没有事件流，只能拿 stdout 全文当答案。
 * 硬编码新版参数在旧版上会直接 "unknown option '--json'" 退出，所以先问一下 --help。
 *
 * 返回 'json' | 'plain'。
 */
export function detectHeadlessMode (bin, { env = process.env, execFileSync } = {}) {
  const run = execFileSync ?? defaultExecFileSync
  const resolved = resolveBin(bin, env)
  try {
    const help = run(resolved, ['headless', '--help'], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: needsShell(resolved),
    })
    return /--json\b/.test(help) ? 'json' : 'plain'
  } catch (error) {
    // --help 失败就按截图判断，退到最保守的形态
    return 'plain'
  }
}

/** 两层深合并：用户写了就覆盖，没写就用默认值。 */
export function withDefaults (config = {}) {
  const merged = { ...DEFAULTS, ...config }
  for (const key of ['onebot', 'progress', 'command']) {
    merged[key] = { ...DEFAULTS[key], ...(config[key] ?? {}) }
  }
  return merged
}

const HELP_TEXT = [
  'DSH · QQ 桥在线',
  '',
  '【执行】',
  '直接说话即可，在电脑上执行并把结果发回来',
  '/dsh stop       打断正在跑的任务',
  '/dsh ping       探活',
  '',
  '【会话】',
  '/dsh new [名]   开新会话（清空上下文）',
  '/dsh list       列出历史会话',
  '/dsh switch <n> 切到第 n 个会话',
  '/dsh current    显示当前会话',
  '',
  '【目录】',
  '/dsh dir        显示当前工作目录',
  '/dsh dir <路径> 切换工作目录',
  '/dsh dir -      回到上一个目录',
  '',
  '【其它】',
  '/dsh help       显示本帮助',
  '',
  '发图片或文件时，会自动下载后交给模型读取。',
].join(String.fromCharCode(10))

/**
 * 从消息段里挑出「需要下载的媒体」：图片和文件。
 *
 * OneBot 11 的段形如：
 *   { type: 'image', data: { file, url, sub_type } }
 *   { type: 'file',  data: { file, url, file_id, name } }
 * NapCat 一般会给 url（http 直链），没有再退回用 file 标识走 get_image/get_file。
 *
 * 只认这两类：语音/视频/表情一律忽略（转成文字描述，不下载）。
 */
export function extractMedia (message) {
  if (!Array.isArray(message)) return []
  const out = []
  for (const seg of message) {
    if (seg === null || typeof seg !== 'object') continue
    const d = seg.data ?? {}
    if (seg.type === 'image') {
      const url = typeof d.url === 'string' && d.url !== '' ? d.url : ''
      const file = typeof d.file === 'string' ? d.file : ''
      if (url || file) out.push({ kind: 'image', url, file, name: d.file ?? 'image' })
    } else if (seg.type === 'file') {
      // 实测 QQ 文件消息**没有 url**，只有：
      //   { file: 'example.xlsx', file_id: '9eac...', file_size: '1298300' }
      // 所以要拿 file_id 去调 OneBot 的 get_file 换真实下载地址（见 downloadMedia）。
      const url = typeof d.url === 'string' && d.url !== '' ? d.url : ''
      const fileId = typeof d.file_id === 'string' ? d.file_id : ''
      const name = typeof d.name === 'string' && d.name !== '' ? d.name : (d.file ?? 'file')
      if (url || fileId) out.push({ kind: 'file', url, fileId, name })
    }
  }
  return out
}

/** OneBot 11 的 message 可以是数组段，也可以是 CQ 码字符串。统一成纯文本。 */
export function segmentsToText (message) {
  if (typeof message === 'string') return stripMention(cqToText(message))
  if (!Array.isArray(message)) return ''
  const parts = []
  for (const seg of message) {
    if (seg === null || typeof seg !== 'object') continue
    if (seg.type === 'text' && typeof seg.data?.text === 'string') parts.push(seg.data.text)
    else if (seg.type === 'at' && typeof seg.data?.qq === 'string') parts.push(`@${seg.data.qq} `)
    // 图片/文件不在这里拼占位符：它们走 handleMedia 单独下载并拼路径，
    // 这里再插 [图片] 会把用户原本的文字污染成 "看这个[图片]"。
  }
  return stripMention(parts.join(''))
}

/** 去掉开头的 @机器人 片段（NapCat 的数组段已由上面处理，这里处理 CQ 码字符串）。 */
export function stripMention (text) {
  return text.replace(/^\s*(@\S+\s*)+/, '').trim()
}

/** CQ 码里只保留文字段，其余（图片、表情、@）丢弃，避免把不可见内容喂给模型。 */
export function cqToText (raw) {
  return raw
    // 所有 CQ 码一次性替换成一个空格：分两步替换会叠出双空格，把 "/dsh" 挤离行首
    .replace(/\[CQ:[^\]]*\]/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
}

/** 前缀剥离：命中任一前缀则返回剩余任务文本，否则 null。 */
export function takePrefix (text, prefixes) {
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) return text.slice(prefix.length).trim()
  }
  return null
}

/** QQ 单条消息有上限，按行切块，保留代码块完整性尽量。 */
export function splitMessage (text, limit) {
  if (text.length <= limit) return [text]
  const chunks = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/**
 * 最小 OneBot 11 反向 WS 客户端。
 *
 * NapCat 配「WebSocket 客户端」指向 ws://本机:端口/ 时，是由它去连网关；
 * 这里做的是「网关自己去连 NapCat 的 WS 服务端」模式（NapCat 侧开
 * 「WebSocket 服务器」）。两者都支持，见 README。
 */
class OneBotClient {
  #url
  #token
  #reconnectDelay
  #maxDelay
  #socket = null
  #closed = false
  #attempt = 0
  #heartbeat = null
  #pending = new Map()

  constructor ({ url, token, reconnectDelayMs, maxReconnectDelayMs, onEvent, log }) {
    this.#url = url
    this.#token = token
    this.#reconnectDelay = reconnectDelayMs
    this.#maxDelay = maxReconnectDelayMs
    this.onEvent = onEvent
    this.log = log
  }

  start () {
    this.#closed = false
    this.#connect()
  }

  stop () {
    this.#closed = true
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    this.#heartbeat = null
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer)
      reject(new Error('onebot: client stopped'))
    }
    this.#pending.clear()
    try { this.#socket?.close() } catch {}
    this.#socket = null
  }

  get connected () {
    return this.#socket !== null && this.#socket.readyState === 1
  }

  #connect () {
    if (this.#closed) return
    let socket
    try {
      // 带 access_token 的 OneBot 服务端要求请求头里带 Authorization
      socket = this.#token
        ? new WebSocket(this.#url, { headers: { Authorization: `Bearer ${this.#token}` } })
        : new WebSocket(this.#url)
    } catch (error) {
      this.log(`onebot: 构造 WebSocket 失败：${error}`)
      this.#scheduleReconnect()
      return
    }
    this.#socket = socket

    socket.addEventListener('open', () => {
      this.#attempt = 0
      this.log(`onebot: 已连接 ${this.#url}`)
      // OneBot 要求定期上报心跳，否则服务端可能按超时断开
      this.#heartbeat = setInterval(() => {
        try { socket.send(JSON.stringify({ action: 'get_status', params: {}, echo: `hb-${Date.now()}` })) } catch {}
      }, 30_000)
    })

    socket.addEventListener('message', (message) => {
      let payload
      try {
        payload = JSON.parse(typeof message.data === 'string' ? message.data : Buffer.from(message.data).toString('utf8'))
      } catch {
        return
      }
      this.#dispatch(payload)
    })

    socket.addEventListener('error', () => {
      // 具体原因由 close 事件统一处理，这里只避免未捕获异常
    })

    socket.addEventListener('close', () => {
      if (this.#heartbeat) clearInterval(this.#heartbeat)
      this.#heartbeat = null
      this.#socket = null
      if (!this.#closed) this.#scheduleReconnect()
    })
  }

  #scheduleReconnect () {
    if (this.#closed) return
    const delay = Math.min(this.#reconnectDelay * 2 ** this.#attempt, this.#maxDelay)
    this.#attempt += 1
    this.log(`onebot: ${Math.round(delay / 1000)}s 后重连（第 ${this.#attempt} 次）`)
    setTimeout(() => this.#connect(), delay)
  }

  #dispatch (payload) {
    // action 的应答
    if (payload && typeof payload.echo === 'string' && this.#pending.has(payload.echo)) {
      const entry = this.#pending.get(payload.echo)
      this.#pending.delete(payload.echo)
      clearTimeout(entry.timer)
      if (payload.retcode === 0 || payload.retcode === undefined) entry.resolve(payload.data)
      else entry.reject(new Error(`onebot: ${payload.retcode} ${payload.message ?? payload.wording ?? ''}`))
      return
    }
    // 心跳上报，噪声，丢弃
    if (payload?.post_type === 'meta_event') return
    try {
      this.onEvent(payload)
    } catch (error) {
      this.log(`onebot: 事件处理异常 ${error?.stack ?? error}`)
    }
  }

  /** 发一个 action 并等应答；超时就 reject，不让群消息卡死。 */
  call (action, params = {}, timeoutMs = 10_000) {
    if (!this.connected) return Promise.reject(new Error('onebot: 未连接'))
    const echo = `dsh-${randomUUID()}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo)
        reject(new Error(`onebot: ${action} 超时`))
      }, timeoutMs)
      this.#pending.set(echo, { resolve, reject, timer })
      try {
        this.#socket.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        this.#pending.delete(echo)
        clearTimeout(timer)
        reject(error)
      }
    })
  }
}

/** 取第一行并压到 len 字符，用于思考摘要这种“一行概览”场景。 */
export function firstLine (text, len = 60) {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '') ?? ''
  return line.length > len ? `${line.slice(0, len)}…` : line
}

/** 把工具入参压成一行人话，群里看得懂就行，不泄露整段文件内容。 */
export function summarizeToolInput (tool, input) {
  if (input === null || typeof input !== 'object') return ''
  const pick = (...keys) => {
    for (const key of keys) {
      const value = input[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return ''
  }
  const candidate = pick('command', 'description', 'query', 'q', 'url', 'path', 'file_path', 'filename', 'pattern', 'prompt', 'text', 'task')
  return candidate.length > 80 ? `${candidate.slice(0, 80)}…` : candidate
}

/** 工具结果只取首行摘要；报错时保留更多信息。 */
export function summarizeToolResult (result) {
  const text = String(result ?? '').trim()
  if (text === '') return ''
  return firstLine(text, 70)
}


/**
 * 把一张图片 / 一个文件落到本地，返回绝对路径。
 *
 * 为什么要落地：`dsh headless` 只接受文本参数，没有任何 --image/--file 入口。
 * 所以只能把文件存到工作区，再把路径写进任务文本，让模型用 read_image / read 自己去读。
 * （实测 headless 里的模型能正确读图并描述内容。）
 *
 * 命名：<inbox>/<时间戳>-<短id><ext>，避免同名覆盖，也避免用户文件名里的怪字符。
 */
export async function downloadMedia (media, inboxDir, opts = {}) {
  const { fetchImpl = globalThis.fetch, resolveFileUrl } = opts
  mkdirSync(inboxDir, { recursive: true })
  const stamp = Date.now().toString(36)
  const rand = randomUUID().slice(0, 8)
  let ext = extname(media.name ?? '')
  if (!ext) ext = media.kind === 'image' ? '.jpg' : '.bin'
  const target = join(inboxDir, `${stamp}-${rand}${ext}`)

  let buf = null

  // 1) 已有 http 直链（图片常见）
  if (media.url) {
    const res = await fetchImpl(media.url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
    buf = Buffer.from(await res.arrayBuffer())
  }

  // 2) 只有 file_id（QQ 文件消息就是这样，没有 url）—— 先用 get_file 换地址
  if (buf === null && media.fileId && typeof resolveFileUrl === 'function') {
    let info
    try {
      info = await resolveFileUrl(media.fileId)
    } catch (error) {
      throw new Error(`get_file 失败：${error?.message ?? error}`)
    }
    const furl = info?.url ?? info?.file ?? info?.downUrl ?? ''
    if (typeof furl === 'string' && furl !== '') {
      if (furl.startsWith('http')) {
        const res = await fetchImpl(furl, { redirect: 'follow' })
        if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
        buf = Buffer.from(await res.arrayBuffer())
      } else {
        // 实测 NapCat 的 get_file 返回的是**本地绝对路径**（不是 http）：
        //   { file: '<NapCat临时目录>/example.xlsx',
        //     url:  同一个路径, file_size: '1298300' }
        // 直接读进内存再写一份到 inbox —— 不软链，因为 NapCat 的 temp 会被清理。
        const { readFileSync } = await import('node:fs')
        buf = readFileSync(furl)
      }
    }
  }

  // 3) base64（测试用）
  if (buf === null && media.base64) {
    buf = Buffer.from(media.base64, 'base64')
  }

  if (buf === null) {
    throw new Error(media.fileId ? 'get_file 没有返回可下载地址' : '没有可用的下载地址')
  }
  writeFileSync(target, buf)
  return { path: target, bytes: buf.length }
}

class Runner {
  #config
  #log
  #jobs = new Map()

  constructor (config, log) {
    this.#config = config
    this.#log = log
  }

  get running () {
    return this.#jobs.size
  }

  has (key) {
    return this.#jobs.has(key)
  }

  /** 打断某条会话；返回是否真的打断了。 */
  stop (key) {
    const job = this.#jobs.get(key)
    if (!job) return false
    job.aborted = true
    clearTimeout(job.timer)
    try { job.child.kill() } catch {}
    this.#jobs.delete(key)
    return true
  }

  stopAll () {
    for (const key of [...this.#jobs.keys()]) this.stop(key)
  }

  /**
   * 跑一轮。key 决定复用哪个 session（同 key = 上下文连续）。
   * 返回 { text, aborted }；aborted 时 text 可能是空串。
   */
  run ({ key, sessionId, prompt, onProgress, cwd: cwdOverride }) {
    const { timeoutSeconds, command, maxOutputChars } = this.#config
    // 新式（0.1.7+）：headless --json --session-id X -    任务走 stdin，答案走 NDJSON
    // 旧式（≤0.1.5）：headless "<任务>"                  任务走 argv，stdout 是纯文本答案
    const mode = command.mode === 'plain' ? 'plain' : 'json'
    // 参数分两段，别混：
    //   ① 选 profile —— 有 profile 就 --profile <name>，否则用 headless 快捷子命令
    //   ② app 自己的参数 —— --json / --session-id / 任务 / -
    // 两段都塞 headless 会拼成 '--profile headless headless --json -'，
    // 多出来的 headless 被当成任务参数，报 `-` must be the only task argument。
    // fakeScript：测试用 —— bin 是 node、第一个位置参数是脚本路径，不是 dsh 子命令
    const selector = command.fakeScript
      ? [command.fakeScript]
      : command.profile
        ? ['--profile', command.profile]
        : ['headless']
    const appArgs = command.profileArgs ?? ['--json']
    const args = mode === 'plain'
      // 旧版没有 --json / --session-id / stdin，任务只能作为位置参数
      ? [...selector, prompt, ...(command.extraArgs ?? [])]
      : [...selector,
          ...appArgs,
          ...(sessionId ? ['--session-id', sessionId] : []),
          ...(command.extraArgs ?? []),
          '-']

    return new Promise((resolve) => {
      this.#log(`run: session=${sessionId ?? 'new'} key=${key} prompt=${JSON.stringify(prompt.slice(0, 80))}`)

      let child
      try {
        const bin = resolveBin(command.bin)
        // 工作目录优先级：本次覆盖（/dsh dir）> 配置 cwd > 当前进程目录
        const effectiveCwd = (cwdOverride && cwdOverride.trim() !== '')
          ? cwdOverride
          : (this.#config.cwd && this.#config.cwd.trim() !== '' ? this.#config.cwd : process.cwd())
        child = spawn(bin, args, {
          cwd: effectiveCwd,
          env: process.env,
          // Headless 的答案是 NDJSON，走管道；任务本身走 stdin
          stdio: ['pipe', 'pipe', 'pipe'],
          // 批处理垫片必须走 shell，否则 Windows 上 EINVAL
          shell: command.shell || needsShell(bin),
        })
      } catch (error) {
        resolve({ text: '', aborted: false, error: `无法启动 dsh：${error.message}` })
        return
      }

      let stdout = ''
      let stderr = ''
      let stdoutBuf = ''
      let finalText = ''
      let turnReason = null
      let actualSessionId = sessionId ?? ''
      let aborted = false
      let step = 0

      const job = {
        child,
        aborted: false,
        timer: null,
      }
      this.#jobs.set(key, job)

      const timer = setTimeout(() => {
        job.aborted = true
        this.#log(`run: 超时 ${timeoutSeconds}s，终止 ${key}`)
        try { child.kill() } catch {}
      }, timeoutSeconds * 1000)
      job.timer = timer

      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.#jobs.delete(key)
        resolve(result)
      }

      child.stdout.setEncoding('utf8')
      if (mode === 'plain') {
        // 旧版没有事件流：stdout 全文就是答案，reasoning 混在 stderr 里
        child.stdout.on('data', (chunk) => { stdout += chunk })
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk) => { stderr += chunk })
        child.on('error', (error) => {
          finish({ text: '', sessionId: actualSessionId, aborted: job.aborted, error: `dsh 启动失败：${error.message}` })
        })
        child.on('close', (code, signal) => {
          const wasAborted = job.aborted
          const text = stdout.trim()
          if (text !== '') {
            finish({ text, sessionId: actualSessionId, aborted: wasAborted })
            return
          }
          const detail = stderr.trim().split('\n').filter(Boolean).slice(-3).join('\n')
          finish({
            text: '',
            sessionId: actualSessionId,
            aborted: wasAborted,
            error: wasAborted ? null : `执行未产出答案（exit ${code}${signal ? `/${signal}` : ''}）${detail ? `\n${detail}` : ''}`,
          })
        })
        child.stdin.on('error', () => {})
        child.stdin.end()
        return
      }

      child.stdout.on('data', (chunk) => {
        stdout += chunk
        stdoutBuf += chunk
        let index
        while ((index = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, index).trim()
          stdoutBuf = stdoutBuf.slice(index + 1)
          if (line === '') continue
          let event
          try { event = JSON.parse(line) } catch { continue }
          if (event.type === 'session' && typeof event.sessionId === 'string') {
            actualSessionId = event.sessionId
            onProgress?.({ kind: 'session', sessionId: event.sessionId })
          } else if (event.type === 'final' && typeof event.text === 'string') {
            finalText = event.text
          } else if (event.type === 'status' && event.phase === 'turn_end') {
            turnReason = event.reason ?? null
          } else if (event.type === 'status' && event.phase === 'step_start') {
            step = event.step ?? step + 1
            onProgress?.({ kind: 'step', step, turn: event.turn ?? 1 })
          } else if (event.type === 'tool_call') {
            const tool = String(event.tool ?? 'tool')
            onProgress?.({
              kind: 'tool_call',
              tool,
              detail: summarizeToolInput(tool, event.input),
              step,
            })
          } else if (event.type === 'tool_result') {
            onProgress?.({
              kind: 'tool_result',
              tool: '', // 结果事件不带工具名，按 callId 回填
              callId: event.callId,
              status: event.status === 'error' ? 'error' : 'completed',
              detail: summarizeToolResult(event.result),
              step,
            })
          } else if (event.type === 'thinking' && typeof event.text === 'string') {
            const first = firstLine(event.text, 60)
            if (first) onProgress?.({ kind: 'thinking', detail: first, step })
          } else if (event.type === 'error' && typeof event.message === 'string') {
            stderr += `\n${event.message}`
          }
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => { stderr += chunk })

      child.on('error', (error) => {
        finish({ text: '', sessionId: actualSessionId, aborted: job.aborted, error: `dsh 启动失败：${error.message}` })
      })

      child.on('close', (code, signal) => {
        const wasAborted = job.aborted || aborted
        if (finalText.trim() !== '') {
          finish({ text: finalText, sessionId: actualSessionId, aborted: wasAborted })
          return
        }
        // 没有 final：把 stderr 里最能说明问题的那行捞出来，别把整个堆栈甩进群
        const reason = turnReason?.kind ?? (code !== 0 ? `exit ${code}${signal ? `/${signal}` : ''}` : 'no-output')
        const detail = stderr.trim().split('\n').filter(Boolean).slice(-3).join('\n')
        finish({
          text: '',
          sessionId: actualSessionId,
          aborted: wasAborted,
          error: wasAborted ? null : `执行未产出答案（${reason}）${detail ? `\n${detail}` : ''}`,
        })
      })

      child.stdin.on('error', () => {})
      child.stdin.end(prompt, 'utf8')
    })
  }
}

/**
 * Plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config
 */
export function apply (ctx, rawConfig) {
  const config = withDefaults(rawConfig)

  // 环形日志缓冲：设置页要能看到最近发生了什么，不必去翻控制台。
  // 必须定义在 log() **之前** —— 早期版本把它放在 apply 末尾，
  // 结果前面所有日志都没进缓冲，设置页只显示最后一条。
  const logRing = []
  const pushLog = (line) => {
    logRing.push({ at: Date.now(), text: line })
    if (logRing.length > 300) logRing.shift()
  }

  const log = (line) => {
    try { pushLog(line) } catch {}
    try { ctx.logger?.info?.(`[qq-bridge] ${line}`) ?? console.error(`[qq-bridge] ${line}`) } catch {}
  }

  // 只有用户没显式指定 mode 时才去探测，避免每次启动多跑一个 --help
  if (config.command.mode === undefined) {
    config.command.mode = detectHeadlessMode(config.command.bin)
    log(`headless 调用形态：${config.command.mode === 'json' ? 'NDJSON（0.1.7+）' : '纯文本（≤0.1.5）'}`)
  }
  if (config.command.profile === undefined || config.command.profile === null) {
    config.command.profile = 'headless'
    log('提示：command.profile 未配置，回退到 headless profile')
  }
  // 空字符串 = 显式不带 --profile（测试用假可执行文件时需要）
  log(`使用 profile：${config.command.profile || '（不传 --profile）'}`)

  const allowedGroups = new Set((config.allowedGroups ?? []).map(String))
  const allowedUsers = new Set((config.allowedUsers ?? []).map(String))
  const prefixes = config.commandPrefixes ?? ['/dsh']
  const runner = new Runner(config, log)
  const queue = []
  let active = 0

  // ---- 执行后端选择（按优先级回退） ----
  //   internal : 当前 DSH 进程内建会话（最快，且 Web 里可见可接管）
  //   acp      : 常驻子进程（快，但会话独立）
  //   headless : 每次 spawn（最慢，最稳）
  let internal = null
  let acp = null

  // 注意：apply() 执行时 loader 还没把 agents/sessions 挂上来，此刻判断 available
  // 会恒为 false。所以这里只登记想用哪个，真正可用性在第一次 prompt 时判断。
  if (config.backend === 'internal') {
    internal = new InternalRunner(ctx, log)
    log('执行后端：internal（进程内会话，Web 可见）—— 首次调用时确认可用性')
  }

  // ACP 作为 internal 的回退：先建客户端，进程惰性启动
  if (config.backend === 'acp' || config.backend === 'internal') {
    acp = new AcpClient({
      bin: resolveBin(config.command.bin),
      args: ['--profile', config.command.acpProfile ?? 'acp'],
      log: (line) => log(line),
    })
  }
  if (config.backend === 'headless') {
    log('执行后端：headless（一次性子进程）')
  }

  // ctx 释放时关掉常驻资源，避免残留
  try { ctx.effect?.({ dispose: () => acp?.close() }) } catch {}

  // 会话状态（借鉴 cc-connect 的 session management）：
  //   sessions: Map<chatKey, Array<{ id, name, at }>>  每群/每人的历史会话
  //   current:  Map<chatKey, index>                     当前用第几个
  //   lastAt:   Map<chatKey, timestamp>                 最后一次活动时间
  //   cwdOf:    Map<chatKey, string>                    该会话的工作目录覆盖
  //
  // 为什么要多个会话：上下文漂移是真实问题。一次失败的调试会把十几条无关日志
  // 灌进历史，之后再问什么都在这堆噪声里找答案。'/dsh new' 换一条干净的。
  const sessions = new Map()
  const current = new Map()
  const lastAt = new Map()
  const cwdOf = new Map()

  /** 当前会话对象（可能还没有 sessionId —— 首次执行时才由 dsh 分配）。 */
  const currentSession = (key) => {
    const list = sessions.get(key)
    if (!list || list.length === 0) return null
    const idx = Math.min(current.get(key) ?? 0, list.length - 1)
    return list[idx] ?? null
  }

  /** 当前会话的 sessionId（给 dsh --session-id 用）。 */
  const sessionIdOf = (key) => currentSession(key)?.id ?? undefined

  /** 记录 dsh 返回的真实 sessionId 到当前会话。 */
  const rememberSession = (key, id) => {
    if (!id) return
    const s = currentSession(key)
    if (s && !s.id) s.id = id
  }

  /** 空闲超时后自动开新会话，避免上下文漂移（对齐 cc-connect 的 reset_on_idle_mins）。 */
  const maybeResetOnIdle = (key) => {
    const idleMin = config.resetOnIdleMins
    if (!idleMin || idleMin <= 0) return false
    const last = lastAt.get(key)
    if (last && Date.now() - last > idleMin * 60_000) {
      const list = sessions.get(key) ?? []
      list.push({ id: undefined, name: '自动重置', at: Date.now() })
      sessions.set(key, list)
      current.set(key, list.length - 1)
      log('会话空闲超过 ' + idleMin + ' 分钟，已自动开新会话')
      return true
    }
    return false
  }

  const touchSession = (key) => { lastAt.set(key, Date.now()) }

  /** 判断这条消息是否该被处理；返回 { ok, task, isPrivate, id, key } */
  const classify = (event) => {
    const type = event.message_type
    const isPrivate = type === 'private'
    const groupId = event.group_id === undefined ? '' : String(event.group_id)
    const userId = event.user_id === undefined ? '' : String(event.user_id)

    // 仅私聊模式：群里一条都不处理。
    //
    // 注意别用「把 allowedGroups 清空」来实现 —— 那个配置的语义是
    // 「空 = 不限制任何群」，清空反而放开了所有群。必须显式拦掉。
    if (config.privateOnly === true && !isPrivate) return { ok: false }

    if (type !== 'group' && !isPrivate) return { ok: false }
    if (isPrivate) {
      if (allowedUsers.size > 0 && !allowedUsers.has(userId)) return { ok: false }
    } else {
      if (allowedGroups.size > 0 && !allowedGroups.has(groupId)) return { ok: false }
      if (allowedUsers.size > 0 && !allowedUsers.has(userId)) return { ok: false }
    }

    const raw = segmentsToText(event.message ?? event.raw_message ?? '')
    let task = takePrefix(raw, prefixes)
    if (task === null) {
      if (!isPrivate && config.requireMention) return { ok: false }
      task = raw
    }
    return {
      ok: true,
      task: task.trim(),
      isPrivate,
      groupId,
      userId,
      // 同群共享一个会话；私聊按人隔离
      key: isPrivate ? `private:${userId}` : `group:${groupId}`,
    }
  }

  const reply = async (event, text) => {
    const params = event.message_type === 'group'
      ? { message_type: 'group', group_id: event.group_id, message: text }
      : { message_type: 'private', user_id: event.user_id, message: text }
    await client.call('send_msg', params)
  }

  const replyChunks = async (event, text) => {
    const chunks = splitMessage(text, config.maxOutputChars)
    for (let i = 0; i < chunks.length; i += 1) {
      const prefix = chunks.length > 1 ? '[' + (i + 1) + '/' + chunks.length + ']' + String.fromCharCode(10) : ''
      await reply(event, prefix + chunks[i])
    }
  }

  /**
   * 把本地文件作为附件发回聊天（借鉴 cc-connect 的 Agent Attachment Send-Back）。
   *
   * 场景：让 DSH 生成图表/截图/报告，完成后直接出现在手机上，不用再去电脑翻文件。
   * OneBot 的 send_group_msg/send_private_msg 支持 file 段，传本地绝对路径即可。
   */
  const replyFile = async (event, filePath) => {
    const seg = { type: 'file', data: { file: filePath } }
    const params = event.message_type === 'group'
      ? { message_type: 'group', group_id: event.group_id, message: [seg] }
      : { message_type: 'private', user_id: event.user_id, message: [seg] }
    await client.call('send_msg', params, 60_000)
  }

  /**
   * 从回答里认出「用户想要的产物」并真的发过去。
   *
   * 要认全三种写法（都是实测中真实出现过的）：
   *   1. markdown 链接：**[name.xlsx](inbox/name.xlsx)**  ← 模型最常用这个
   *   2. 显式标记：附件: /path/to/file
   *   3. 裸盘符路径：<盘符>:\...\video.mp4 或 inbox/xxx.xlsx
   *
   * 路径可能是绝对路径，也可能是相对 cwd 的 —— 都要试。
   */
  const sendOutAttachments = async (event, text) => {
    if (!config.sendAttachments) return text
    const baseCwd = cwdOf.get(event._qqKey) ?? (config.cwd && config.cwd.trim() !== '' ? config.cwd : process.cwd())

    const resolve = (raw) => {
      const cand = raw.trim().replace(/^[`'"]+|[`'"]+$/g, '').trim()
      if (cand === '') return null
      const tries = [cand, join(baseCwd, cand)]
      for (const t of tries) {
        try { if (statSync(t).isFile()) return t } catch {}
      }
      return null
    }

    const sent = []
    const seen = new Set()
    const trySend = async (raw) => {
      const p = resolve(raw)
      if (p === null || seen.has(p)) return false
      seen.add(p)
      try {
        await replyFile(event, p)
        sent.push(p)
        log('已回传附件：' + p)
        return true
      } catch (error) {
        log('附件回传失败 ' + p + '：' + (error?.message ?? error))
        return false
      }
    }

    // ---- 保守策略：只发「明确被标记为交付物」的文件 ----
    //
    // 早期版本见到路径就发，结果：回答里**讨论**到某个文件（引用、举例、
    // 对比旧新文件名）也会被当成要交付，导致同一个文件发两遍、甚至把
    // 上下文里提到过的无关文件也发出去。
    //
    // 现在只认三种明确信号：
    //   1. 独占一行的 markdown 链接  [name](path)
    //   2. 显式标记行               附件: path
    //   3. 「已发送/已生成」+ 链接   （模型自己说发出去了）
    //
    // 行内顺带提到的路径一律不发。
    const lines = text.split(String.fromCharCode(10))
    const mdLink = /^\s*(?:[-*]\s*)?\*{0,2}\[([^\]\n]{1,80})\]\(([^()\n]{1,500})\)\*{0,2}\s*[:：]?\s*(.*)$/
    const labelled = /^\s*(?:[-*]\s*)?(?:附件|文件|已生成|已保存|产物|交付)[:：]\s*(\S.*)$/

    for (const line of lines) {
      if (line.trim() === '') continue

      // 1) 独占一行的 markdown 链接
      const md = line.match(mdLink)
      if (md) { await trySend(md[2]); continue }

      // 2) 显式标记行
      const lb = line.match(labelled)
      if (lb) {
        // 标记后面可能跟路径，也可能跟 markdown 链接
        const inner = lb[1].match(/\[[^\]]*\]\(([^()]+)\)/)
        await trySend(inner ? inner[1] : lb[1])
        continue
      }
    }

    if (sent.length > 0) log('本轮回传 ' + sent.length + ' 个附件')
    return text
  }

  const processOne = async (job) => {
    const { event, info } = job
    let text

    const reporter = new ProgressReporter({
      event,
      // 进度走普通 reply，不分片：一条短状态不该被切成 [1/3]
      reply: (e, t) => reply(e, t),
      options: config.progress,
      log,
    })
    reporter.start()
    try {
      // internal 可用性在运行时判断：apply 阶段服务还没挂上来，那时判断必然为 false。
      const useInternal = internal !== null && internal.available
      if (internal && !useInternal) {
        log('internal 不可用（' + internal.unavailableReason + '），本次回退 ACP')
      }

      // 让模型知道自己在 QQ 里：用户看不到弹窗，产物要用 markdown 链接给出
      const preamble = config.promptPreamble && config.promptPreamble.trim() !== ''
        ? config.promptPreamble.trim() + String.fromCharCode(10) + String.fromCharCode(10)
        : ''
      const fullTask = preamble + info.task

      if (useInternal) {
        // ---- 进程内后端：会话是活的，DSH Web 里能围观也能接管 ----
        const cwd = cwdOf.get(info.key) ?? (config.cwd || process.cwd())
        const out = await internal.prompt(info.key, fullTask, { cwd })
        touchSession(info.key)
        text = (out.text ?? '').trim() || '（本轮没有文字输出）'
      } else if (acp) {
        // ---- ACP 常驻后端：同会话后续 prompt 只需几百毫秒 ----
        const cwd = cwdOf.get(info.key) ?? (config.cwd || process.cwd())
        const out = await acp.prompt(info.key, info.task, {
          cwd,
          model: config.acpModel,
          onProgress: (u) => reporter.push(u),
        })
        touchSession(info.key)
        text = (out.text ?? '').trim() || '（本轮没有文字输出）'
      } else {
        const result = await runner.run({
          key: info.key,
          sessionId: config.perGroupSession ? sessionIdOf(info.key) : undefined,
          prompt: info.task,
          cwd: cwdOf.get(info.key),
          onProgress: (update) => reporter.push(update),
        })
        if (result.sessionId && config.perGroupSession) {
          rememberSession(info.key, result.sessionId)
        }
        touchSession(info.key)
        if (result.aborted) {
          text = '已停止本群正在执行的任务。'
        } else if (result.error) {
          text = `执行失败：${result.error}`
        } else {
          text = result.text.trim() || '（本轮没有文字输出）'
        }
      }
    } catch (error) {
      text = `执行失败：${error?.message ?? error}`
    } finally {
      reporter.stop()
    }
    try {
      // 先把回答里的产物发出去（失败不影响文字回复）
      let body = text
      try {
        event._qqKey = info.key // 让附件解析知道该用哪个 cwd
        body = await sendOutAttachments(event, text)
      } catch (error) {
        log(`附件回传失败：${error?.message ?? error}`)
      }
      if (body && body.trim() !== '') await replyChunks(event, body)
    } catch (error) {
      log(`回消息失败：${error?.message ?? error}`)
    }
  }

  const pump = () => {
    while (active < config.maxConcurrent && queue.length > 0) {
      const job = queue.shift()
      active += 1
      void processOne(job).finally(() => {
        active -= 1
        pump()
      })
    }
  }

  /**
   * 处理带图片/文件的消息：先下载到 inbox，再把路径写进任务。
   *
   * headless 只吃文本，所以这条路是「落地 + 引用」而不是真的把二进制喂给模型。
   * 下载失败不阻塞：把失败原因写进 prompt，模型至少能告诉用户哪张图没拿到。
   */
  const handleMedia = async (event, info, media) => {
    const inbox = join(config.cwd && config.cwd.trim() !== '' ? config.cwd : process.cwd(), 'inbox')

    if (runner.has(info.key)) {
      await reply(event, '本群上一个任务还在跑，等它结束或用 /dsh stop 打断。')
      return
    }

    // 图片/文件要下载、要跑模型，先把「收到」发出去
    if (config.ackOnReceive !== false) {
      const kinds = media.map((m) => m.kind === 'image' ? '图片' : '文件').join('、')
      void reply(event, '收到 ' + media.length + ' 个' + kinds + '，正在下载…')
        .catch((error) => log('媒体回执失败：' + (error?.message ?? error)))
    }

    const saved = []
    for (const m of media) {
      try {
        const got = await downloadMedia(m, inbox, {
          // QQ 文件消息只有 file_id，没有 url —— 用 get_file 换真实地址
          resolveFileUrl: async (fileId) => {
            const info = await client.call('get_file', { file_id: fileId }, 60_000)
            log('get_file 返回：' + JSON.stringify(info).slice(0, 200))
            return info
          },
        })
        saved.push({ ...got, kind: m.kind, name: m.name })
        log(`媒体已保存：${got.path} (${Math.round(got.bytes / 1024)} KB)`)
      } catch (error) {
        saved.push({ failed: true, kind: m.kind, name: m.name, reason: String(error?.message ?? error) })
        log(`媒体下载失败：${m.name} — ${error?.message ?? error}`)
      }
    }

    const ok = saved.filter((s) => !s.failed)
    const bad = saved.filter((s) => s.failed)

    // 拼任务：用户原本的文字 + 文件清单
    const parts = []
    if (info.task) parts.push(info.task)
    if (ok.length > 0) {
      parts.push('')
      parts.push('收到的文件（请用 read_image / read 工具读取后再回答）：')
      for (const s of ok) {
        parts.push(`- ${s.kind === 'image' ? '图片' : '文件'}: ${s.path}`)
      }
    }
    if (bad.length > 0) {
      parts.push('')
      parts.push(`以下文件下载失败，无法查看：${bad.map((b) => b.name + '（' + b.reason + '）').join('、')}`)
    }
    const prompt = parts.join('\n').trim()
    if (prompt === '') {
      await reply(event, '收到文件但没能处理，请再试一次。')
      return
    }

    await reply(event, ok.length > 0 ? `收到 ${ok.length} 个文件，正在处理…` : '文件下载失败，正在说明原因…')
    queue.push({ event, info: { ...info, task: prompt } })
    pump()
  }

  const onEvent = (event) => {
    if (event?.post_type !== 'message') return
    const info = classify(event)
    if (!info.ok) return

    // 媒体（图片/文件）要异步下载，再拼进任务文本；其余命令走原同步路径。
    const media = extractMedia(event.message)
    if (media.length > 0) {
      void handleMedia(event, info, media).catch((error) => log(`媒体处理失败：${error}`))
      return
    }

    const task = info.task

    if (task === '' ) {
      if (config.helpOnEmpty) void reply(event, HELP_TEXT).catch((error) => log(`帮助回复失败：${error}`))
      return
    }

    const lowered = task.toLowerCase()
    if (lowered === 'stop' || lowered === '取消') {
      const stopped = runner.stop(info.key)
      void reply(event, stopped ? '已停止本群正在执行的任务。' : '本群当前没有正在执行的任务。')
        .catch((error) => log(`stop 回复失败：${error}`))
      return
    }

    if (lowered === 'ping') {
      const s = currentSession(info.key)
      void reply(event, 'pong · 队列 ' + queue.length + ' · 执行中 ' + active + '/' + config.maxConcurrent + ' · 会话 ' + (s?.id ?? '未建立'))
        .catch((error) => log('ping 回复失败：' + error))
      return
    }

    if (lowered === 'help' || lowered === '帮助' || lowered === '?') {
      void reply(event, HELP_TEXT).catch((error) => log('帮助回复失败：' + error))
      return
    }

    // ---- 会话管理（借鉴 cc-connect）----
    if (lowered === 'new' || lowered.startsWith('new ')) {
      const name = task.slice(3).trim() || ('会话 ' + ((sessions.get(info.key)?.length ?? 0) + 1))
      const list = sessions.get(info.key) ?? []
      list.push({ id: undefined, name, at: Date.now() })
      sessions.set(info.key, list)
      current.set(info.key, list.length - 1)
      touchSession(info.key)
      void reply(event, '已开新会话：' + name + '（上下文已清空）')
        .catch((error) => log('new 回复失败：' + error))
      return
    }

    if (lowered === 'list' || lowered === '列表') {
      const list = sessions.get(info.key) ?? []
      if (list.length === 0) {
        void reply(event, '还没有会话记录，直接发任务即可创建。')
        return
      }
      const idx = current.get(info.key) ?? 0
      const lines = list.map((s, i) => (i === idx ? '▶ ' : '  ') + (i + 1) + '. ' + s.name + (s.id ? '' : '（未建立）'))
      void reply(event, '本群会话：' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)) + String.fromCharCode(10) + '用 /dsh switch <序号> 切换')
        .catch((error) => log('list 回复失败：' + error))
      return
    }

    if (lowered.startsWith('switch ')) {
      const n = Number.parseInt(task.slice(7).trim(), 10)
      const list = sessions.get(info.key) ?? []
      if (!Number.isFinite(n) || n < 1 || n > list.length) {
        void reply(event, '序号无效，当前共 ' + list.length + ' 个会话。')
        return
      }
      current.set(info.key, n - 1)
      touchSession(info.key)
      void reply(event, '已切换到会话 ' + n + '：' + list[n - 1].name)
        .catch((error) => log('switch 回复失败：' + error))
      return
    }

    if (lowered === 'current' || lowered === '当前') {
      const s = currentSession(info.key)
      const cwd = cwdOf.get(info.key) ?? config.cwd ?? process.cwd()
      void reply(event, '当前会话：' + (s?.name ?? '未建立') + String.fromCharCode(10) + 'sessionId：' + (s?.id ?? '（首次执行时分配）') + String.fromCharCode(10) + '工作目录：' + cwd)
        .catch((error) => log('current 回复失败：' + error))
      return
    }

    // ---- 工作目录（借鉴 cc-connect 的 /dir）----
    if (lowered === 'dir' || lowered === 'cd') {
      const cwd = cwdOf.get(info.key) ?? config.cwd ?? process.cwd()
      void reply(event, '当前工作目录：' + cwd + String.fromCharCode(10) + '用 /dsh dir <路径> 切换，/dsh dir - 回到上一个')
        .catch((error) => log('dir 回复失败：' + error))
      return
    }

    if (lowered.startsWith('dir ') || lowered.startsWith('cd ')) {
      const arg = task.slice(task.indexOf(' ') + 1).trim()
      const prev = cwdOf.get(info.key)
      if (arg === '-') {
        if (!prev) { void reply(event, '没有上一个目录记录。'); return }
        cwdOf.delete(info.key)
        void reply(event, '已回到：' + (config.cwd ?? process.cwd()))
        return
      }
      try {
        statSync(arg)
        cwdOf.set(info.key, arg)
        void reply(event, '工作目录已切到：' + arg + (prev ? '' : ''))
          .catch((error) => log('dir 切换回复失败：' + error))
      } catch {
        void reply(event, '目录不存在或无权访问：' + arg)
      }
      return
    }

    if (runner.has(info.key)) {
      void reply(event, '本群上一个任务还在跑，等它结束或用 /dsh stop 打断。')
        .catch((error) => log(`忙回复失败：${error}`))
      return
    }

    if (queue.length >= 32) {
      void reply(event, '排队任务过多，请稍后再试。')
        .catch((error) => log(`队列回复失败：${error}`))
      return
    }

    // 回执在**入队时**就发，不等 pump 派发 ——
    // 否则上一个任务还在跑时，用户要等它结束才看到「收到」。
    if (config.ackOnReceive !== false) {
      const preview = info.task.length > 24 ? info.task.slice(0, 24) + '…' : info.task
      const queued = active > 0 || queue.length > 0
      void reply(event, (queued ? '已排队，前面还有任务…' : '收到，正在处理…') + (preview ? '（' + preview + '）' : ''))
        .catch((error) => log('回执发送失败：' + (error?.message ?? error)))
    }

    queue.push({ event, info })
    pump()
  }

  const client = new OneBotClient({
    url: config.onebot?.endpoint ?? 'ws://127.0.0.1:3001',
    token: config.onebot?.accessToken ?? '',
    reconnectDelayMs: config.onebot?.reconnectDelayMs ?? 3000,
    maxReconnectDelayMs: config.onebot?.maxReconnectDelayMs ?? 30_000,
    onEvent,
    log,
  })

  ctx.effect(() => {
    client.start()
    return () => {
      client.stop()
      runner.stopAll()
      queue.length = 0
    }
  }, 'qq-bridge: onebot client')

  // ---- 设置页控制面：启停 NapCat、看状态、看日志 ----
  //
  // 桌面快捷方式在中文路径/无窗口环境下常常点不开，这里把启停搬进
  // DSH 设置页，绕开整套 shell 编码问题。
  const napcat = new NapCatController({
    dir: config.napcat?.dir ?? '<NapCat安装目录>',
    port: Number(config.onebot?.endpoint?.match(/:(\d+)/)?.[1] ?? 3001),
    log,
  })

  pushLog('已加载：' + (config.privateOnly ? '仅私聊' : ('群 ' + (allowedGroups.size > 0 ? [...allowedGroups].join(',') : '（未限制）'))))

  const httpStatus = () => {
    const st = napcat.status()
    return {
      ...st,
      onebot: client.connected,
      backend: internal !== null ? 'internal' : (acp !== null ? 'acp' : 'headless'),
      model: config.acpModel ? config.acpModel.join('/') : 'profile 默认',
      cwd: config.cwd || process.cwd(),
      allowedGroups: [...allowedGroups],
      allowedUsers: [...allowedUsers],
      queue: queue.length,
      active,
    }
  }

  // 通过 connection.fetch.register 暴露一个 HTTP POST 端点。
  // 协议照抄 dsh-providers-hub 的管理 API：
  //   { type:'client-request', rpcId, method:'<endpoint>', payload:{ method, payload } }
  //   应答 { rpcId, result:{ ok, value } | { ok:false, error } }
  const QQ_API_PATH = '/api/qq-bridge'
  const QQ_ENDPOINT = 'qq-bridge'
  const replyJson = (rpcId, result) => new Response(
    JSON.stringify({ type: 'server-response', rpcId, result }),
    { headers: { 'content-type': 'application/json' } },
  )

  const handleMethod = async (method, payload) => {
    switch (method) {
      case 'status': return httpStatus()
      case 'start': return napcat.start()
      case 'stop': return napcat.stop()
      case 'logs': {
        const n = Math.min(Number(payload?.limit) || 120, 300)
        // 合并两份：插件自己的环形日志 + NapCat 控制台的原始输出
        return {
          app: logRing.slice(-n),
          napcat: napcat.readLog(n),
        }
      }
      case 'clearNapcatLog':
        napcat.clearLog()
        return { ok: true }
      default: throw new Error('未知方法: ' + method)
    }
  }

  // ⚠️ 必须用 ctx.inject(['connection'], cb) 等它挂上来。
  // 直接 ctx.get('connection') 在 apply 阶段恒为 undefined ——
  // 和 agents/sessions 是同一个坑（loader 先把插件跑起来，服务随后才就绪）。
  ctx.inject(['connection'], (connectionCtx) => {
    try {
      const conn = connectionCtx.get?.('connection') ?? connectionCtx.connection
      const reg = conn?.fetch?.register
      if (typeof reg !== 'function') {
        log('警告：connection.fetch.register 不可用，设置页控制不可用')
        return
      }
      reg.call(conn.fetch, {
        path: QQ_API_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch (request) {
          if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
          let message
          try { message = await request.json() } catch { return new Response('bad json', { status: 400 }) }
          const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid'
          const call = message?.payload
          if (message?.method !== QQ_ENDPOINT || !call || typeof call.method !== 'string') {
            return replyJson(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'invalid qq-bridge request' } })
          }
          try {
            const value = await handleMethod(call.method, call.payload)
            return replyJson(rpcId, { ok: true, value })
          } catch (error) {
            return replyJson(rpcId, { ok: false, error: { code: 'qq-bridge/failed', message: String(error?.message ?? error) } })
          }
        },
      })
      log('设置页 API 已注册：' + QQ_API_PATH)
    } catch (error) {
      log('注册设置页 API 失败：' + (error?.message ?? error))
    }
  })

  log('已加载：' + (config.privateOnly ? '仅私聊' : ('群 ' + (allowedGroups.size > 0 ? [...allowedGroups].join(',') : '（未限制）'))) + ' · endpoint ' + config.onebot?.endpoint)
}
