/**
 * 进度上报：把 headless 的 tool_call / tool_result / step 事件，
 * 变成群里的“进行中”消息。
 *
 * 四条硬约束（QQ 群不是终端，刷屏比没进度更糟）：
 * 1. 任务跑得慢才报——startAfterMs 之内的快速任务一条进度都不发；
 * 2. 只在工具切换时报告——同一工具连续调用不重复上报，攒成 `▸ 终端 ×5`；
 * 3. 节流——两次进度至少隔 minIntervalMs，期间事件合并成一条；
 * 4. 封顶——单个任务最多 maxMessages 条，防止长时间任务把群刷爆。
 */

const TOOL_LABELS = {
  bash: '终端',
  shell: '终端',
  read: '读文件',
  write: '写文件',
  edit: '改文件',
  glob: '找文件',
  grep: '搜内容',
  web_search: '搜索',
  web_fetch: '抓网页',
  subagent: '子任务',
  subagent_fork: '子任务',
  todo_write: '列计划',
  present: '交付文件',
  skill: '加载技能',
  workflow: '工作流',
}

export function toolLabel (tool) {
  if (!tool) return '工具'
  return TOOL_LABELS[tool] ?? tool
}

/** 一步跑多久就显示成 x.xs / xm00s，群里读起来比毫秒直观。 */
export function formatElapsed (ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

export class ProgressReporter {
  #event
  #reply
  #options
  #log
  #startedAt
  #timer = null
  #lines = []
  #sent = 0
  #step = 0
  #shownStep = 0
  #lastTool = ''
  #repeat = 0
  #pendingLine = -1
  #closed = false

  constructor ({ event, reply, options, log }) {
    this.#event = event
    this.#reply = reply
    this.#options = options
    this.#log = log
    this.#startedAt = Date.now()
  }

  get #enabled () {
    return this.#options?.enabled !== false
  }

  start () {
    if (!this.#enabled || this.#closed) return
    const interval = Math.max(1000, this.#options?.minIntervalMs ?? 6000)
    this.#timer = setInterval(() => { void this.#flush() }, interval)
    // 不拖住进程退出
    this.#timer.unref?.()
  }

  /** 接收一条进度更新；只记录，不立刻发。 */
  push (update) {
    if (!this.#enabled || this.#closed) return
    if (update.kind === 'step') {
      this.#step = update.step ?? this.#step
      return
    }
    if (update.kind === 'tool_call') {
      const tool = update.tool ?? ''
      const label = toolLabel(tool)
      const detail = update.detail ? ` ${update.detail}` : ''
      // 只在工具切换时报告：同一工具连着调用，不新起一行
      if (tool !== '' && tool === this.#lastTool) {
        this.#repeat += 1
        // 还没发出去的那条就地合并成 `▸ 终端 ×3`，发过的就不再多说
        if (this.#pendingLine >= 0 && this.#pendingLine === this.#lines.length - 1) {
          this.#lines[this.#pendingLine] = `▸ ${label}${detail} ×${this.#repeat + 1}`
        }
        return
      }
      this.#lastTool = tool
      this.#repeat = 0
      this.#lines.push(`▸ ${label}${detail}`)
      this.#pendingLine = this.#lines.length - 1
      return
    }
    if (update.kind === 'tool_result') {
      const label = toolLabel(update.tool ?? this.#lastTool)
      const mark = update.status === 'error' ? '✗' : '✓'
      const last = this.#lines.length > 0 ? this.#lines[this.#lines.length - 1] : null
      // 结果只回填到最近一条对应工具的进度上，没有就单起一行
      if (last === null) {
        this.#lines.push(`${mark} ${label}`)
        this.#pendingLine = this.#lines.length - 1
      } else {
        // 连续多次结果不叠加打勾
        this.#lines[this.#lines.length - 1] = `${last.replace(/\s*[✓✗]$/, '')} ${mark}`
      }
      return
    }
    if (update.kind === 'thinking' && update.detail) {
      this.#lines.push(`… ${update.detail}`)
    }
  }

  async #flush () {
    if (!this.#enabled || this.#closed) return
    if (this.#lines.length === 0) return

    const elapsed = Date.now() - this.#startedAt
    // 快任务不报：没到启动阈值就继续攒着
    if (elapsed < (this.#options?.startAfterMs ?? 8000)) return
    if (this.#sent >= (this.#options?.maxMessages ?? 12)) return

    // 只带最近几条，避免一条消息过长
    const tail = this.#lines.slice(-6)
    this.#lines = []
    this.#pendingLine = -1
    this.#sent += 1
    this.#shownStep = this.#step

    const header = `⏳ 进行中 ${formatElapsed(elapsed)}${this.#shownStep > 0 ? ` · 第 ${this.#shownStep} 步` : ''}`
    const text = [header, ...tail].join('\n')
    try {
      await this.#reply(this.#event, text)
    } catch (error) {
      this.#log(`进度发送失败：${error?.message ?? error}`)
    }
  }

  /** 立刻尝试发一次（定时器之外的手动触发；测试也用这个）。 */
  flushNow () {
    return this.#flush()
  }

  /** 任务结束：停掉定时器。残留的进度行丢弃，由最终答案覆盖。 */
  stop () {
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  get sentCount () {
    return this.#sent
  }

  /** 仅供测试：看一眼尚未发出的进度行。 */
  linesForTest () {
    return [...this.#lines]
  }
}
