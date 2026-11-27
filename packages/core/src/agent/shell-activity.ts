/** 仅用于展示。无法可靠识别的语法留给通用工具标题。 */
export interface ShellActivity {
  action: 'directory' | 'read' | 'search' | 'find' | 'check' | 'checks' | 'git' | 'git_diff' | 'git_history' | 'build' | 'test' | 'command' | 'commands'
    | 'system' | 'cwd' | 'load' | 'hardware' | 'processes' | 'disk' | 'memory' | 'load_processes' | 'resources'
  commandCount?: number
  commands?: string[]
  target?: string
  noMatches?: true
}

function safeTarget(value?: string) {
  if (!value || value === '.' || value === '..' || value.startsWith('-') || value.includes('://')) return
  const name = value.replace(/[/\\]+$/u, '').split(/[/\\]/u).at(-1)
  if (name && /^[\p{L}\p{N}_][\p{L}\p{N}_. -]{0,63}$/u.test(name)
    && !/(?:secret|credential|token|password|passwd|api[_-]?key|private[_-]?key|id_rsa)/iu.test(name)) return name
}

function isSimpleSearchArg(arg: string) {
  return !arg.startsWith('-') || /^-[inwFxHh]+$/u.test(arg)
}

function classify(words: string[]): ShellActivity | undefined {
  const [command, ...args] = words[0] === 'corepack' ? words.slice(1) : words
  const operands = args.filter(value => !value.startsWith('-'))
  const last = safeTarget(operands.at(-1))
  const target = (action: ShellActivity['action'], name = last): ShellActivity => ({ action, ...(name ? { target: name } : {}) })
  switch (command) {
    case 'pwd': return { action: 'cwd' }
    case 'whoami': case 'uname': case 'sw_vers': return { action: 'system' }
    case 'date': return args.every(arg => arg === '-u' || arg.startsWith('+')) ? { action: 'system' } : undefined
    case 'uptime': return { action: 'load' }
    case 'sysctl': return args.every(arg => !arg.includes('=') && !/^-[a-z]*[fw]/iu.test(arg))
      ? { action: 'hardware' } : undefined
    case 'ps': return { action: 'processes' }
    case 'df': return { action: 'disk' }
    case 'vm_stat': case 'free': return { action: 'memory' }
    case 'ls': case 'tree':
      return args.every(arg => !arg.startsWith('-') || /^-[alhR1]+$/u.test(arg)) ? target('directory') : { action: 'directory' }
    case 'cat': case 'head': case 'tail': {
      const readArgs = args[0] === '-n' && /^\d+$/u.test(args[1] ?? '') ? args.slice(2) : args
      const name = safeTarget(readArgs.filter(arg => !arg.startsWith('-')).at(-1))
      return name && readArgs.every(arg => !arg.startsWith('-') || (command === 'cat' && /^-[AbEnsTuv]+$/u.test(arg)))
        ? { action: 'read', target: name } : { action: 'read' }
    }
    case 'sed':
      return args.length === 3 && args[0] === '-n' && /^\d+(?:,\d+)?p$/u.test(args[1]!)
        ? target('read') : undefined
    case 'find': return target('find', safeTarget(args[0]))
    case 'rg': case 'grep': case 'egrep': case 'fgrep': {
      if (command === 'rg' && args.includes('--files'))
        return args.every(arg => !arg.startsWith('-') || arg === '--files') ? target('find') : { action: 'find' }
      // 搜索关键词和选项的值不进入标题。
      if (!args.every(isSimpleSearchArg)) return { action: 'search' }
      return operands.length > 1 ? target('search') : { action: 'search' }
    }
    case 'test': return { action: 'check', ...(['-e', '-f', '-d', '-r', '-s', '-L'].includes(args[0] ?? '') && args.length === 2 && last ? { target: last } : {}) }
    case 'stat': case 'wc':
      return args.every(arg => !arg.startsWith('-') || (command === 'wc' && /^-[clmwL]+$/u.test(arg)))
        ? target('check') : { action: 'check' }
    case 'git':
      if (args[0] === 'status') return { action: 'git' }
      if (args[0] === 'diff') return { action: 'git_diff' }
      if (args[0] === 'log' || args[0] === 'show') return { action: 'git_history' }
      return
    case 'node':
      return args[0] === '--check' && args.length === 2 ? target('check') : undefined
    case 'pnpm': case 'npm': case 'yarn': case 'bun': {
      const scriptArgs = command === 'pnpm' && (args[0] === '--filter' || args[0] === '-F')
        ? args.slice(2) : args
      const script = scriptArgs[0] === 'run' ? scriptArgs[1] : scriptArgs[0]
      if (script === 'build' || script === 'test') return { action: script }
      return
    }
    case 'vitest': case 'pytest': case 'jest': return { action: 'test' }
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

const setupCommands = new Set(['cd', 'echo'])
const shellKeywords = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', 'function', 'select', 'time', 'coproc'])

function executableName(word: string) {
  return /^(?:\/(?:usr\/(?:local\/)?|opt\/homebrew\/)?s?bin\/)?([a-zA-Z][a-zA-Z0-9_.+-]{0,39})$/u.exec(word)?.[1]
}

const checkActions = new Set(['read', 'directory', 'search', 'find', 'check', 'git', 'git_diff', 'git_history'])

function classifySegment(words: string[], name?: string): ShellActivity | undefined {
  if (!name || setupCommands.has(name) || shellKeywords.has(name)) return
  const args = words.slice(1)
  if (['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'].includes(name)
    && args.some(arg => /^-[a-z]*c[a-z]*$/iu.test(arg))) return
  return classify([name, ...args]) ?? { action: 'command', target: name }
}

function outputLimiter(words: string[]) {
  const [command, ...args] = words
  if (command === 'wc') return args.every(arg => /^-[clmwL]+$/u.test(arg))
  if (command !== 'head' && command !== 'tail') return false
  return !args.length || (args.length === 1 && /^-\d+$/u.test(args[0]!))
    || (args.length === 2 && (args[0] === '-n' || args[0] === '-c') && /^\d+$/u.test(args[1]!))
}

export const MAX_SHELL_DESCRIPTION_LENGTH = 80

/** 只读取可作为单行展示的模型说明。 */
export function shellOperationDescription(input: unknown): string | undefined {
  const description = record(input).description
  if (typeof description !== 'string' || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(description)) return
  const text = description.trim()
  return text && Array.from(text).length <= MAX_SHELL_DESCRIPTION_LENGTH ? text : undefined
}

export function describeShellActivity(input: unknown, output?: unknown): ShellActivity | undefined {
  const command = record(input).command
  if (typeof command !== 'string' || command.length > 4096 || /[\x00-\x08\x0b-\x1f]/u.test(command)) return
  const source = command.trim()
  const tokenPattern = /[012]>&[012](?=\s|[|;&]|$)|"[^"]*"|'[^']*'|&&|\|\||[|;&]|\n+|[^\s"'|;&]+/gu
  const matches = [...source.matchAll(tokenPattern)]
  const tokens = matches.map(match => match[0])
  if (!tokens.length || tokens.join('') !== source.replace(/("[^"]*"|'[^']*'|\n+)|[^\S\n]+/gu, '$1')) return
  const isFdDuplication = (token: string) => /^[012]>&[012]$/u.test(token)
  const isOperator = (token: string) => /^(&&|\|\||[|;&]|\n+)$/u.test(token)
  // 单引号内的标点是普通文本；其余复杂语法仍使用通用标题。
  if (tokens.some(token => !isFdDuplication(token) && !token.startsWith("'") && (token.startsWith('"') ? /[$`\\]/u : /[$`\\<>(){}#]/u).test(token))) return
  if (matches.some((match, index) => {
    const next = matches[index + 1]
    return next && match.index + match[0].length === next.index && !isOperator(match[0]) && !isOperator(next[0])
  })) return
  const segments: string[][] = [[]]
  const operators: string[] = []
  for (const token of tokens) {
    if (isFdDuplication(token) && segments.at(-1)!.length) continue
    if (isOperator(token)) {
      const newline = token.startsWith('\n')
      if (newline && !segments.at(-1)!.length) continue
      operators.push(newline ? ';' : token)
      segments.push([])
    } else {
      segments.at(-1)!.push(token.replace(/^(['"])([\s\S]*)\1$/u, '$2'))
    }
  }
  if (segments.some(words => !words.length) || operators.includes('&')) return
  const singleCommand = segments.length === 1
  while ((operators[0] === '&&' || operators[0] === ';') && setupCommands.has(segments[0]![0]!)) {
    segments.shift()
    operators.shift()
  }
  const names = segments.map(words => executableName(words[0]!))
  const activities = segments.map((words, index) => classifySegment(words, names[index]))
  if (segments.length === 1) {
    const activity = activities[0]
    const result = record(output)
    const search = ['rg', 'grep', 'egrep', 'fgrep'].includes(names[0] ?? '')
    const standardSearch = singleCommand && search && segments[0]!.slice(1).every(isSimpleSearchArg)
    if (activity?.action === 'search' && standardSearch && result.exit_code === 1 && result.ok === false
      && result.timed_out === false && result.stderr === '' && result.stdout === '')
      return { ...activity, noMatches: true }
    return activity
  }
  const [first, second] = activities
  if (segments.length === 2 && operators[0] === '|' && first?.action === 'read' && second?.action === 'search')
    return { action: 'search', ...(first.target ? { target: first.target } : {}) }

  const actions: ShellActivity['action'][] = []
  const commands: string[] = []
  for (const [index, words] of segments.entries()) {
    const name = names[index]
    const activity = activities[index]
    const inPipeline = operators[index - 1] === '|' || operators[index] === '|'
    if (!inPipeline && name === 'echo') continue
    if (operators[index - 1] === '|' && outputLimiter(words)) continue
    if (!name || (!activity && name !== 'echo')) return
    actions.push(activity?.action ?? 'command')
    commands.push(name)
  }
  if (commands.length === 1) return activities.find((activity, index) => activity && names[index] === commands[0])
  if (!commands.length) return
  const commandCount = commands.length
  const kinds = new Set(actions)
  if (actions.every(action => checkActions.has(action))) return { action: 'checks' }
  if (actions.every(action => action === 'system' || action === 'cwd')) return { action: 'system', commandCount }
  if (kinds.has('disk') && kinds.has('memory') && kinds.has('processes') && kinds.size === 3)
    return { action: 'resources', commandCount }
  if (kinds.has('load') && kinds.has('processes') && actions.every(action => ['load', 'hardware', 'processes'].includes(action)))
    return { action: 'load_processes', commandCount }
  if (kinds.size === 1 && ['load', 'hardware', 'processes', 'disk', 'memory'].includes(actions[0]!))
    return { action: actions[0]!, commandCount }
  return { action: 'commands', commandCount, commands: commands.slice(0, 2) }
}
