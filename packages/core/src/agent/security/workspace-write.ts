// 仅识别常见的简单 Shell 命令。复杂语法继续走原来的风险分类和确认门。
const readCommands = new Set(['cat', 'echo', 'grep', 'head', 'ls', 'printf', 'pwd', 'tail', 'wc'])
const writeCommands = new Set(['mkdir', 'touch'])
const separators = new Set([';', '\n', '|', '||', '&&'])

function localPath(token: string, workspace: string): boolean {
  const path = /^(['"]).*\1$/.test(token) ? token.slice(1, -1) : token
  return /^[\w./][\w./ -]*$/u.test(path) && !path.split('/').includes('..')
    && (!path.startsWith('/') || path.startsWith(`${workspace}/`))
}

export function isIsolatedWorkspaceWrite(command: string, cwd: string, workspace: string): boolean {
  if (cwd.startsWith('/') && cwd !== workspace && !cwd.startsWith(`${workspace}/`)) return false
  const text = command.trim()
  const tokens = /[ \t]+|>>?|&&|\|\||[;|\n]|(?:'[^'\n]*'|"(?:[^"\\$`\n]|\\[^\n]|\$\?)*"|\$\?|[\w./:+,%@=-]+)+/gy
  let position = 0
  let executable = ''
  let redirect = false
  let writes = false
  for (const [token] of text.matchAll(tokens)) {
    position += token.length
    if (!token.trim() && token !== '\n') continue
    if (redirect) {
      if (token !== '/dev/null' && !localPath(token, workspace)) return false
      redirect = false
    } else if (separators.has(token)) {
      executable = ''
    } else if (!executable) {
      if (!readCommands.has(token) && !writeCommands.has(token)) return false
      executable = token
      writes ||= writeCommands.has(token)
    } else if (token === '>' || token === '>>') {
      redirect = true
      writes = true
    } else if (writeCommands.has(executable) && !localPath(token, workspace) && token !== '--' && !(executable === 'mkdir' && token === '-p')) {
      return false
    }
  }
  return writes && !redirect && position === text.length
}
