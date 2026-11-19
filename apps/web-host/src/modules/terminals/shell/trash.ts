export const shellTrashPrefix = /^rm(?=[ \t]|$)[ \t]*/u

export interface ShellTrashCommand {
  paths: string[]
  recursive: boolean
  force: boolean
}

/** 只接受一条字面量 rm 命令。Shell 展开、拼接和重定向均交给只读执行边界。 */
export function parseShellTrash(command: string): ShellTrashCommand | null {
  const input = command.trim()
  const prefix = shellTrashPrefix.exec(input)
  if (!prefix) return null
  const rest = input.slice(prefix[0].length)
  const tokens = /(?:^|[ \t]+)(?:'([^'\r\n]+)'|"([^"\\$`\r\n]+)"|([^\s'"\\$`;&|<>()*?\[\]{}~#!]+))/gy
  const parsed: ShellTrashCommand = { paths: [], recursive: false, force: false }
  let offset = 0
  let options = true
  for (const token of rest.matchAll(tokens)) {
    offset += token[0].length
    const value = token[1] ?? token[2] ?? token[3]!
    if (options && value === '--') { options = false; continue }
    if (options && value.startsWith('-')) {
      if (!/^-[rRf]+$/u.test(value)) return null
      parsed.recursive ||= /[rR]/u.test(value)
      parsed.force ||= value.includes('f')
      continue
    }
    if (parsed.paths.length >= 100 || value.endsWith('/')) return null
    parsed.paths.push(value)
  }
  return offset === rest.length && (parsed.paths.length || parsed.force) ? parsed : null
}
