import { randomUUID } from 'node:crypto'
import { createHostShellGrants, evaluateSandboxShell, shellConfirmationMode } from '../agent/security/shell-policy.js'
import { isIsolatedWorkspaceWrite } from '../agent/security/workspace-write.js'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { executeDesktopHostShell } from './desktop-host-shell.js'
import type { Database } from '../data/schema.js'
import type { Kysely } from 'kysely'
import { Executor } from '../agent/executor/executor.js'
import { desktopShellPlatform } from '@gugu/sandbox/desktop'
import { ExecutionError } from '../agent/executor/contracts.js'
import { createAgentShellTool } from '../agent/tools/shell.js'
import { actionApprovalMode } from '../agent/tools/confirmation.js'
import type { createSqliteToolConfirmation } from '../agent/interactions/sqlite-confirmation.js'
import type { ToolResult } from '../agent/models.js'

const hostGrants = createHostShellGrants(30 * 60 * 1000)
type DesktopHostAccess = { automaticMode: boolean; shellEnabled: boolean; dangerousEnabled: boolean }

export function desktopHostAuthorization(access: DesktopHostAccess, identity: import('../agent/models.js').RunIdentity, digest: (value: unknown) => string) {
  const platform = desktopShellPlatform()
  if (!platform || !access.shellEnabled) return null
  const version = digest([platform.id, access.shellEnabled, access.dangerousEnabled])
  return {
    version,
    permits: () => access.automaticMode || hostGrants.permits(identity, version),
    approve: () => hostGrants.approve(identity, version),
  }
}

export async function createDesktopShellTool(
  db: Kysely<Database>,
  confirmation: ReturnType<typeof createSqliteToolConfirmation>,
  digest: (value: unknown) => string,
  readAccess: (scope: import('../agent/tools/contracts.js').ToolScope) => Promise<DesktopHostAccess | null>,
) {
  const platform = desktopShellPlatform()
  if (!platform) return undefined
  const diagnostics = await platform.diagnostics()
  const fail = (error: string): ToolResult => ({
    kind: 'completed', successful: false, executed: false, mutated: false, value: { error },
  })

  return createAgentShellTool(async (input, scope, call) => {
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]|\r(?!\n)/u.test(input.command))
      return fail('Shell 命令包含无法安全显示的控制字符')
    const access = await readAccess(scope)
    if (!access) return fail('当前会话没有可用的 Shell 执行范围')
    const system = isAbsolute(input.cwd)
    if (!system && input.cwd !== '.') return fail('隔离命令使用 cwd=.，宿主机命令请提供绝对工作目录')
    const isolatedWorkspace = scope.resolution === null && isIsolatedWorkspaceWrite(input.command, input.cwd, '.')
    const decision = evaluateSandboxShell(input.command, {
      adminEnabled: true, userEnabled: access.shellEnabled, sandboxEnabled: true,
      sandboxReady: system || (diagnostics.supported && diagnostics.methods.includes(platform.method)),
      sessionOwned: true, workspaceValid: true, filesystemAuthorizationAvailable: true,
      fullUserSandboxWrite: false, adminDangerousEnabled: true, userDangerousEnabled: access.dangerousEnabled,
    }, { isolatedWorkspaceWrite: isolatedWorkspace })
    if (!decision.allowed) return fail(decision.reason)
    let hostCwd: string | undefined
    if (system) {
      if (/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(input.cwd)) return fail('宿主机工作目录无效')
      hostCwd = await realpath(input.cwd).catch(() => undefined)
      if (!hostCwd || !(await stat(hostCwd).catch(() => null))?.isDirectory()) return fail('宿主机工作目录无效')
    }
    const authorization = desktopHostAuthorization(access, scope.identity, digest)
    const systemMode = () => actionApprovalMode(
      authorization?.permits() ? 'never' : 'ask',
      true, scope.resolution !== null,
    )
    const mode = system ? systemMode() : shellConfirmationMode(decision, {
      system: false, isolatedWorkspace, approvalPolicy: access.automaticMode ? 'never' : 'ask', hasResolution: scope.resolution !== null,
    })
    if (mode === 'stale') return fail('命令确认对应的权限已变化')
    const snapshot = {
      targetIds: {},
      targetsDigest: digest(hostCwd ?? 'desktop-shell-temporary-directory'),
      versionsDigest: digest([platform.id, access.shellEnabled, access.dangerousEnabled]),
    }
    const argsDigest = digest(input)
    if (mode === 'request') {
      const prepared = await confirmation.gate.prepare(call, scope, argsDigest, snapshot)
      return prepared.ok ? { kind: 'waiting', interaction: prepared.value } : fail('无法申请 Shell 执行确认')
    }
    const confirmed = mode === 'verify' ? await confirmation.gate.verify(call, scope, argsDigest, snapshot) : null
    if (confirmed && !confirmed.ok) return fail('Shell 执行确认无效或已过期')

    if (hostCwd) {
      if (digest(access) !== digest(await readAccess(scope))) return fail('Shell 执行权限已变化')
      if (confirmed) {
        if (!await db.transaction().execute(tx => confirmation.claim(tx, confirmed.value, scope.signal)))
          return fail('Shell 确认已使用或已失效')
        authorization?.approve()
      } else if (!authorization?.permits()) {
        return fail('宿主机 Shell 授权已过期')
      }
      const value = await executeDesktopHostShell(input.command, hostCwd, input.timeout, input.max_output_chars, scope.signal)
      return { kind: 'completed', successful: value.ok, executed: true, mutated: true, value }
    }

    const backend = await platform.createExecutor().catch(() => null)
    if (!backend) return fail('桌面原生隔离不可用')
    const cwd = await mkdtemp(join(await realpath(tmpdir()), 'gugu-agent-shell-'))
    try {
      const currentAccess = await readAccess(scope)
      if (digest(access) !== digest(currentAccess)) return fail('Shell 执行权限已变化')
      if (confirmed && !await db.transaction().execute(tx => confirmation.claim(tx, confirmed.value, scope.signal)))
        return fail('Shell 确认已使用或已失效')
      const writable = isolatedWorkspace || decision.risk !== 'safe'
      const request = {
        id: confirmed?.value.operationId ?? randomUUID(), command: platform.command(input.command), cwd,
        timeoutMs: Math.ceil(input.timeout * 1000), destructive: decision.needsConfirmation,
      }
      try {
        const result = await new Executor([backend]).execute(request, {
          requestId: request.id, backend: backend.id, command: request.command, cwd,
          confirmed: Boolean(confirmed) || access.automaticMode,
          readonlyPaths: writable ? [] : [cwd], readwritePaths: writable ? [cwd] : [], environment: {},
          timeoutMs: request.timeoutMs, maxOutputBytes: input.max_output_chars * 4,
        }, scope.signal)
        const successful = result.exitCode === 0 && !result.timedOut
        return { kind: 'completed', successful, executed: true, mutated: false, value: {
          ok: successful, stdout: result.stdout.slice(0, input.max_output_chars),
          stderr: result.stderr.slice(0, input.max_output_chars), exit_code: result.exitCode,
          timed_out: result.timedOut, cwd: '.', scope: 'sandbox', network_access: 'none',
        } }
      } catch (error) {
        if (!(error instanceof ExecutionError)) throw error
        return { kind: 'completed', successful: false, executed: true, mutated: false, value: { error: error.message } }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {})
    }
  }, '使用 cwd=. 在隔离临时目录执行。需要在宿主机执行时，提供明确的绝对工作目录，普通模式首次授权后同一会话可执行 30 分钟。自动模式可直接执行宿主机命令。隔离空间不联网且临时文件不跨调用保存。', false)
}
