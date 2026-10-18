
/**
 * QQ 桥设置页 —— 在 DSH 设置里直接启停机器人、看状态、看日志。
 *
 * ## 为什么做成设置页
 *
 * 桌面快捷方式在中文路径 / 无窗口环境下经常点不开（cmd 会按 GBK 拆断
 * UTF-8 路径）。把启停放进 DSH 设置页，就完全绕开了 shell 层。
 *
 * ## 加载协议
 *
 * DSH 的客户端插件由 `window.__ModuleLoader__.load({ id, factory })` 注册，
 * factory 里 `require('react')` 拿到 React，导出 { name, inject, apply }。
 * 设置页通过 `ctx.slots.register({ name: 'settings.section', ... })` 挂上去。
 *
 * ## 与宿主的通信
 *
 * 走 `connection.rpc.call('/api', 'qq-bridge', { method, payload })`，
 * 对应宿主侧的 connection.fetch.register('/api/qq-bridge')。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-bridge',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const name = 'dsh-qq-bridge-client'
    const inject = ['slots', 'connection']

    const STYLES = `
      .qqb-page { display: flex; flex-direction: column; gap: 18px; padding: 4px 0 24px; }
      .qqb-card { border: 1px solid rgba(127,127,127,.22); border-radius: 10px; padding: 16px 18px; }
      .qqb-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .qqb-title { font-size: 14px; font-weight: 600; }
      .qqb-sub { font-size: 12px; opacity: .6; margin-top: 3px; }
      .qqb-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; margin-right: 7px; }
      .qqb-on { background: #2ecc71; }
      .qqb-off { background: #95a5a6; }
      .qqb-wait { background: #f39c12; }
      .qqb-btn { border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit;
                 border-radius: 7px; padding: 7px 16px; font-size: 13px; cursor: pointer; }
      .qqb-btn:hover:not(:disabled) { background: rgba(127,127,127,.12); }
      .qqb-btn:disabled { opacity: .45; cursor: default; }
      .qqb-primary { background: #3b82f6; border-color: #3b82f6; color: #fff; }
      .qqb-primary:hover:not(:disabled) { background: #2563eb; }
      .qqb-danger { border-color: #ef4444; color: #ef4444; }
      .qqb-kv { display: grid; grid-template-columns: 110px 1fr; gap: 7px 12px; font-size: 13px; }
      .qqb-kv dt { opacity: .55; }
      .qqb-kv dd { margin: 0; word-break: break-all; }
      .qqb-log { background: rgba(0,0,0,.28); border-radius: 8px; padding: 12px;
                 font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.65;
                 max-height: 340px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
      .qqb-log-line { display: flex; gap: 10px; }
      .qqb-log-time { opacity: .38; flex: 0 0 auto; }
      .qqb-msg { font-size: 12px; margin-top: 8px; }
      .qqb-msg-ok { color: #2ecc71; }
      .qqb-msg-err { color: #ef4444; }
    `

    function installStyles () {
      if (document.getElementById('qqb-styles')) return
      const el = document.createElement('style')
      el.id = 'qqb-styles'
      el.textContent = STYLES
      document.head.appendChild(el)
    }

    const STATE_LABEL = { running: '运行中', starting: '启动中', stopped: '未启动' }
    const STATE_CLASS = { running: 'qqb-on', starting: 'qqb-wait', stopped: 'qqb-off' }

    function fmtTime (ms) {
      const d = new Date(ms)
      const p = (n) => String(n).padStart(2, '0')
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    }

    function QQPage ({ rpcCall }) {
      const [status, setStatus] = useState(null)
      const [logs, setLogs] = useState([])
      const [napcatLog, setNapcatLog] = useState([])
      const [tab, setTab] = useState('app')
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)
      const [auto, setAuto] = useState(true)
      const logRef = useRef(null)

      const refresh = useCallback(async () => {
        try {
          const s = await rpcCall('status', {})
          setStatus(s)
          const l = await rpcCall('logs', { limit: 200 })
          if (Array.isArray(l)) {
            setLogs(l)
          } else {
            setLogs(Array.isArray(l?.app) ? l.app : [])
            setNapcatLog(Array.isArray(l?.napcat) ? l.napcat : [])
          }
        } catch (error) {
          setMessage({ kind: 'err', text: '读取状态失败：' + (error?.message ?? error) })
        }
      }, [rpcCall])

      useEffect(() => {
        void refresh()
      }, [refresh])

      useEffect(() => {
        if (!auto) return
        const t = setInterval(() => { void refresh() }, 3000)
        return () => clearInterval(t)
      }, [auto, refresh])

      useEffect(() => {
        const el = logRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, [logs])

      const act = async (method, okText) => {
        setBusy(true)
        setMessage(null)
        try {
          const r = await rpcCall(method, {})
          setMessage({ kind: r?.ok === false ? 'err' : 'ok', text: r?.message ?? okText })
          await refresh()
        } catch (error) {
          setMessage({ kind: 'err', text: '操作失败：' + (error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }

      const st = status?.state ?? 'stopped'

      return h('div', { className: 'qqb-page' },
        // ---- 状态卡片 ----
        h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-row' },
            h('div', null,
              h('div', { className: 'qqb-title' },
                h('span', { className: 'qqb-dot ' + (STATE_CLASS[st] ?? 'qqb-off') }),
                'QQ 机器人 · ' + (STATE_LABEL[st] ?? st),
              ),
              h('div', { className: 'qqb-sub' },
                status
                  ? 'OneBot ' + (status.onebot ? '已连接' : '未连接') +
                    ' · 端口 ' + (status.port ? '就绪' : '未就绪') +
                    ' · 队列 ' + status.queue + ' · 执行中 ' + status.active
                  : '正在读取…',
              ),
            ),
            h('div', { style: { display: 'flex', gap: 10 } },
              h('button', {
                className: 'qqb-btn qqb-primary',
                disabled: busy || st === 'running',
                onClick: () => act('start', '已发出启动指令'),
              }, st === 'starting' ? '启动中…' : '启动机器人'),
              h('button', {
                className: 'qqb-btn qqb-danger',
                disabled: busy || st === 'stopped',
                onClick: () => act('stop', '已停止'),
              }, '停止'),
            ),
          ),
          message && h('div', {
            className: 'qqb-msg ' + (message.kind === 'ok' ? 'qqb-msg-ok' : 'qqb-msg-err'),
          }, message.text),
        ),

        // ---- 运行信息 ----
        status && h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-title', style: { marginBottom: 12 } }, '运行信息'),
          h('dl', { className: 'qqb-kv' },
            h('dt', null, '执行后端'),
            h('dd', null, status.backend),
            h('dt', null, '工作目录'),
            h('dd', null, status.cwd),
            h('dt', null, '允许的群'),
            h('dd', null, status.allowedGroups?.length ? status.allowedGroups.join(', ') : '（未限制）'),
            h('dt', null, '允许的用户'),
            h('dd', null, status.allowedUsers?.length ? status.allowedUsers.join(', ') : '（未限制）'),
          ),
        ),

        // ---- 日志 ----
        h('div', { className: 'qqb-card' },
          h('div', { className: 'qqb-row', style: { marginBottom: 12 } },
            h('div', null,
              h('div', { className: 'qqb-title' }, '运行日志'),
              h('div', { className: 'qqb-sub' },
                (tab === 'app' ? logs.length + ' 条插件日志' : napcatLog.length + ' 行 NapCat 输出') + ' · 每 3 秒刷新'),
            ),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h('button', {
                className: 'qqb-btn' + (tab === 'app' ? ' qqb-primary' : ''),
                style: { padding: '4px 11px', fontSize: 12 },
                onClick: () => setTab('app'),
              }, '插件'),
              h('button', {
                className: 'qqb-btn' + (tab === 'napcat' ? ' qqb-primary' : ''),
                style: { padding: '4px 11px', fontSize: 12 },
                onClick: () => setTab('napcat'),
              }, 'NapCat'),
              h('button', {
                className: 'qqb-btn',
                style: { padding: '4px 11px', fontSize: 12 },
                onClick: async () => {
                  try { await rpcCall('clearNapcatLog', {}) ; await refresh() } catch {}
                },
              }, '清空'),
              h('label', { style: { fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginLeft: 4 } },
                h('input', {
                  type: 'checkbox',
                  checked: auto,
                  onChange: (e) => setAuto(e.target.checked),
                }),
                '自动刷新',
              ),
            ),
          ),
          h('div', { className: 'qqb-log', ref: logRef },
            tab === 'app'
              ? (logs.length === 0
                  ? h('div', { style: { opacity: .45 } }, '（暂无日志）')
                  : logs.map((l, i) => h('div', { className: 'qqb-log-line', key: i },
                      h('span', { className: 'qqb-log-time' }, fmtTime(l.at)),
                      h('span', null, l.text),
                    )))
              : (napcatLog.length === 0
                  ? h('div', { style: { opacity: .45 } }, '（NapCat 还没有输出，或日志文件为空）')
                  : napcatLog.map((line, i) => h('div', { className: 'qqb-log-line', key: i },
                      h('span', null, line),
                    ))),
          ),
        ),
      )
    }

    function apply (ctx) {
      ctx.effect(() => {
        installStyles()
        return () => {}
      }, 'qq-bridge-client: styles')

      const rpcCall = async (method, payload) => {
        const raw = await ctx.connection.rpc.call('/api', 'qq-bridge', { method, payload })
        if (raw?.ok === true) return raw.value
        if (raw?.ok === false) throw new Error(raw.error?.message || 'QQ 桥 API 失败')
        return raw
      }

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'qq-bridge',
        order: 55,
        label: () => 'QQ 桥',
        inject: () => ({ rpcCall }),
      }, QQPage))
    }

    return { name, inject, apply }
  },
})
