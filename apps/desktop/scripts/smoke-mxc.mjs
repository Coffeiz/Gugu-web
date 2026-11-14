// 显式启动的原生验证，只使用新建临时资料和环回测试服务。
import { getPlatformSupport, probe, run, spawn } from '@microsoft/mxc-sdk/v1'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:net'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createMxcExecutor, Executor } from '@gugu/core/executor/platform'

if (!process.argv.includes('--run')) throw new Error('请显式使用 --run 执行隔离验证')
if (process.platform !== 'win32') throw new Error('本脚本需要 Windows 原生环境')
const support = getPlatformSupport()
const facts = probe()
if (
  !support.isSupported ||
  !support.availableMethods.includes('processcontainer') ||
  facts.error ||
  facts.tier !== 'base-container' ||
  facts.needsDaclAugmentation !== false
) {
  console.log(
    JSON.stringify({
      status: 'unavailable',
      tier: facts.tier,
      needsHostPreparation: facts.needsDaclAugmentation,
    }),
  )
  process.exit(2)
}
const temporaryDirectory = resolve('.tools')
mkdirSync(temporaryDirectory, { recursive: true })
const root = mkdtempSync(join(temporaryDirectory, 'mxc-check-'))
if (dirname(root) !== temporaryDirectory) throw new Error('验证目录超出临时范围')
const input = join(root, 'input'),
  output = join(root, 'output'),
  outside = join(root, 'outside')
for (const path of [input, output, outside]) mkdirSync(path)
writeFileSync(join(input, 'input.txt'), 'gugu-synthetic-input')
writeFileSync(join(outside, 'private.txt'), 'gugu-synthetic-private')
const interpreter = join(process.env.SystemRoot, 'System32', 'cmd.exe')
const curl = join(process.env.SystemRoot, 'System32', 'curl.exe')
const base = {
  containment: { type: 'process' },
  filesystem: {
    readonlyPaths: [input, interpreter, curl, process.execPath],
    readwritePaths: [output],
  },
  network: {
    egress: { default: 'deny' },
    ingress: { default: 'deny', hostLoopback: 'deny' },
  },
  workingDirectory: input,
  environment: {
    SystemRoot: process.env.SystemRoot,
    LOCALAPPDATA: output,
    TEMP: output,
    TMP: output,
  },
  timeoutMs: 10_000,
}
const options = { telemetry: { enabled: false } }
const executor = new Executor([await createMxcExecutor()])
const execute = (command, extra = {}) => {
  // UI 对照仅为显式诊断；正式 Adapter 始终使用严格 UI/网络策略。
  if (extra.ui) return run({ ...base, command, ...extra }, options)
  const id = randomUUID(),
    timeoutMs = extra.timeoutMs ?? base.timeoutMs
  return executor.execute(
    { id, command, cwd: input, timeoutMs, destructive: true },
    {
      requestId: id,
      backend: 'mxc',
      command,
      cwd: input,
      confirmed: true,
      readonlyPaths: base.filesystem.readonlyPaths,
      readwritePaths: base.filesystem.readwritePaths,
      environment: base.environment,
      timeoutMs,
      maxOutputBytes: 65_536,
    },
  )
}
const report = { tier: facts.tier, checks: [] }
let stage = 'allowed-write'
let listener
try {
  const allowed = await execute(
    `"${interpreter}" /d /c type input.txt > "${join(output, 'result.txt')}"`,
  )
  assert.equal(allowed.exitCode, 0)
  assert.equal(readFileSync(join(output, 'result.txt'), 'utf8'), 'gugu-synthetic-input')
  report.checks.push(stage)

  stage = 'readonly-write-denied'
  const denied = await execute(
    `"${interpreter}" /d /c echo blocked > "${join(input, 'blocked.txt')}"`,
  )
  assert.notEqual(denied.exitCode, 0)
  assert.equal(existsSync(join(input, 'blocked.txt')), false)
  report.checks.push(stage)

  stage = 'outside-read-denied'
  const outsideRead = await execute(
    `"${interpreter}" /d /c type "${join(outside, 'private.txt')}"`,
  )
  assert.notEqual(outsideRead.exitCode, 0)
  assert.equal(outsideRead.stdout.includes('gugu-synthetic-private'), false)
  report.checks.push(stage)

  stage = 'network-denied'
  const nodeCompatibility = await execute(
    `"${process.execPath}" -e "process.stdout.write('started')"`,
  )
  report.nodeWorkload = {
    compatible: nodeCompatibility.stdout === 'started',
    exitCode: nodeCompatibility.exitCode,
  }
  if (process.argv.includes('--compare-ui')) {
    const control = await execute(
      `"${process.execPath}" -e "process.stdout.write('started')"`,
      {
        ui: { disable: false, clipboard: 'none', injection: false },
      },
    )
    report.nodeUiControl = {
      compatible: control.stdout === 'started',
      exitCode: control.exitCode,
    }
  }
  const curlControl = await execute(`"${curl}" -q --version`)
  assert.equal(curlControl.exitCode, 0)
  assert.equal(curlControl.stdout.startsWith('curl '), true)
  let accepted = 0
  listener = createServer((socket) => {
    accepted++
    socket.end()
  })
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  const network = await execute(
    `"${curl}" -q --noproxy "*" --connect-timeout 1 --max-time 2 --silent --show-error http://127.0.0.1:${port}/`,
  )
  report.network = {
    exitCode: network.exitCode,
    timedOut: network.timedOut,
    accepted,
  }
  assert.notEqual(network.exitCode, 0)
  assert.equal(network.timedOut, false)
  assert.equal(accepted, 0)
  report.checks.push(stage)

  stage = 'timeout-reaps-process'
  const busy = `"${interpreter}" /d /q /c "echo started&for /L %i in (1,0,2) do @rem"`
  const timed = await execute(busy, { timeoutMs: 1500 })
  assert.equal(timed.stdout.trim(), 'started')
  assert.equal(timed.timedOut, true)
  report.checks.push(stage)

  stage = 'explicit-kill-reaps-process'
  const child = await spawn({ ...base, command: busy }, options)
  try {
    const stream = child.standardOutput
    const started = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('验证进程启动超时')), 5000)
      stream.once('data', (chunk) => {
        clearTimeout(timeout)
        resolve(chunk.toString())
      })
    })
    assert.equal(started.trim(), 'started')
    child.kill()
    await child.wait()
    assert.throws(() => process.kill(child.id, 0))
  } finally {
    child.dispose()
  }
  report.checks.push(stage)
  console.log(JSON.stringify({ status: 'passed', ...report }, null, 2))
} catch (error) {
  console.log(
    JSON.stringify(
      { status: 'failed', stage, code: error.code ?? error.name, ...report },
      null,
      2,
    ),
  )
  process.exitCode = 1
} finally {
  if (listener) await new Promise((resolve) => listener.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
