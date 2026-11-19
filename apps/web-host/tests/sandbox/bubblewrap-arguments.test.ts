import assert from 'node:assert/strict'
import test from 'node:test'
import { bubblewrapArguments } from '@gugu/sandbox/linux/bubblewrap'

const request = {
  rootfs: '/sandbox-root', cwd: '/workspace/current', command: 'pwd',
  mounts: [{ source: '/trusted/project', target: '/workspace/current', readonly: false }],
}

test('沙盒使用独立只读根与明确的工作区目标，并将命令作为独立参数传递', () => {
  const args = bubblewrapArguments(request)
  assert.deepEqual(args.slice(0, 6), ['--unshare-all', '--die-with-parent', '--new-session', '--ro-bind', '/sandbox-root', '/'])
  assert.ok(args.includes('/workspace/current'))
  assert.deepEqual(args.slice(-4), ['--', '/bin/sh', '-c', 'pwd'])
})

test('拒绝挂载覆盖系统目录、路径穿越和未授权工作目录', () => {
  for (const target of ['/etc', '/workspace/../etc', '/workspace-other'])
    assert.throws(() => bubblewrapArguments({ ...request, mounts: [{ ...request.mounts[0]!, target }] }))
  assert.throws(() => bubblewrapArguments({ ...request, cwd: '/project/other' }))
  assert.throws(() => bubblewrapArguments({ ...request, rootfs: '/' }))
})

test('嵌套只读目录在父目录之后挂载，不能被父目录覆盖', () => {
  const args = bubblewrapArguments({ ...request, mounts: [
    { source: '/trusted/private', target: '/workspace/current/private', readonly: true },
    ...request.mounts,
  ] })
  const parent = args.indexOf('/trusted/project')
  const child = args.indexOf('/trusted/private')
  assert.ok(parent < child)
  assert.equal(args[child - 1], '--ro-bind')
})
