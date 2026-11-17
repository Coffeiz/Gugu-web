export type ShellCommandRisk = 'safe' | 'write' | 'dangerous'

const dangerous = /(^|[;&|()\n])\s*(rm|mv|chmod|chown|kill|pkill|dd|mkfs|shutdown|reboot)\b|\b(git\s+(reset|clean)|sudo|doas|curl|wget)\b|(?:>|>>|\$\(|`)|\b(?:drop|delete|truncate)\b/iu
const codeExecution = /\b(?:python(?:\d+(?:\.\d+)*)?|node|nodejs|deno|bun|ruby|perl|php|lua|bash|dash|zsh|sh|pytest|npm|pnpm|npx|yarn|make|cmake|just|source|eval|exec)\b|(?:^|[;&|\s])(?:\.\/|\/)[^\s]+\.(?:py|js|mjs|cjs|sh|rb|pl|php|lua)\b/iu
const runtimeVersionQuery = /^(?:python(?:\d+(?:\.\d+)*)?|node(?:js)?|deno|bun|ruby|perl|php|lua)\s+(?:--version|-V)$/iu
const write = /(^|[;&|()\n])\s*(mkdir|touch|cp|python|pytest|npm|pnpm|git)\b/iu

/** 按整条命令分类，供 Host 在授权与执行前统一应用风险门。 */
export function classifyShellCommandRisk(command: string): ShellCommandRisk {
  const text = command.trim()
  if (!text) return 'safe'
  // 仅精确的运行时版本查询视为无副作用；拼接其他命令后仍按完整命令分类。
  if (runtimeVersionQuery.test(text)) return 'safe'
  // 不静态解释脚本正文；解释器、包脚本和构建工具一律进入危险命令确认门。
  if (dangerous.test(text) || codeExecution.test(text)) return 'dangerous'
  if (write.test(text)) return 'write'
  return 'safe'
}
