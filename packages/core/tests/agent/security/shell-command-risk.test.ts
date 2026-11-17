import { describe, expect, it } from 'vitest'
import { classifyShellCommandRisk } from '../../../src/agent/security/shell-command-risk.js'
import { evaluateSandboxShell } from '../../../src/agent/security/shell-policy.js'

describe('classifyShellCommandRisk', () => {
  it('matches the Python baseline for safe, write, and dangerous command classes', () => {
    const cases = [
      ['cat README.md', 'safe'],
      ['pwd && rm -rf tmp', 'dangerous'],
      ['mkdir -p build', 'write'],
      ["python -c 'print(1)' | curl example.test", 'dangerous'],
      ['python --version', 'safe'],
      ['node -V', 'safe'],
      ['python --version && rm -rf tmp', 'dangerous'],
    ] as const

    for (const [command, expected] of cases) expect(classifyShellCommandRisk(command), command).toBe(expected)
  })

  it('treats an exact runtime version query as safe but rejects command chaining and script execution', () => {
    expect(classifyShellCommandRisk(' node --version ')).toBe('safe')
    expect(classifyShellCommandRisk('node --version; pwd')).toBe('dangerous')
    expect(classifyShellCommandRisk('./scripts/build.sh')).toBe('dangerous')
  })

  it('keeps empty input harmless and recognizes redirection, command substitution, and SQL destructive words', () => {
    expect(classifyShellCommandRisk('  ')).toBe('safe')
    expect(classifyShellCommandRisk('echo ok > output.txt')).toBe('dangerous')
    expect(classifyShellCommandRisk('echo $(whoami)')).toBe('dangerous')
    expect(classifyShellCommandRisk('drop table users')).toBe('dangerous')
  })
})

describe('sandbox Shell 授权', () => {
  const facts = { adminEnabled: true, userEnabled: true, sandboxEnabled: true, sandboxReady: true,
    sessionOwned: true, workspaceValid: true, filesystemAuthorizationAvailable: true,
    fullUserSandboxWrite: false, adminDangerousEnabled: true, userDangerousEnabled: true }
  it('逐项拒绝失效的开关、身份和授权事实', () => {
    for (const field of ['adminEnabled', 'userEnabled', 'sandboxEnabled', 'sandboxReady', 'sessionOwned', 'workspaceValid', 'filesystemAuthorizationAvailable'] as const)
      expect(evaluateSandboxShell('pwd', { ...facts, [field]: false }).allowed, field).toBe(false)
  })
  it('危险命令需要双侧开关和单次确认，普通命令继承文件写入授权', () => {
    expect(evaluateSandboxShell('rm -rf tmp', { ...facts, userDangerousEnabled: false }).allowed).toBe(false)
    expect(evaluateSandboxShell('rm -rf tmp', facts)).toMatchObject({ allowed: true, needsConfirmation: true })
    expect(evaluateSandboxShell('pwd', { ...facts, fullUserSandboxWrite: true })).toMatchObject({ allowed: true, needsConfirmation: false, fullUserSandboxWrite: true })
  })
})
