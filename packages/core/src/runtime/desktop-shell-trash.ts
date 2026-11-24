import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const deletion = /\b(?:rm|rmdir|unlink|del|erase|remove-item|clear-content|shred|srm|rimraf|rd)\b|\b(?:find|git)\b[^\n]*(?:-delete|-exec|\bclean\b)/iu

/** 只接受静态路径，原命令不会交给 Shell 展开或执行。 */
export function parseDesktopTrashCommand(command: string) {
  const value = command.trim()
  const tokens = value.match(/'[^'\r\n]*'|"[^"\r\n]*"|[^\s'"]+/gu) ?? []
  if (!/^(?:\/bin\/|\/usr\/bin\/)?(?:rm|rmdir|unlink)$/u.test(tokens[0] ?? ''))
    return deletion.test(value) ? { kind: 'blocked' as const } : { kind: 'other' as const }
  const standalone = /^(?:'[^'\r\n]*'|"[^"$`\\\r\n]*"|[^\s'"$&|;()<>`*?\[\]{}~\\!#]+)(?:[ \t]+(?:'[^'\r\n]*'|"[^"$`\\\r\n]*"|[^\s'"$&|;()<>`*?\[\]{}~\\!#]+))*$/u
  if (!standalone.test(value)) return { kind: 'blocked' as const }
  const paths: string[] = []
  let flags = true
  for (const token of tokens.slice(1)) {
    if (flags && token === '--') { flags = false; continue }
    if (flags && token.startsWith('-')) {
      if (!/^-[rfR]+$/u.test(token)) return { kind: 'blocked' as const }
      continue
    }
    paths.push(/^['"]/u.test(token) ? token.slice(1, -1) : token)
  }
  return paths.length && paths.length <= 32 ? { kind: 'trash' as const, paths } : { kind: 'blocked' as const }
}

function contains(root: string, target: string) {
  const rel = relative(root, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}

export async function desktopTrashTarget(path: string, cwd: string, workspace?: string) {
  if (!path || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(path)) throw new Error('无效的废纸篓路径')
  const candidate = resolve(cwd, path)
  const target = join(await realpath(dirname(candidate)), basename(candidate))
  if (contains(target, cwd) || contains(target, homedir()) || (workspace && !contains(workspace, target)))
    throw new Error('目标不在允许移入废纸篓的范围')
  const entry = await lstat(target, { bigint: true })
  return { path: target, identity: [entry.dev, entry.ino, entry.mode, entry.ctimeNs].join(':') }
}
