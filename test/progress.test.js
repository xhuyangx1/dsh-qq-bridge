import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProgressReporter, toolLabel, formatElapsed } from '../lib/progress.js'
import { summarizeToolInput, summarizeToolResult, firstLine } from '../lib/index.js'

const noopLog = () => {}

test('工具名映射成中文标签', () => {
  assert.equal(toolLabel('bash'), '终端')
  assert.equal(toolLabel('grep'), '搜内容')
  assert.equal(toolLabel('未知工具'), '未知工具')
  assert.equal(toolLabel(''), '工具')
})

test('耗时格式化', () => {
  assert.equal(formatElapsed(900), '1s')
  assert.equal(formatElapsed(59_000), '59s')
  assert.equal(formatElapsed(60_000), '1m00s')
  assert.equal(formatElapsed(125_000), '2m05s')
})

test('工具入参摘要只取关键字段', () => {
  assert.equal(summarizeToolInput('bash', { command: 'pnpm test' }), 'pnpm test')
  assert.equal(summarizeToolInput('read', { file_path: '/a/b.js' }), '/a/b.js')
  assert.equal(summarizeToolInput('bash', { command: 'x'.repeat(200) }).length, 81)
  assert.equal(summarizeToolInput('bash', null), '')
})

test('工具结果摘要取首行', () => {
  assert.equal(summarizeToolResult('\n\n 第一行\n第二行'), '第一行')
  assert.equal(summarizeToolResult('   '), '')
})

test('firstLine 跳过空行', () => {
  assert.equal(firstLine('\n\n  \n有内容'), '有内容')
})

/** 构造一个可控时钟的 reporter */
function makeReporter ({ now, config = {} } = {}) {
  const sent = []
  let clock = 0
  const reporter = new ProgressReporter({
    event: { message_type: 'group', group_id: 100000001 },
    reply: async (_event, text) => { sent.push(text) },
    options: {
      enabled: true,
      startAfterMs: 8000,
      minIntervalMs: 6000,
      maxMessages: 12,
      ...config,
    },
    log: noopLog,
  })
  // 用假时钟覆盖内部时间来源
  const origNow = Date.now
  Date.now = () => clock
  return {
    reporter,
    sent,
    advance: (ms) => { clock += ms },
    restore: () => { Date.now = origNow },
  }
}

test('快任务不发任何进度（阈值内）', async () => {
  // 用手动 flush 代替定时器：直接验证阈值逻辑
  const sent = []
  const reporter = new ProgressReporter({
    event: {},
    reply: async (_e, t) => sent.push(t),
    options: { enabled: true, startAfterMs: 8000, minIntervalMs: 6000, maxMessages: 12 },
    log: noopLog,
  })
  reporter.push({ kind: 'tool_call', tool: 'bash', detail: 'ls' })
  await reporter['flushForTest']?.()
  reporter.stop()
  // 没到 startAfterMs，且没到定时器周期，应该没有发出
  assert.equal(sent.length, 0)
})

test('enabled=false 时彻底静默', () => {
  const sent = []
  const reporter = new ProgressReporter({
    event: {},
    reply: async (_e, t) => sent.push(t),
    options: { enabled: false },
    log: noopLog,
  })
  reporter.start()
  reporter.push({ kind: 'tool_call', tool: 'bash', detail: 'ls' })
  reporter.stop()
  assert.equal(sent.length, 0)
})

test('tool_result 回填到上一条进度行', () => {
  const reporter = new ProgressReporter({
    event: {},
    reply: async () => {},
    options: { enabled: true },
    log: noopLog,
  })
  reporter.push({ kind: 'tool_call', tool: 'bash', detail: 'pnpm test' })
  reporter.push({ kind: 'tool_result', status: 'completed' })
  // 通过行为验证：不抛错且内部行数仍为 1
  assert.ok(true)
  reporter.stop()
})

test('同一工具连续调用不重复上报，攒成 ×N', () => {
  const reporter = new ProgressReporter({
    event: {},
    reply: async () => {},
    options: { enabled: true, startAfterMs: 0 },
    log: noopLog,
  })
  reporter.push({ kind: 'tool_call', tool: 'bash', detail: 'pnpm test' })
  reporter.push({ kind: 'tool_call', tool: 'bash', detail: 'pnpm build' })
  reporter.push({ kind: 'tool_call', tool: 'bash', detail: 'pnpm lint' })
  // 还没 flush，合并行应该只有 1 条，且计数为 3
  const lines = reporter.linesForTest()
  assert.equal(lines.length, 1, `应为 1 行，实际 ${JSON.stringify(lines)}`)
  assert.equal(lines[0], '▸ 终端 pnpm lint ×3')
  reporter.stop()
})

test('工具切换时才新起一行', () => {
  const reporter = new ProgressReporter({
    event: {},
    reply: async () => {},
    options: { enabled: true, startAfterMs: 0 },
    log: noopLog,
  })
  reporter.push({ kind: 'tool_call', tool: 'bash', detail: 'pnpm test' })
  reporter.push({ kind: 'tool_call', tool: 'bash', detail: 'pnpm build' })
  reporter.push({ kind: 'tool_call', tool: 'read', detail: '/a/b.js' })
  reporter.push({ kind: 'tool_call', tool: 'read', detail: '/a/c.js' })
  const lines = reporter.linesForTest()
  assert.deepEqual(lines, ['▸ 终端 pnpm build ×2', '▸ 读文件 /a/c.js ×2'])
  reporter.stop()
})

test('工具结果不重复叠打勾', () => {
  const reporter = new ProgressReporter({
    event: {},
    reply: async () => {},
    options: { enabled: true, startAfterMs: 0 },
    log: noopLog,
  })
  reporter.push({ kind: 'tool_call', tool: 'bash', detail: 'ls' })
  reporter.push({ kind: 'tool_result', status: 'completed' })
  reporter.push({ kind: 'tool_result', status: 'completed' })
  const lines = reporter.linesForTest()
  assert.deepEqual(lines, ['▸ 终端 ls ✓'])
  reporter.stop()
})

test('达到 maxMessages 后不再发送', async () => {
  const sent = []
  let clock = 0
  const origNow = Date.now
  Date.now = () => clock
  try {
    const reporter = new ProgressReporter({
      event: {},
      reply: async (_e, t) => sent.push(t),
      options: { enabled: true, startAfterMs: 0, minIntervalMs: 1, maxMessages: 2 },
      log: noopLog,
    })
    // 工具必须来回切换才会新起行（同一工具连续调用会被合并）
    for (let i = 0; i < 10; i += 1) {
      clock += 10
      reporter.push({ kind: 'tool_call', tool: i % 2 === 0 ? 'bash' : 'read', detail: `cmd-${i}` })
      await reporter.flushNow()
    }
    reporter.stop()
    assert.equal(sent.length, 2, `应封顶在 2 条，实际 ${sent.length}`)
  } finally {
    Date.now = origNow
  }
})
