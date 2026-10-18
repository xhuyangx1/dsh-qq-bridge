
/**
 * DSH 进程内执行器 —— 直接在 DSH 里创建会话，而不是 spawn 子进程。
 *
 * ## 为什么这是最优解
 *
 * 之前的两种后端各有硬伤：
 *   headless：每次冷启动 13–17 秒，会话存磁盘但 Web 看不到
 *   acp：常驻但独立进程，会话同样不在 Web 里
 *
 * 进程内创建（`ctx.agents.create`）一次性解决全部问题：
 *   - 没有冷启动，模型调用就是直接的
 *   - 会话是**活的**，立刻出现在 DSH Web 的会话列表里
 *   - 可以在 Web 里围观，也可以接着在里面打字
 *
 * ## 关键细节（都踩过）
 *
 * - 参数是 `sessionId`，不是 `id`（写错会报 "agent id undefined does not match session id"）
 * - 必须传 `agentOptions: { provider, model }`，否则提示词里的 {{model}} 变量为空，
 *   turn 直接以 error 结束：'prompt variable "{{model}}" has no value'
 * - 回复从 `session.snapshotEvents()` 里取 `assistant/message` 的 text 分片
 * - 用 `await agent.whenIdle()` 等这一轮跑完，比轮询稳
 */
import { randomUUID } from 'node:crypto'

export class InternalRunner {
  #ctx
  #log
  #makeUserMessage = null
  #agents
  #sessions
  #defaultModel
  #presets
  #live = new Map() // chatKey -> { sessionId, agent }

  constructor (ctx, log) {
    this.#ctx = ctx
    this.#log = log
  }

  /**
   * 懒取服务。
   *
   * 不能在 constructor 里取：插件 apply() 跑的时候 loader 还没把
   * agents/sessions/agentDefaultModel 全部挂上来（实测会拿到 undefined，
   * 于是插件误判"不可用"并回退 ACP）。改成每次用时现取。
   */
  #svc () {
    if (!this.#agents) this.#agents = this.#ctx.get('agents')
    if (!this.#sessions) this.#sessions = this.#ctx.get('sessions')
    if (!this.#defaultModel) this.#defaultModel = this.#ctx.get('agentDefaultModel')
    if (!this.#presets) this.#presets = this.#ctx.get('agentPresets')
    return {
      agents: this.#agents,
      sessions: this.#sessions,
      defaultModel: this.#defaultModel,
      presets: this.#presets,
    }
  }

  /**
   * 构造一条带 id 的 user 消息。
   *
   * 优先用 DSH 官方的 createUserMessage（和 Web 端同构）；
   * 取不到则退回手搓 —— 但必须自己补 id，否则会话日志过不了
   * "lacks an identified message" 校验，历史对话就打不开。
   */
  async #buildUserMessage (text) {
    if (this.#makeUserMessage !== null) return this.#makeUserMessage(text)

    try {
      const llm = await import('@deepseek-ai/dsh-llm')
      if (typeof llm.createUserMessage === 'function') {
        this.#makeUserMessage = (t) => llm.createUserMessage({
          content: [{ type: 'text', text: t }],
          source: { kind: 'user', rpcId: randomUUID() },
        })
        this.#log('使用 DSH 官方 createUserMessage 构造消息')
        return this.#makeUserMessage(text)
      }
    } catch (error) {
      this.#log('createUserMessage 不可用，退回手搓（自带 id）：' + (error?.message ?? error))
    }

    this.#makeUserMessage = (t) => ({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: t }],
      source: { kind: 'user', rpcId: randomUUID() },
    })
    return this.#makeUserMessage(text)
  }

  get available () {
    const s = this.#svc()
    return s.agents !== undefined && s.sessions !== undefined && s.defaultModel !== undefined
  }

  /** 为什么不可用 —— 给日志用。 */
  get unavailableReason () {
    const s = this.#svc()
    const missing = []
    if (!s.agents) missing.push('agents')
    if (!s.sessions) missing.push('sessions')
    if (!s.defaultModel) missing.push('agentDefaultModel')
    return missing.length ? '缺少服务: ' + missing.join(',') : ''
  }

  /** 为一个聊天 key 建会话；已存在则复用。 */
  async ensure (key, cwd, { preset } = {}) {
    const svc = this.#svc()
    const existing = this.#live.get(key)
    if (existing && svc.sessions.get(existing.sessionId) !== undefined) return existing

    const sessionId = 'session-' + randomUUID()
    const selection = svc.defaultModel.currentSelection()
    const agentOptions = { provider: selection.provider, model: selection.model }

    // ---- 关键：装配 agent preset，否则会话是"空壳"——没有任何工具 ----
    //
    // 只传 sessionId + agentOptions 时，模型手上没有 read/bash/read_image，
    // 会直接回"当前会话没有文件读取工具可用"。
    //
    // 正确做法照抄 dsh-api-session-controller 的 composeAgent：
    //   presets.resolve(id)  取默认 preset（standard / ptc 等）
    //   presets.mount(agentCtx, id)  把该 preset 的工具/提示词挂到 agentCtx
    let setup
    let agentPreset
    try {
      if (svc.presets) {
        const resolved = await svc.presets.resolve(preset)
        agentPreset = resolved?.id
        setup = async (agentCtx) => {
          await svc.presets.mount(agentCtx, resolved.id)
        }
        this.#log('装配 agent preset：' + agentPreset)
      } else {
        this.#log('警告：没有 agentPresets 服务，会话将不带工具')
      }
    } catch (error) {
      this.#log('装配 preset 失败（会话将不带工具）：' + (error?.message ?? error))
    }

    const handle = await svc.agents.create({
      sessionId,
      meta: { cwd, ...(agentPreset === undefined ? {} : { agentPreset }) },
      agentOptions,
      ...(setup === undefined ? {} : { setup }),
    })
    const rec = { sessionId, agent: handle.agent }
    this.#live.set(key, rec)
    this.#log(`内部会话已建：${sessionId}（${selection.provider}/${selection.model}）`)
    return rec
  }

  /** 发一轮，返回助手文本。 */
  async prompt (key, text, { cwd, preset } = {}) {
    const { sessionId, agent } = await this.ensure(key, cwd, { preset })
    // 注：preset 走配置项，undefined 时用 DSH 默认（standard/ptc）

    // 记录起点，只读本轮新增的事件
    const live = this.#svc().sessions.get(sessionId)
    const before = (live?.snapshotEvents?.() ?? []).length

    // 必须用 DSH 的 createUserMessage 工厂，不能手搓裸对象！
    //
    // 手搓 { role:'user', content, source } 写进会话日志时**没有 id 字段**，
    // DSH 重载该会话时会报：
    //   "session event at seq N lacks an identified message (gateway/internal)"
    // → 历史对话直接打不开。
    //
    // createUserMessage 会补上稳定 id 并 freeze，正是校验要求的形态。
    agent.followup(await this.#buildUserMessage(text))

    await agent.whenIdle()

    const after = this.#svc().sessions.get(sessionId)?.snapshotEvents?.() ?? []
    const fresh = after.slice(before)
    const texts = []
    let stopReason
    for (const e of fresh) {
      if (e.type === 'assistant/message') {
        for (const part of (e.data?.message?.content ?? [])) {
          if (part.type === 'text') texts.push(part.text)
        }
      } else if (e.type === 'turn/end') {
        stopReason = e.data?.reason
      }
    }

    if (stopReason?.kind === 'error') {
      throw new Error(stopReason.error?.message ?? '回合失败')
    }
    return { text: texts.join('').trim(), stopReason }
  }

  /** 丢弃会话（对应 /dsh new）。 */
  reset (key) {
    this.#live.delete(key)
  }

  /** 列出当前所有内部会话（给 /dsh list 用）。 */
  list () {
    return [...this.#live.entries()].map(([key, v]) => ({ key, sessionId: v.sessionId }))
  }
}
