import { createHash } from 'node:crypto'
import { z } from 'zod'
import { CoreError } from '../../../contracts/index.js'
import { stableJson } from '../../context/history/canonical-history.js'
import type { RunIdentity, ToolCall, ToolResult } from '../../models.js'
import type { ToolDefinition, ToolScope } from '../contracts.js'
import type { ClientDeleteConfirmationPort } from '../clients/index.js'
import type { ConfirmationClaimReference } from '../confirmation.js'
import { readFileSkillDeleteTarget } from './file-delete-target.js'

const inputSchema = z.strictObject({ id: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u) })
type Target = Awaited<ReturnType<typeof readFileSkillDeleteTarget>>

/** 删除端口必须在同一事务认领确认与持久收据，并在持有文件锁时再次核验目录摘要。 */
export interface FileSkillDeletePort {
  remove(input: { target: Target; claim: ConfirmationClaimReference; scope: ToolScope; call: ToolCall }): Promise<ToolResult>
  reconcile(input: { id: string; identity: RunIdentity & { roundId: string }; call: ToolCall }): Promise<ToolResult>
}

/** 只允许删除当前用户确认过的完整技能包；取消或版本改变时不调用删除端口。 */
export function createFileSkillDeleteTool(dataRoot: string, confirmation: ClientDeleteConfirmationPort, port: FileSkillDeletePort): ToolDefinition {
  const failure = (error: string): ToolResult => ({ kind: 'completed', successful: false, mutated: false, value: { error } })
  return {
    definition: { name: 'delete_skill', schema: { type: 'function', function: {
      name: 'delete_skill', description: '删除当前用户的文件技能及附属文件，确认后可撤销。',
      parameters: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$' } }, required: ['id'], additionalProperties: false },
    } } },
    effect: 'write', destructive: true, requiresInteraction: true, confirmationReplay: true,
    validate: input => inputSchema.safeParse(input),
    reconcile(input, identity, call) { return port.reconcile({ id: inputSchema.parse(input).id, identity, call }) },
    async execute(input, scope, call) {
      const { id } = inputSchema.parse(input)
      scope.signal.throwIfAborted()
      if (scope.resolution?.status === 'confirmed') {
        const replay = await port.reconcile({ id, identity: { ...scope.identity, roundId: scope.roundId }, call })
        if (replay.kind !== 'unknown') return replay
      }
      let target: Target
      try { target = await readFileSkillDeleteTarget(dataRoot, scope.identity.ownerId, id) }
      catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
          return scope.resolution?.status === 'confirmed' ? { kind: 'unknown' } : failure('技能不存在或不属于当前用户')
        if (error instanceof CoreError && ['conflict', 'invalid_request', 'not_found'].includes(error.code)) return failure(error.message)
        throw error
      }
      scope.signal.throwIfAborted()
      const digest = createHash('sha256').update(stableJson({ id })).digest('hex')
      if (!scope.resolution) {
        const prepared = await confirmation.gate.prepare(call, scope, digest, target)
        return prepared.ok ? { kind: 'waiting', interaction: prepared.value } : failure('技能删除确认无效或已过期')
      }
      const verified = await confirmation.gate.verify(call, scope, digest, target)
      if (!verified.ok) return failure('技能删除确认无效或已过期')
      return port.remove({ target, claim: verified.value, scope, call })
    },
  }
}
