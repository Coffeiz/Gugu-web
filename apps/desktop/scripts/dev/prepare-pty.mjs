import { chmodSync, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export function prepareDesktopPty(packagePath) {
  if (process.platform !== 'darwin') return
  const require = createRequire(packagePath)
  const pty = dirname(require.resolve('node-pty/package.json'))
  const helper = join(pty, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper')
  // npm 预编译包中的助手可能没有执行位，node-pty 需要直接启动它。
  if (existsSync(helper)) {
    const mode = statSync(helper).mode & 0o777
    const executableMode = mode | ((mode & 0o444) >> 2)
    if (executableMode !== mode) chmodSync(helper, executableMode)
  }
}
