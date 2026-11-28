import { CoreError, dataContext } from '../../contracts/index.js'
import { normalizeSecretFields, resolvedSecretPromptResult, validateSecretValues } from './secrets.js'

export interface SecretPromptRecord {
  id: number
  ownerId: string
  sessionId: number
  kind: string
  status: string
  expiresAt: Date
  schema: Record<string, unknown>
}

export interface SecretMcpServerRecord {
  id: string
  scope: string
  credentialSlots: readonly Record<string, unknown>[]
  configurationVersion?: string
}

export interface SecretCredentialEnvelope {
  ciphertext: string
  nonce: string
  encryptedDataKey: string
  keyVersion: number
}

export interface SecretInteractionTransaction {
  getOwnedPrompt(ownerId: string, promptId: number): Promise<SecretPromptRecord | null>
  getOwnedMcpServer(ownerId: string, serverId: string): Promise<SecretMcpServerRecord | null>
  updateCredentials(ownerId: string, serverId: string, envelope: SecretCredentialEnvelope): Promise<void>
  /** 持久化失效与凭据更新同事务提交，供其他 Host 发现并关闭旧连接。 */
  invalidateToolSnapshot(ownerId: string, serverId: string): Promise<void>
  resolvePrompt(prompt: SecretPromptRecord, schema: Record<string, unknown>, resolvedAt: Date): Promise<void>
  clearSecretStaging(ownerId: string, promptId: number, status: 'completed' | 'cancelled'): Promise<void>
  enqueueResume?(prompt: SecretPromptRecord, action: { actionType: 'secret' | 'cancel'; context: Record<string, unknown> }, resolvedAt: Date): Promise<void>
}

export interface SecretInteractionStore {
  transaction<T>(run: (tx: SecretInteractionTransaction) => Promise<T>): Promise<T>
}

export interface SecretInteractionConsumerOptions {
  store: SecretInteractionStore
  encrypt(values: Record<string, string>): SecretCredentialEnvelope | Promise<SecretCredentialEnvelope>
  now?: () => Date
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function fail(code: 'invalid_request' | 'not_found' | 'conflict', message: string): never {
  throw new CoreError(code, message)
}

function mcpServerId(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return null
  return value.toLowerCase()
}

function validateHeaderSlots(slots: readonly Record<string, unknown>[], values: Record<string, string>): void {
  for (const slot of slots) {
    if (slot.target !== 'header') continue
    const value = String(slot.prefix ?? '') + values[String(slot.id)]
    if (/[^\x00-\x7f]/.test(value)) fail('invalid_request', 'HTTP Header 凭据只能使用 ASCII 字符；请检查密钥值和前缀')
    if (/[\x00-\x1f\x7f]/.test(value)) fail('invalid_request', 'HTTP Header 凭据不能包含换行或控制字符')
  }
}

/** 消费 MCP 凭据 prompt；凭据、prompt 终态、工具缓存失效和 Run 恢复在同一事务内。 */
export function createSecretInteractionConsumer(options: SecretInteractionConsumerOptions) {
  if (!options.store || typeof options.store.transaction !== 'function' || typeof options.encrypt !== 'function') throw new TypeError('凭据交互服务未完整配置')
  const now = options.now ?? (() => new Date())
  return async (input: { ownerId: string; promptId: number; sessionId?: number; values: Record<string, string> | null }) => {
    const ownerId = dataContext(input.ownerId).ownerId
    if (!Number.isSafeInteger(input.promptId) || input.promptId <= 0) fail('invalid_request', '凭据交互请求无效')
    return options.store.transaction(async tx => {
      const prompt = await tx.getOwnedPrompt(ownerId, input.promptId)
      if (!prompt || prompt.ownerId !== ownerId || prompt.id !== input.promptId
        || (input.sessionId !== undefined && prompt.sessionId !== input.sessionId)) fail('not_found', input.values === null ? '凭据输入不存在' : '敏感信息输入不存在')
      const schema = object(prompt.schema)
      const context = object(schema.context)
      const target = object(context.secret_target)
      if (prompt.kind !== 'form' || target.kind !== 'mcp_credentials') {
        fail('invalid_request', input.values === null ? '当前交互不支持凭据取消' : '当前敏感信息交互没有可用的业务处理器')
      }
      const fields = normalizeSecretFields(schema.secret_fields)
      if (!fields) {
        if (input.values === null) fail('invalid_request', '当前交互不支持凭据取消')
        fail('conflict', '敏感字段定义无效或敏感信息输入已过期')
      }
      if (prompt.status !== 'active' || prompt.expiresAt.getTime() <= now().getTime()) {
        fail('conflict', input.values === null ? '凭据输入已结束' : '敏感信息输入已过期')
      }

      let actionType: 'secret' | 'cancel'
      let status: 'completed' | 'cancelled'
      let resolved: Record<string, unknown>
      if (input.values === null) {
        actionType = 'cancel'
        status = 'cancelled'
        resolved = { kind: prompt.kind, status: 'cancelled', prompt_id: prompt.id, option_id: 'cancel', value: null, text: '已取消凭据输入' }
      } else {
        const normalized = (() => {
          try { return validateSecretValues(fields, input.values) }
          catch (error) {
            fail('invalid_request', error instanceof Error && error.message === '敏感字段不能为空或过长' ? error.message : '敏感字段不匹配')
          }
        })()
        const serverId = mcpServerId(target.server_id)
        if (!serverId) fail('conflict', '敏感信息目标已失效')
        const server = await tx.getOwnedMcpServer(ownerId, serverId)
        if (!server || server.id !== serverId || server.scope !== 'user') fail('not_found', 'MCP server 不存在')
        if (Object.hasOwn(target, 'configuration_version')
          && (typeof target.configuration_version !== 'string' || !/^[a-f0-9]{64}$/u.test(target.configuration_version)
            || target.configuration_version !== server.configurationVersion)) {
          fail('conflict', 'MCP 凭据配置已变化，请重新发起填写')
        }
        const slots = server.credentialSlots
        const slotIds = slots.map(slot => slot.id)
        if (!slots.length || slots.length !== Object.keys(normalized).length || slotIds.some(id => typeof id !== 'string' || !Object.hasOwn(normalized, id))) {
          fail('invalid_request', '凭据槽位不匹配')
        }
        validateHeaderSlots(slots, normalized)
        const sealed = await options.encrypt(normalized)
        await tx.updateCredentials(ownerId, serverId, sealed)
        await tx.invalidateToolSnapshot(ownerId, serverId)
        actionType = 'secret'
        status = 'completed'
        resolved = resolvedSecretPromptResult(prompt.id)
      }

      const resolvedAt = now()
      const resolvedSchema = { ...schema, resolved_result: resolved }
      await tx.resolvePrompt(prompt, resolvedSchema, resolvedAt)
      await tx.clearSecretStaging(ownerId, prompt.id, status)
      if (typeof context.tool_call_id === 'string' && context.tool_call_id) {
        if (!tx.enqueueResume) throw new Error('交互恢复服务不可用')
        await tx.enqueueResume({ ...prompt, schema: resolvedSchema, status: 'resolved' }, { actionType, context }, resolvedAt)
      }
      return input.values === null ? { ok: true as const, prompt_id: prompt.id, status: 'cancelled' as const } : { ok: true as const, prompt_id: prompt.id }
    })
  }
}
