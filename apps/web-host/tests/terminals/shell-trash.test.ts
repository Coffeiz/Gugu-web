import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeBubblewrapShell } from '../../src/modules/terminals/sandbox/bubblewrap.js'
import { parseShellTrash } from '../../src/modules/terminals/shell/trash.js'
import { isIsolatedWorkspaceWrite } from '../../src/modules/terminals/shell/workspace-write.js'

test('确认后的递归 rm 将字面量目标交给回收站，且不启动子进程', async () => {
  const command = "rm -rf -- '测试 目录' -同名.txt"
  const signal = new AbortController().signal
  let moved = 0
  let closed = 0
  const mount = {
    sandboxCwd: '/workspace/default',
    sandboxMounts: [],
    async trash(input: NonNullable<ReturnType<typeof parseShellTrash>>) {
      assert.deepEqual(input, { paths: ['测试 目录', '-同名.txt'], recursive: true, force: true })
      moved += input.paths.length
      return input.paths.length
    },
    async close() { closed++ },
  }
  const input = { command, timeout: 5, maxOutputChars: 100 }
  await assert.rejects(executeBubblewrapShell('/unused', mount, input, false, signal), /未获得确认/)
  assert.equal(moved, 0)
  const result = await executeBubblewrapShell('/unused', mount, input, true, signal)
  assert.equal(result.ok, true)
  assert.equal(moved, 2)
  assert.equal(closed, 2)
})

test('无法解析的 rm 拒绝执行，普通重定向仍可写入授权目录', async () => {
  for (const command of ['rm *.txt', 'rm foo; rm bar', 'rm "$(pwd)/目标"', 'rm -i 文件']) {
    assert.equal(parseShellTrash(command), null)
    const result = await executeBubblewrapShell('/unused', {
      sandboxCwd: '/workspace/default', sandboxMounts: [], async close() {},
    }, { command, timeout: 5, maxOutputChars: 100 }, true, new AbortController().signal)
    assert.equal(result.ok, false)
  }
  const root = '/workspace/default'
  assert.equal(isIsolatedWorkspaceWrite(String.raw`printf 'line1\nline2\n' > t.txt; cat t.txt`, root, root), true)
  assert.equal(isIsolatedWorkspaceWrite('touch t.txt; rm t.txt', root, root), false)
  assert.equal(isIsolatedWorkspaceWrite('cp --remove-destination 替换.txt 原件.txt', root, root), false)
})
