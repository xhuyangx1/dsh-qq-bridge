
/**
 * NapCat 进程控制 —— 让设置页能一键启停机器人，不用去点桌面快捷方式。
 *
 * ## 为什么要这个
 *
 * 桌面快捷方式在某些环境下点不开（窗口不弹、中文路径被 cmd 拆断等）。
 * 把启停搬进 DSH 设置页，就绕开了整套 shell/编码问题。
 *
 * ## 三种状态
 *
 *   running  : NapCat 进程在、OneBot 端口在 → 一切正常
 *   starting : 刚拉起，等端口
 *   stopped  : 没在跑
 *
 * ## 启动方式（踩过的坑）
 *
 * 必须用**计划任务**或完全脱离父进程的方式启动，否则 DSH 一重启
 * NapCat 就跟着死。这里用 schtasks 注册一次性任务，跑完即删。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 判断 TCP 端口是否在监听（Windows 用 netstat，避免引 net 模块的复杂度）。 */
export function portListening (port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    })
    const needle = ':' + port
    return out.split(/\r?\n/).some((line) => line.includes('LISTENING') && line.includes(needle))
  } catch {
    return false
  }
}

/** 当前是否已有 NapCat 进程。 */
export function napcatRunning () {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq NapCatWinBootMain.exe', '/NH'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    })
    return out.includes('NapCatWinBootMain.exe')
  } catch {
    return false
  }
}

export class NapCatController {
  #dir
  #port
  #log
  #lastStartAttempt = 0

  constructor ({ dir, port, log }) {
    this.#dir = dir
    this.#port = port
    this.#log = log
  }

  status () {
    const proc = napcatRunning()
    const port = portListening(this.#port)
    return {
      process: proc,
      port,
      state: proc && port ? 'running' : (proc ? 'starting' : 'stopped'),
    }
  }

  /** 用计划任务拉起，彻底脱离当前进程树。 */
  start () {
    const st = this.status()
    if (st.state === 'running') return { ok: true, message: '已经在运行' }

    // 防止连点：10 秒内不重复拉
    const now = Date.now()
    if (now - this.#lastStartAttempt < 10_000) {
      return { ok: false, message: '刚刚已经尝试启动，请稍候再看状态' }
    }
    this.#lastStartAttempt = now

    const startCmd = join(this.#dir, 'start.cmd')
    if (!existsSync(startCmd)) {
      return { ok: false, message: '找不到启动脚本：' + startCmd }
    }

    try {
      const taskName = 'DSH-NapCat-' + now

      const logFile = join(this.#dir, 'napcat.log')
      const runnerBat = join(this.#dir, '_run-hidden.cmd')

      // 用一层的中间批处理做三件事：切目录、把输出重定向到日志文件、
      // 再用 wscript 把真正的 start.cmd 以**隐藏窗口**拉起。
      //
      // 为什么不用复杂的 VBS 内联：引号要嵌套四层，实测 cmd 会拆断。
      // 写文件比拼命令行可靠得多。
      const batLines = [
        '@echo off',
        'cd /d "%~dp0"',
        'start "" /b wscript.exe //nologo "%~dp0_hidden.vbs"',
      ].join('\r\n')
      writeFileSync(runnerBat, batLines, 'utf8')

      const vbsLines = [
        'Set sh = CreateObject("WScript.Shell")',
        'sh.CurrentDirectory = "' + this.#dir + '"',
        'sh.Run "cmd.exe /c start.cmd > napcat.log 2>&1", 0, False',
      ].join('\r\n')
      writeFileSync(join(this.#dir, '_hidden.vbs'), vbsLines, 'utf8')

      // 计划任务：/ST 必须晚于当前时间，否则报「已过时间，任务无法运行」
      const startAt = new Date(now + 60_000)
      const hhmm = String(startAt.getHours()).padStart(2, '0') + ':' + String(startAt.getMinutes()).padStart(2, '0')

      execFileSync('schtasks', [
        '/Create', '/TN', taskName,
        '/TR', '"' + runnerBat + '"',
        '/SC', 'ONCE', '/ST', hhmm, '/F',
      ], { encoding: 'utf8', timeout: 15_000, windowsHide: true })

      execFileSync('schtasks', ['/Run', '/TN', taskName], {
        encoding: 'utf8', timeout: 15_000, windowsHide: true,
      })

      // 清理任务（延迟删，避免打断正在跑的）
      setTimeout(() => {
        try {
          execFileSync('schtasks', ['/Delete', '/TN', taskName, '/F'], {
            timeout: 10_000, windowsHide: true,
          })
        } catch {}
      }, 120_000).unref?.()

      this.#log('已通过计划任务拉起 NapCat（任务名 ' + taskName + '）')
      return { ok: true, message: '正在启动，约 20-40 秒后看状态' }
    } catch (error) {
      this.#log('拉起 NapCat 失败：' + (error?.message ?? error))
      return { ok: false, message: '启动失败：' + (error?.message ?? error) }
    }
  }

  /**
   * 读 NapCat 自己的控制台输出。
   *
   * 启动时已经把 stdout/stderr 重定向到 <dir>/napcat.log，
   * 设置页直接读这个文件就能显示，不用再弹黑窗口。
   */
  readLog (limit = 200) {
    try {
      const f = join(this.#dir, 'napcat.log')
      if (!existsSync(f)) return []
      const text = readFileSync(f, 'utf8')
      const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
      return lines.slice(-limit)
    } catch {
      return []
    }
  }

  /** 清空日志文件（设置页「清空」按钮用）。 */
  clearLog () {
    try {
      const f = join(this.#dir, 'napcat.log')
      if (existsSync(f)) writeFileSync(f, '')
      return true
    } catch { return false }
  }

  /** 停掉 NapCat（连带 QQ，因为它是注入进 QQ 的）。 */
  stop () {
    try {
      execFileSync('taskkill', ['/F', '/IM', 'NapCatWinBootMain.exe'], {
        timeout: 10_000, windowsHide: true,
      })
    } catch {}
    try {
      execFileSync('taskkill', ['/F', '/IM', 'QQ.exe'], {
        timeout: 10_000, windowsHide: true,
      })
    } catch {}
    this.#log('已停止 NapCat 与 QQ')
    return { ok: true, message: '已停止' }
  }
}
