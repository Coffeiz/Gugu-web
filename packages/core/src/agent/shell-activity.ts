/** 仅用于展示。无法可靠识别的语法留给通用工具标题。 */
export interface ShellActivity {
  action: 'directory' | 'read' | 'search' | 'find' | 'check' | 'checks' | 'git' | 'git_diff' | 'git_history' | 'build' | 'test'
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

export function describeShellActivity(input: unknown, output?: unknown): ShellActivity | undefined {
  const command = record(input).command
  if (typeof command !== 'string' || command.length > 4096 || /[$`\\<>(){}\r\n\x00-\x1f]/u.test(command)) return
  const tokenPattern = /"[^"]*"|'[^']*'|&&|\|\||[|;&]|[^\s"'|;&]+/gu
  const matches = [...command.matchAll(tokenPattern)]
  const tokens = matches.map(match => match[0])
  if (!tokens.length || tokens.join('') !== command.replace(/("[^"]*"|'[^']*')|\s+/gu, '$1')) return
  const isOperator = (token: string) => /^(&&|\|\||[|;&])$/u.test(token)
  if (matches.some((match, index) => {
    const next = matches[index + 1]
    return next && match.index + match[0].length === next.index && !isOperator(match[0]) && !isOperator(next[0])
  })) return
  const segments: string[][] = [[]]
  const operators: string[] = []
  for (const token of tokens) {
    if (isOperator(token)) {
      operators.push(token)
      segments.push([])
    } else {
      segments.at(-1)!.push(token.replace(/^(['"])(.*)\1$/u, '$2'))
    }
  }
  if (segments.some(words => !words.length) || operators.some(operator => operator === '&' || operator === '||')) return
  const activities = segments.map(classify)
  if (segments.length === 1) {
    const activity = activities[0]
    const result = record(output)
    const search = ['rg', 'grep', 'egrep', 'fgrep'].includes(segments[0]![0]!)
    const standardSearch = search && segments[0]!.slice(1).every(isSimpleSearchArg)
    return activity?.action === 'search' && standardSearch && result.exit_code === 1 && result.ok === false
      && result.timed_out === false && result.stderr === '' && result.stdout === ''
      ? { ...activity, noMatches: true } : activity
  }
  const [first, second] = activities
  if (segments.length === 2 && operators[0] === '|' && first?.action === 'read' && second?.action === 'search')
    return { action: 'search', ...(first.target ? { target: first.target } : {}) }
  if (operators.every(operator => operator === '|') && first
    && segments.slice(1).every(words => ['head', 'tail', 'wc'].includes(words[0]!))) return first
  if (operators.includes('|')) return
  const meaningful = activities.filter((activity, index) => activity || !['cd', 'echo', 'pwd'].includes(segments[index]![0]!))
  if (meaningful.length === 1) return meaningful[0]
  if (meaningful.length > 1 && meaningful.every(item => item && ['read', 'directory', 'search', 'find', 'check', 'git', 'git_diff', 'git_history'].includes(item.action)))
    return { action: 'checks' }
}
