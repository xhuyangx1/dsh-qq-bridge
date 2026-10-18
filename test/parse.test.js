import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  segmentsToText,
  stripMention,
  cqToText,
  takePrefix,
  splitMessage,
  withDefaults,
  extractMedia,
  downloadMedia,
} from '../lib/index.js'

test('配置缺字段时补默认值（否则 maxConcurrent 为 undefined，队列永远不消费）', () => {
  const cfg = withDefaults({ allowedGroups: [100000001] })
  assert.equal(cfg.maxConcurrent, 2)
  assert.equal(cfg.timeoutSeconds, 600)
  assert.equal(cfg.maxOutputChars, 3000)
  assert.equal(cfg.progress.enabled, true)
  assert.equal(cfg.ackOnReceive, true)
  assert.equal(cfg.progress.maxMessages, 12)
  assert.equal(cfg.onebot.endpoint, 'ws://127.0.0.1:3001')
  // profileArgs 只放「app 自己的参数」；选 profile 由 command.profile 决定
  assert.deepEqual(cfg.command.profileArgs, ['--json'])
  // 用户写了的字段必须保留
  assert.deepEqual(cfg.allowedGroups, [100000001])
  // 局部覆盖不能把同层其他字段抹掉
  const partial = withDefaults({ progress: { minIntervalMs: 15000 } })
  assert.equal(partial.progress.minIntervalMs, 15000)
  assert.equal(partial.progress.startAfterMs, 3000)
  assert.equal(partial.progress.enabled, true)
})

test('完全没配 config 也能跑', () => {
  const cfg = withDefaults()
  assert.equal(cfg.maxConcurrent, 2)
  assert.deepEqual(cfg.commandPrefixes, ['/dsh', '/DSH'])
})

test('数组段：文本 + @ 拼接并剥掉开头 @', () => {
  const message = [
    { type: 'at', data: { qq: '123456' } },
    { type: 'text', data: { text: ' 帮我跑一下测试' } },
  ]
  assert.equal(segmentsToText(message), '帮我跑一下测试')
})

test('数组段：忽略图片和表情', () => {
  const message = [
    { type: 'text', data: { text: '看这个' } },
    { type: 'image', data: { file: 'abc.jpg' } },
    { type: 'face', data: { id: '1' } },
  ]
  assert.equal(segmentsToText(message).trim(), '看这个')
})

test('CQ 码字符串：剥离 at 与图片，保留文字', () => {
  const raw = '[CQ:at,qq=123] /dsh 你好[CQ:image,file=a.jpg]'
  assert.equal(cqToText(raw), '  /dsh 你好 ')
})

test('CQ 码字符串经 segmentsToText 后仍能命中前缀（关键：前导空白必须去掉）', () => {
  const raw = '[CQ:at,qq=123] /dsh 帮我跑测试'
  const text = segmentsToText(raw)
  assert.equal(text, '/dsh 帮我跑测试')
  assert.equal(takePrefix(text, ['/dsh']), '帮我跑测试')
})

test('CQ 码：还原实体转义', () => {
  assert.equal(cqToText('&lt;div&gt; &#91;x&#93;'), '<div> [x]')
})

test('stripMention 去掉多个连续 @', () => {
  assert.equal(stripMention('@bot @bot2 你好'), '你好')
})

test('前缀命中与不命中', () => {
  assert.equal(takePrefix('/dsh 干活', ['/dsh']), '干活')
  assert.equal(takePrefix('/dsh', ['/dsh']), '')
  assert.equal(takePrefix('随便说说', ['/dsh']), null)
})

test('只认开头的前缀，句中不算', () => {
  assert.equal(takePrefix('请用 /dsh 干活', ['/dsh']), null)
})

test('短消息不切分', () => {
  assert.deepEqual(splitMessage('hello', 100), ['hello'])
})

test('长消息按行切分且不丢内容', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line-${i}-xxxxxxxx`)
  const text = lines.join('\n')
  const chunks = splitMessage(text, 100)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(chunk.length <= 100)
  assert.equal(chunks.join('\n'), text)
})

test('无换行的超长串按长度硬切', () => {
  const text = 'x'.repeat(250)
  const chunks = splitMessage(text, 100)
  assert.deepEqual(chunks.map((c) => c.length), [100, 100, 50])
  assert.equal(chunks.join(''), text)
})

test('extractMedia 识别图片与文件', () => {
  const msg = [
    { type: 'text', data: { text: '看看这个' } },
    { type: 'image', data: { file: 'a.jpg', url: 'https://x/a.jpg' } },
    { type: 'file', data: { name: 'report.pdf', file_id: 'f1', url: 'https://x/r.pdf' } },
  ]
  const media = extractMedia(msg)
  assert.equal(media.length, 2)
  assert.equal(media[0].kind, 'image')
  assert.equal(media[0].url, 'https://x/a.jpg')
  assert.equal(media[1].kind, 'file')
  assert.equal(media[1].name, 'report.pdf')
})

test('extractMedia 忽略纯文本和表情', () => {
  const msg = [
    { type: 'text', data: { text: '你好' } },
    { type: 'face', data: { id: '1' } },
    { type: 'at', data: { qq: '123' } },
  ]
  assert.deepEqual(extractMedia(msg), [])
})

test('extractMedia 无 url 但有 file_id 的文件也认', () => {
  const msg = [{ type: 'file', data: { name: 'x.docx', file_id: 'abc' } }]
  const media = extractMedia(msg)
  assert.equal(media.length, 1)
  assert.equal(media[0].fileId, 'abc')
})

test('downloadMedia 能把 base64 落盘', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const pathMod = await import('node:path')
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'dsh-media-'))
  const payload = Buffer.from('hello-file').toString('base64')
  const got = await downloadMedia({ kind: 'file', name: 'a.txt', base64: payload }, dir)
  assert.equal(got.bytes, 10)
  assert.equal(fs.readFileSync(got.path, 'utf8'), 'hello-file')
})
