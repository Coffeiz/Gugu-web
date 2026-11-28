import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { test } from 'node:test'

test('热重启先完成安装和编译，失败期间保留原 Host', { skip: process.platform === 'win32', timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-dev-restart-'))
  const host = join(root, 'apps/web-host')
  const entry = join(host, 'scripts/dev.mjs')
  const events = join(root, 'events')
  const fixture = async (path: string, content: string, mode?: number) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, { mode })
  }
  let supervisor: ReturnType<typeof spawn> | undefined
  try {
    await fixture(entry, await readFile(new URL('../../scripts/dev.mjs', import.meta.url), 'utf8'))
    await fixture(events, '')
    await fixture(join(root, 'pnpm-lock.yaml'), '{}')
    await fixture(join(root, 'bin/corepack'), '#!/bin/sh\necho install >> "$GUGU_TEST_EVENTS"\ncase "$(cat pnpm-lock.yaml)" in invalid) exit 1;; esac\n', 0o755)
    await fixture(join(root, 'packages/charts/scripts/build.mjs'), '')
    await fixture(join(root, 'packages/core/scripts/build-skills.mjs'), '')
    await fixture(join(root, 'packages/core/src/entry.ts'), '')
    await fixture(join(host, 'node_modules/tsx/package.json'), '{"type":"module","exports":"./index.js"}')
    await fixture(join(host, 'node_modules/tsx/index.js'), '')
    await fixture(join(host, 'node_modules/typescript/bin/tsc'), `
      const { appendFileSync, readFileSync } = require('node:fs')
      const { basename, join } = require('node:path')
      const project = process.argv[3]
      appendFileSync(process.env.GUGU_TEST_EVENTS, basename(project) + '\\n')
      if (basename(project) === 'core' && readFileSync(join(project, 'src/entry.ts'), 'utf8') === 'invalid') process.exit(1)
    `)
    await fixture(join(host, 'src/main.ts'), `
      import { appendFileSync } from 'node:fs'
      const file = process.env.GUGU_TEST_EVENTS
      if (process.argv[1]?.endsWith('/src/main.ts')) {
        process.on('SIGTERM', () => { appendFileSync(file, 'stop\\n'); process.exit(0) })
        appendFileSync(file, 'start\\n')
        setInterval(() => {}, 1000)
      } else appendFileSync(file, 'import\\n')
    `)
    let output = ''
    supervisor = spawn(process.execPath, [entry], {
      env: { ...process.env, GUGU_TEST_EVENTS: events, PATH: join(root, 'bin') + ':' + process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    supervisor.stdout?.on('data', chunk => { output += chunk })
    supervisor.stderr?.on('data', chunk => { output += chunk })
    const trace = () => readFile(events, 'utf8')
    async function waitFor(predicate: (current: string) => boolean) {
      const deadline = Date.now() + 6000
      while (Date.now() < deadline) {
        const current = await trace()
        if (predicate(current)) return current
        await delay(30)
      }
      assert.fail('监听未达到预期状态：' + output)
    }
    const compiled = 'sandbox\ndatabase\nfs\ncore\ngateway\ntsconfig.build.json\nimport\n'
    assert.equal(await waitFor(current => current.endsWith('start\n')), 'install\n' + compiled + 'start\n')

    await writeFile(join(root, 'pnpm-lock.yaml'), 'invalid')
    await waitFor(() => output.includes('开发依赖安装失败'))
    assert.equal(await trace(), 'install\n' + compiled + 'start\ninstall\n')

    await writeFile(join(root, 'packages/core/src/entry.ts'), 'invalid')
    await writeFile(join(root, 'pnpm-lock.yaml'), '{}')
    await waitFor(() => output.includes('core 编译失败'))
    assert.equal(await trace(), 'install\n' + compiled + 'start\ninstall\ninstall\nsandbox\ndatabase\nfs\ncore\n')

    await writeFile(join(root, 'packages/core/src/entry.ts'), 'export {}')
    const restarted = await waitFor(current => current.endsWith('stop\nstart\n'))
    assert.ok(restarted.endsWith(compiled + 'stop\nstart\n'))
  } finally {
    if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
      const exited = once(supervisor, 'exit')
      supervisor.kill('SIGTERM')
      await exited
    }
    await rm(root, { recursive: true, force: true })
  }
})
