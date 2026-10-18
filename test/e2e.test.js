/**
 * 端到端自测：假 OneBot 服务端 + 假 dsh，验证
 *   群消息 → 前缀解析 → headless 执行 → 分片回群
 * 不需要真实 QQ、不需要模型密钥。
 */
import { createServer } from 'node:http'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ws 只用于测试里的假 NapCat 服务端；插件本身零依赖
let WebSocketServer
try {
  ({ WebSocketServer } = await import('ws'))
} catch {
  console.log('SKIP  e2e 需要 `pnpm add -D ws`（仅测试用，插件本身不需要）')
  process.exit(0)
}
import { apply } from '../lib/index.js'

const PORT = 3999

/**
 * 假 dsh：读 stdin 的 prompt，吐 NDJSON，final 里回显。
 * 刻意用数组 + join 拼源码，避免模板字符串里再嵌转义，把换行写坏。
 */
const dir = mkdtempSync(join(tmpdir(), 'fake-dsh-'))
const fakeDsh = join(dir, 'dsh.js')
const fakeSource = [
  "#!/usr/bin/env node",
  "const chunks = []",
  "process.stdin.on('data', (c) => chunks.push(c))",
  "process.stdin.on('end', () => {",
  "  const prompt = Buffer.concat(chunks).toString('utf8')",
  "  const sessionId = process.env.FAKE_SESSION_ID || 'session-fake-0001'",
  "  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')",
  "  out({ type: 'session', sessionId, cwd: process.cwd() })",
  "  out({ type: 'status', phase: 'turn_start', turn: 1 })",
  "  if (prompt.includes('PROGRESS')) {",
  "    let i = 0",
  "    const timer = setInterval(() => {",
  "      i += 1",
  "      out({ type: 'status', phase: 'step_start', turn: 1, step: i })",
  "      out({ type: 'tool_call', callId: 'c' + i, tool: 'bash', input: { command: 'pnpm test --filter pkg' + i } })",
  "      out({ type: 'tool_result', callId: 'c' + i, status: 'completed', result: 'ok\\nmore' })",
  "      if (i >= 4) {",
  "        clearInterval(timer)",
  "        out({ type: 'final', text: '进度任务完成' })",
  "      }",
  "    }, 700)",
  "    return",
  "  }",
  "  if (prompt.includes('LONG')) {",
  "    out({ type: 'final', text: Array.from({ length: 40 }, (_, i) => 'row-' + i + '-' + 'z'.repeat(40)).join('\\n') })",
  "  } else if (prompt.includes('SLOW')) {",
  "    setTimeout(() => out({ type: 'final', text: 'slow-done' }), 5000)",
  "  } else if (prompt.includes('FAIL')) {",
  "    process.stderr.write('boom: something broke\\n')",
  "    process.exit(2)",
  "  } else {",
  "    out({ type: 'final', text: '你说了：' + prompt })",
  "  }",
  "})",
].join(String.fromCharCode(10))
writeFileSync(fakeDsh, fakeSource)
chmodSync(fakeDsh, 0o755)

const received = []
const wss = new WebSocketServer({ port: PORT })
let connection = null

wss.on('connection', (ws) => {
  connection = ws
  ws.on('message', (data) => {
    const payload = JSON.parse(data.toString('utf8'))
    if (payload.action === 'get_status') {
      ws.send(JSON.stringify({ retcode: 0, echo: payload.echo, data: { online: true } }))
      return
    }
    received.push(payload)
    ws.send(JSON.stringify({ retcode: 0, echo: payload.echo, data: { message_id: 1 } }))
  })
})

const fakeCtx = {
  logger: { info: () => {} },
  effect: (fn) => { fn() },
}

const config = {
  allowedGroups: ['100000001'],
  allowedUsers: [],
  perGroupSession: true,
  commandPrefixes: ['/dsh'],
  requireMention: true,
  helpOnEmpty: true,
  cwd: dir,
  timeoutSeconds: 30,
  maxOutputChars: 300,
  maxConcurrent: 2,
  progress: { enabled: true, startAfterMs: 300, minIntervalMs: 500, maxMessages: 12 },
  onebot: { endpoint: `ws://127.0.0.1:${PORT}`, accessToken: '', reconnectDelayMs: 500, maxReconnectDelayMs: 2000 },
  // profile: '' 和 mode: 'json' 是测试专用：假 dsh 不认识 --profile，
  // 而且它吐的就是 NDJSON（等价 0.1.7+ 的 --json 形态）
  // 假 dsh：bin 是 node，第一个位置参数要是脚本路径。
  // 无 profile 时 selector 会给 ['headless']，用 fakeScript 把它换成脚本路径。
  command: { bin: process.execPath, dir: '', profile: '', mode: 'json', profileArgs: ['--json'], extraArgs: [], shell: false, fakeScript: fakeDsh },
}

apply(fakeCtx, config)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let messageId = 0
const send = (overrides) => {
  messageId += 1
  connection.send(JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    group_id: 100000001,
    user_id: 10001,
    message_id: messageId,
    message: [{ type: 'text', data: { text: '/dsh 你好' } }],
    ...overrides,
  }))
}

const texts = () => received.filter((r) => r.action === 'send_msg').map((r) => r.params.message)
const waitFor = async (predicate, label, ms = 8000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (predicate()) return true
    await sleep(50)
  }
  throw new Error(`超时等待：${label}；已收到 ${JSON.stringify(texts())}`)
}

const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`)
}

await waitFor(() => connection !== null, 'OneBot 连接')

send({ message: [{ type: 'text', data: { text: '/dsh 你好' } }] })
await waitFor(() => texts().some((t) => t.includes('你说了：你好')), '普通任务回显')
check(true, '群消息 → 执行 → 回群')

send({ message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: ' /dsh 带at的任务' } }] })
await waitFor(() => texts().some((t) => t.includes('你说了：带at的任务')), '@ 后被处理')
check(true, '开头 @机器人 仍能命中前缀')

const before = texts().length
send({ group_id: 555555, message: [{ type: 'text', data: { text: '/dsh 不该被处理' } }] })
await sleep(1200)
check(texts().length === before, '非白名单群被忽略')

send({ message: [{ type: 'text', data: { text: '闲聊没有前缀' } }] })
await sleep(800)
check(!texts().some((t) => t.includes('闲聊')), '无前缀且未 @ 的消息被忽略')

send({ message: [{ type: 'text', data: { text: '/dsh' } }] })
await waitFor(() => texts().some((t) => t.includes('/dsh <任务>')), '空任务回帮助')
check(true, '空任务回复帮助')

send({ message: [{ type: 'text', data: { text: '/dsh ping' } }] })
await waitFor(() => texts().some((t) => t.startsWith('pong')), 'ping')
check(true, '/dsh ping 探活')

send({ message: [{ type: 'text', data: { text: '/dsh LONG' } }] })
await waitFor(() => texts().some((t) => t.includes('[1/')), '长回复分片')
const chunks = texts().filter((t) => /^\[\d+\/\d+\]/.test(t))
check(chunks.length > 1, '长答案被切成多条', `共 ${chunks.length} 片`)
check(chunks.every((t) => t.length <= 320), '每片不超过上限')

send({ message: [{ type: 'text', data: { text: '/dsh FAIL' } }] })
await waitFor(() => texts().some((t) => t.includes('执行未产出答案')), '失败路径')
check(true, '子进程失败时回可读错误而非堆栈')

const beforeProgress = texts().length
send({ message: [{ type: 'text', data: { text: '/dsh PROGRESS' } }] })
await waitFor(() => texts().some((t) => t.includes('进行中')), '收到进度消息')
const progressMsgs = texts().slice(beforeProgress).filter((t) => t.includes('进行中'))
check(progressMsgs.length >= 1, '执行过程中发了进度', progressMsgs.length + ' 条：' + JSON.stringify(progressMsgs[0]).slice(0, 120))
check(progressMsgs.every((t) => t.includes('▸') || t.includes('✓')), '进度含工具调用行')
await waitFor(() => texts().some((t) => t.includes('进度任务完成')), '进度任务最终答案')
check(true, '进度之后仍给出最终答案')

send({ message: [{ type: 'text', data: { text: '/dsh SLOW' } }] })
await sleep(400)
send({ message: [{ type: 'text', data: { text: '/dsh stop' } }] })
await waitFor(() => texts().some((t) => t.includes('已停止')), 'stop')
check(true, '/dsh stop 打断本群任务')
await sleep(300)
check(!texts().some((t) => t.includes('slow-done')), '被打断的任务不再回结果')

const finalSend = received.filter((r) => r.action === 'send_msg')
check(finalSend.every((r) => String(r.params.group_id) === '100000001'), '所有回复都发回原群')

await sleep(300)
wss.close()
connection?.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
