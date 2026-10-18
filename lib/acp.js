
/**
 * DSH ACP 客户端 —— 用常驻的 `dsh --profile acp` 代替每次 spawn headless。
 *
 * ## 为什么值得
 *
 * headless 每次都要冷启动（实测 13–17 秒），聊一句等十几秒没法用。
 * ACP 是 DSH 官方为自动化场景提供的常驻服务（JSON-RPC over stdio），
 * 起一次之后同会话的后续 prompt 只要几百毫秒到几秒。
 *
 * ## 协议要点（实测确认）
 *
 * - 传输：NDJSON（一行一个 JSON-RPC 消息）走 stdin/stdout
 * - initialize → session/new → session/prompt
 * - 模型用 session/set_config_option（**下划线**，不是 setConfigOption）
 * - 回复是流式通知 session/update，取 agent_message_chunk 拼接
 * - 图片能力：initialize 里返回 promptCapabilities.image，需模型支持
 *
 * ## 生命周期
 *
 * 一个进程对应一个会话映射表；进程挂了自动重启，未完成的请求全部 reject。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export class AcpClient {
  #bin
  #log
  #args
  #child = null
  #buf = ''
  #pending = new Map()
  #sessions = new Map() // key -> acp sessionId
  #initPromise = null
  #closed = false
  #seq = 1

  constructor ({ bin, log, args = [] }) {
    this.#bin = bin
    this.#log = log
    this.#args = args
  }

  #ensure () {
    if (this.#child) return Promise.resolve()
    if (this.#initPromise) return this.#initPromise

    this.#initPromise = (async () => {
      const child = spawn(this.#bin, this.#args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
        shell: /.(cmd|bat)$/i.test(this.#bin),
      })
      this.#child = child
      this.#buf = ''

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => this.#onData(chunk))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        const line = String(chunk).trim()
        // ACP 的 stderr 只放诊断，别当错误处理
        if (line && !/DEP0\d+|trace-deprecation/.test(line)) this.#log(`acp stderr: ${line.slice(0, 160)}`)
      })
      child.on('error', (error) => this.#failAll(`acp 启动失败：${error.message}`))
      child.on('close', (code) => this.#failAll(`acp 进程退出（code=${code}）`))

      const init = await this.#call('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
      })
      if (init.error) throw new Error(`initialize 失败：${init.error.message}`)
      this.#log(`acp 已就绪：${init.result?.agentInfo?.name ?? '?'}`)
    })()

    return this.#initPromise
  }

  #onData (chunk) {
    this.#buf += chunk
    let idx
    while ((idx = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, idx).trim()
      this.#buf = this.#buf.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id !== undefined && this.#pending.has(msg.id)) {
        const entry = this.#pending.get(msg.id)
        this.#pending.delete(msg.id)
        entry.resolve(msg)
      } else if (msg.method) {
        this.#onNotification(msg)
      }
    }
  }

  #onNotification (msg) {
    // 流式文本：拼到对应会话的缓冲里
    if (msg.method === 'session/update') {
      const u = msg.params?.update
      if (u?.sessionUpdate === 'agent_message_chunk') {
        const text = u.content?.text ?? ''
        const sid = msg.params?.sessionId
        const buf = this.#streamBuf.get(sid)
        if (buf && text) buf.push(text)
      }
    }
  }

  #streamBuf = new Map()

  #call (method, params) {
    return new Promise((resolve, reject) => {
      if (!this.#child) return reject(new Error('acp 未启动'))
      const id = this.#seq++
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`acp ${method} 超时`))
      }, 600_000)
      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      try {
        this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (error) {
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  #failAll (reason) {
    for (const [, entry] of this.#pending) entry.reject(new Error(reason))
    this.#pending.clear()
    this.#child = null
    this.#initPromise = null
    this.#sessions.clear()
    this.#streamBuf.clear()
  }

  /** 为一个聊天 key 建（或复用）ACP 会话。 */
  async ensureSession (key, cwd, model) {
    await this.#ensure()
    let sid = this.#sessions.get(key)
    if (sid) return sid

    const res = await this.#call('session/new', { cwd, mcpServers: [] })
    if (res.error) throw new Error(`session/new 失败：${res.error.message}`)
    sid = res.result.sessionId
    this.#sessions.set(key, sid)

    // 可选：切到指定模型（值形如 ["provider","model"] 的 JSON 字符串）
    if (model) {
      try {
        const set = await this.#call('session/set_config_option', {
          sessionId: sid,
          configId: 'model',
          value: JSON.stringify(model),
        })
        if (set.error) this.#log(`切模型失败：${set.error.message.slice(0, 100)}`)
      } catch (error) {
        this.#log(`切模型异常：${error?.message ?? error}`)
      }
    }
    return sid
  }

  /** 发一轮 prompt，返回拼好的文本。 */
  async prompt (key, text, { cwd, model, onProgress } = {}) {
    const sid = await this.ensureSession(key, cwd, model)
    const buf = []
    this.#streamBuf.set(sid, buf)

    const started = Date.now()
    const res = await this.#call('session/prompt', {
      sessionId: sid,
      prompt: [{ type: 'text', text }],
    })
    this.#streamBuf.delete(sid)

    if (res.error) {
      throw new Error(res.error.message ?? 'prompt 失败')
    }
    onProgress?.({ kind: 'done', ms: Date.now() - started })
    return { text: buf.join('').trim(), stopReason: res.result?.stopReason }
  }

  /** 开新会话（丢弃旧的）。 */
  async resetSession (key) {
    const sid = this.#sessions.get(key)
    this.#sessions.delete(key)
    if (sid) {
      try { await this.#call('session/close', { sessionId: sid }) } catch {}
    }
  }

  get alive () {
    return this.#child !== null
  }

  close () {
    this.#closed = true
    try { this.#child?.kill() } catch {}
    this.#failAll('acp 已关闭')
  }
}
