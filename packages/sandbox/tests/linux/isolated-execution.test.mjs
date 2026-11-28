import assert from 'node:assert/strict'
import { mkdtemp, open, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runBubblewrapCommand } from '../../dist/linux/bubblewrap/command.js'
import { createBubblewrapPtyBridge } from '../../dist/linux/bubblewrap/pty.js'

const rootfs = process.env.GUGU_BUBBLEWRAP_TEST_ROOTFS
const disabled = process.platform !== 'linux' || !rootfs

async function fixture(work) {
  const paths = await Promise.all(['workspace', 'project', 'other'].map(name => mkdtemp(join(tmpdir(), `sandbox-${name}-`))))
  try {
    const [workspace, project, other] = paths
    await writeFile(join(project, 'sample'), 'project')
    await writeFile(join(other, 'sample'), 'different owner')
    const handles = await Promise.all([open(workspace), open(project)])
    try {
      await work({ workspace, project, other, mounts: [
        { source: workspace, descriptor: handles[0].fd, target: '/workspace', readonly: false },
        { source: project, descriptor: handles[1].fd, target: '/project', readonly: true },
      ] })
    } finally { await Promise.all(handles.map(handle => handle.close())) }
  } finally { await Promise.all(paths.map(path => rm(path, { recursive: true, force: true }))) }
}

test('真实 Linux 命令拥有独立目录视图、网络命名空间与有界执行时间', { skip: disabled }, async () => {
  await fixture(async ({ workspace, other, mounts }) => {
    const run = (command, timeoutMs = 3000) => runBubblewrapCommand(
      { rootfs, mounts, cwd: '/workspace', command },
      { timeoutMs, outputBytes: 4096, resourceScope: true },
    )
    const result = await run([
      'set -eu', 'test "$PWD" = /workspace', 'test -f /etc/gugu-sandbox-release',
      'test ! -e /proc/self/fd/3', 'test ! -e /proc/self/fd/4', 'test -r /project/sample',
      `test ! -e '${join(other, 'sample')}'`, 'if (echo x > /project/sample) 2>/dev/null; then exit 12; fi',
      'echo workspace > result', 'readlink /proc/self/ns/net',
    ].join('; '))
    assert.equal(result.ok, true)
    assert.notEqual(result.stdout.trim(), await readlink('/proc/self/ns/net'))
    assert.equal(await readFile(join(workspace, 'result'), 'utf8'), 'workspace\n')
    assert.equal((await run('while :; do :; done', 150)).timedOut, true)
  })
})

test('真实 Linux PTY 传递目录句柄、输入与窗口尺寸，并在关闭后回收 scope', { skip: disabled }, async () => {
  await fixture(async ({ workspace, mounts }) => {
    const pty = await createBubblewrapPtyBridge(rootfs).open({
      terminalId: 'sandbox-test', sandboxCwd: '/workspace', sandboxMounts: mounts,
      rows: 24, cols: 80, networkProfile: 'none', timeoutMs: 6000,
    })
    let cgroup
    try {
      const seen = (async () => {
        let tail = ''
        const output = pty.output()[Symbol.asyncIterator]()
        for (;;) {
          const chunk = await output.next()
          if (chunk.done) return false
          tail = (tail + Buffer.from(chunk.value).toString('utf8')).slice(-4096)
          if (tail.includes('GUGU_PTY_OK')) return true
        }
      })()
      await pty.resize(102, 40)
      await pty.write(Buffer.from([
        'test -t 0', 'test ! -e /proc/self/fd/4', 'test ! -e /proc/self/fd/5',
        'test -r /project/sample', '! (echo x > /project/sample)', 'stty size > result',
        "printf '%s%s\\n' GUGU_ PTY_OK",
      ].join(' && ') + '\n'))
      assert.equal(await seen, true)
      assert.equal(await readFile(join(workspace, 'result'), 'utf8'), '40 102\n')
      const path = (await readFile(`/proc/${pty.pid}/cgroup`, 'utf8')).trim().split('::')[1]
      assert.match(path, /\.scope$/)
      cgroup = join('/sys/fs/cgroup', path)
      const limit = async name => (await readFile(join(cgroup, name), 'utf8')).trim()
      assert.equal(await limit('pids.max'), '64')
      assert.equal(await limit('memory.max'), '268435456')
      assert.equal(await limit('cpu.max'), '100000 100000')
    } finally { await pty.close() }
    for (let attempt = 0; attempt < 20; attempt++) {
      const population = await readFile(join(cgroup, 'cgroup.events'), 'utf8').catch(error => {
        if (error.code !== 'ENOENT' && error.code !== 'ENODEV') throw error
        return 'populated 0'
      })
      if (/^populated 0$/m.test(population)) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.fail('关闭 PTY 后仍有沙盒进程')
  })
})
