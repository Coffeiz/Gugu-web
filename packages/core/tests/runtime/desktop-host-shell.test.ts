import { expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { executeDesktopHostShell } from '../../src/runtime/desktop-host-shell.js'

it.skipIf(process.platform !== 'win32')('Windows 中文与管道原样执行，不经 cmd 拆分', async () => {
  const result = await executeDesktopHostShell("'中文输出'; @('甲', '乙') | ForEach-Object { $_ + '完成' }", tmpdir(), 10, 2000, new AbortController().signal)
  expect(result.ok).toBe(true)
  expect(result.stdout).toContain('中文输出')
  expect(result.stdout).toContain('甲完成')
  expect(result.stdout).toContain('乙完成')
  expect(result.stderr).not.toContain('�')
})

it.skipIf(process.platform !== 'win32')('Windows 原生命令不存在时错误文字可读', async () => {
  const result = await executeDesktopHostShell('cmd /d /c nonexistent_synthetic_command', tmpdir(), 10, 2000, new AbortController().signal)
  expect(result.ok).toBe(false)
  expect(result.stderr).toContain('nonexistent_synthetic_command')
  expect(result.stderr).not.toContain('�')
})

it.skipIf(process.platform !== 'win32')('语法错误发生在脚本解析期也使用 UTF-8', async () => {
  const result = await executeDesktopHostShell('whoami & hostname', tmpdir(), 10, 4000, new AbortController().signal)
  expect(result.ok).toBe(false)
  expect(result.stderr).not.toContain('�')
  expect(result.stderr).toContain('ParseException')
})
