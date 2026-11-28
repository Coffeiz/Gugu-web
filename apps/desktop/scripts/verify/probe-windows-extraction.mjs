import { spawn } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// 只测试解压阶段。不会启动安装器或接触现有安装目录。
const [extractor, archive, cancelAfter] = process.argv.slice(2)
if (!extractor || !archive || (cancelAfter && !/^\d+$/.test(cancelAfter))) {
  throw new Error('用法：node probe-windows-extraction.mjs <7za.exe> <归档> [取消前的毫秒数]')
}

const parent = await realpath(tmpdir())
const staging = await mkdtemp(join(parent, 'gugu-extraction-probe-'))
const started = performance.now()
let percent = 0
let files = 0
let cancelled = false
try {
  const child = spawn(resolve(extractor), [
    'x', '-y', '-bb1', '-bsp1', '-bso1', `-o${staging}`, '--', resolve(archive),
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const cancel = () => {
    if (child.kill()) cancelled = true
  }
  process.once('SIGINT', cancel)
  const timeout = cancelAfter ? setTimeout(cancel, Number(cancelAfter)) : undefined
  let pending = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    pending += chunk
    const lines = pending.split(/[\r\n\b]+/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const value = line.match(/^\s*(\d{1,3})%/)
      if (value && Number(value[1]) > percent) {
        percent = Number(value[1])
        console.log(`解压进度 ${percent}%`)
      }
      if (/^\s*- /.test(line) && ++files <= 3) console.log(`正在解压 ${line.trim().slice(2)}`)
    }
  })
  child.stderr.resume()
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('close', resolveExit)
    })
    if (!cancelled && code !== 0) throw new Error(`解压失败，退出码 ${code}`)
    console.log(JSON.stringify({ cancelled, percent, files, elapsedMs: Math.round(performance.now() - started) }))
  } finally {
    clearTimeout(timeout)
    process.removeListener('SIGINT', cancel)
  }
} finally {
  const actual = await realpath(staging)
  if (actual !== staging || dirname(actual) !== parent) throw new Error('临时解压路径不匹配')
  await rm(actual, { recursive: true, force: true })
}
