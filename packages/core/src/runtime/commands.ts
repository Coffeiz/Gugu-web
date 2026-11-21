import { desktopShellPlatform } from '@gugu/sandbox/desktop'
import { parseAgentCommand } from '../agent/commands/menu.js'
import { isAgentCommandHelpArgument } from '../agent/commands/help.js'
import { CoreError, frameSchema } from '../contracts/index.js'
import type { Fields } from '../contracts/index.js'
import type { DataServices } from '../data/services.js'
import type { LocalRuntime } from './local.js'
import { object, onlyFields, safeInteger } from '../shared/values.js'
import { DESKTOP_METHODS, DESKTOP_MUTATIONS, MAX_FRAME } from '../contracts/desktop.js'
import { desktopProjectFields, getDesktopProject, listDesktopProjects } from '../projects/desktop-board.js'
import { projectResponse } from '../projects/project-projection.js'
export { DESKTOP_METHODS, MAX_FRAME } from '../contracts/desktop.js'

export function isMutation(method: string): boolean {
  return DESKTOP_MUTATIONS.includes(method) || [
    'projects.create',
    'projects.rename',
    'projects.update',
    'projects.board.create',
    'projects.board.update',
    'projects.board.delete',
    'projects.board.restore',
    'clients.create',
    'clients.update',
    'clients.delete',
    'projects.createWithClient',
    'undo.apply',
    'undo.redo',
    'calendar.create',
    'calendar.update',
    'calendar.delete',
    'preferences.desktop.update',
    'agent.attachments.stage',
    'agent.attachments.deleteDraft',
    'mind.notes.create',
    'mind.notes.update',
    'mind.notes.delete',
    'mind.canvases.create',
    'mind.canvases.update',
    'mind.canvases.delete',
    'mind.canvases.notes.create',
    'mind.canvases.notes.update',
    'mind.canvases.items.update',
    'mind.canvases.items.delete',
    'mind.canvases.items.add',
    'mind.canvases.items.bring-to-front',
    'mind.canvases.relations.create',
    'mind.canvases.relations.delete',
    'mind.ref.create',
  ].includes(method)
}
const commandFields: Readonly<Record<string, readonly string[]>> = {
  'im.chart.render': ['type', 'source'],
  'im.qq.sequence': ['botId', 'messageId'],
  'im.inbox.projection': ['platform', 'connectionId', 'eventKey', 'runId', 'action', 'key', 'fingerprint', 'version', 'state', 'outcome', 'uploadId', 'part', 'total', 'chunk'],
  'im.inbox.delivery': ['platform', 'connectionId', 'eventKey', 'runId', 'action', 'noticeKey'],
  'im.inbox.prompt': ['platform', 'connectionId', 'action', 'promptId', 'messageId', 'eventKey', 'runId'],
  'im.inbox.reject': ['platform', 'connectionId', 'eventKey'],
  'im.inbox.recordGroup': ['platform', 'connectionId', 'eventKey', 'text', 'attachments', 'platformUserId', 'platformUserName', 'ownerPlatformUserId'],
  'im.inbox.pendingConnection': ['platform', 'after'],
  'im.inbox.prepare': ['platform', 'connectionId', 'chatType', 'ownerPlatformUserId'],
  'im.inbox.admit': ['platform', 'connectionId', 'eventKey', 'sealedEvent', 'attachments', 'sourceMessageId'],
  'im.inbox.attachmentReference': ['platform', 'connectionId', 'sourceMessageId', 'sourceIndex'],
  'agent.sessions.list': [],
  'agent.sessions.workspace': ['id', 'action'],
  'agent.sessions.setWorkspace': ['id', 'action', 'directoryId'],
  'agent.sessions.goal': ['id', 'action'],
  'agent.sessions.compact': ['id', 'model', 'text', 'clientId', 'queueClaim'],
  'agent.sessions.recoverStartup': [],
  'agent.sessions.create': ['title'],
  'agent.sessions.rename': ['id', 'title'],
  'agent.sessions.delete': ['id'],
  'agent.sessions.messages': ['id'],
  'agent.sessions.messageLocation': ['messageId'],
  'agent.sessions.history': ['id', 'before'],
  'agent.sessions.toolDetails': ['id', 'messageId', 'index'],
  'agent.sessions.events': ['id', 'runId', 'after', 'stateOnly', 'imDelivery', 'imStream'],
  'agent.memory.invalidateEmbedding': [],
  'agent.memory.resumeReflections': [],
  'agent.memory.read': [],
  'agent.memory.clear': [],
  'agent.memory.forget': ['query', 'revision'],
  'agent.sessions.cancelRun': ['id', 'runId'],
  'agent.sessions.startRun': ['id', 'text', 'clientId', 'model', 'embedding', 'interactive', 'modelId', 'attachments', 'references', 'queueClaim', 'locale', 'groupSender'],
  'agent.attachments.stage': ['attachment'],
  'agent.attachments.deleteDraft': ['attach_id'],
  'agent.attachments.clearDrafts': [],
  'agent.attachments.download': ['attach_id'],
  'agent.attachments.forSession': ['id'],
  'agent.sessions.runModel': ['id', 'runId'],
  'agent.sessions.respond': ['id', 'runId', 'promptId', 'eventId', 'token', 'text', 'secrets', 'model', 'embedding'],
  'agent.sessions.append': ['id', 'text', 'reply'],
  'agent.sessions.queue': ['action', 'queue_id', 'session_id', 'items', 'removed_keys', 'key', 'claim_token'],
  'skills.list': ['offset'],
  'skills.tools': ['offset'],
  'mcp.list': [],
  'mcp.config': ['id'],
  'skills.create': ['fields'],
  'skills.update': ['id', 'fields'],
  'skills.delete': ['id'],
  'mcp.create': ['fields'],
  'mcp.update': ['id', 'fields'],
  'mcp.delete': ['id'],
  'schedules.list': ['before', 'eventId'],
  'schedules.get': ['id'],
  'schedules.create': ['fields', 'eventId'],
  'schedules.update': ['id', 'fields', 'eventId'],
  'schedules.delete': ['id', 'eventId'],
  'schedules.claim': [],
  'core.info': [],
  'desktop.search': ['queries'],
  'executor.diagnostics': [],
  'desktop.terminal': ['action', 'terminalId', 'root', 'cols', 'rows', 'data'],
  'projects.list': ['archived'],
  'projects.rename': ['id', 'version', 'name'],
  'projects.update': ['id', 'version', 'fields'],
  'projects.board.list': ['collection', 'offset'],
  'projects.board.get': ['id'],
  'projects.board.create': ['fields'],
  'projects.board.update': ['id', 'version', 'fields'],
  'projects.board.delete': ['id'],
  'projects.board.restore': ['id'],
  'clients.list': [],
  'clients.update': ['id', 'fields'],
  'clients.delete': ['id'],
  'projects.createWithClient': ['project', 'client'],
  'operations.get': ['operation_id'],
  'undo.preview': ['context_id'],
  'undo.apply': ['context_id', 'undo_id'],
  'undo.redo': ['context_id', 'undo_id'],
  'calendar.list': [],
  'calendar.create': ['title', 'date', 'time', 'endTime', 'description'],
  'calendar.update': ['id', 'body'],
  'calendar.delete': ['id', 'version'],
  'preferences.desktop.get': [],
  'preferences.desktop.update': ['patch'],
  'onboarding.desktop.get': [],
  'mind.notes.list': [],
  'mind.notes.create': ['contentMd', 'title', 'color', 'capturedAt'],
  'mind.notes.update': ['id', 'fields'],
  'mind.notes.delete': ['id'],
  'mind.canvases.list': [],
  'mind.canvases.items.list': ['canvasId'],
  'mind.canvases.relations.list': ['canvasId'],
  'mind.canvases.items.add': ['canvasId', 'body'],
  'mind.canvases.items.bring-to-front': ['canvasId', 'id', 'body'],
  'mind.canvases.relations.create': ['body'],
  'mind.canvases.relations.delete': ['canvasId', 'id'],
  'mind.ref.create': ['body'],
  'mind.canvas-note.location': ['nodeId'],
  'mind.canvases.create': ['title', 'projectId'],
  'mind.canvases.update': ['id', 'body'],
  'mind.canvases.delete': ['id'],
  'mind.canvases.notes.create': ['canvasId', 'body'],
  'mind.canvases.notes.update': ['id', 'fields'],
  'mind.canvases.items.update': ['canvasId', 'id', 'body'],
  'mind.canvases.items.delete': ['canvasId', 'id'],
}

export function visibleError(error: unknown): {
  code: string
  message: string
} {
  if (error instanceof CoreError) {
    const messages: Record<string, string> = {
      conflict: '项目或操作已变化，请重新读取',
      not_found: '数据不存在',
      schema_upgrade_required: '数据库需要显式备份升级，请运行 Core migrate',
      cancelled: '操作已取消',
      busy: '本地数据队列已满',
      database_in_use: '数据库正由其他运行时使用，请先关闭其他实例',
    }
    if (messages[error.code]) return { code: error.code, message: messages[error.code]! }
    if (error.code === 'storage_error' || error.code === 'closed')
      return {
        code: 'storage_error',
        message: '本地数据操作失败，请重读数据确认状态',
      }
  }
  return {
    code: 'invalid_request',
    message: '桌面请求无效，请检查字段与能力范围',
  }
}
export function boundedFrame(value: Fields): string {
  const output = JSON.stringify(value)
  return Buffer.byteLength(output) + 1 <= MAX_FRAME
    ? output
    : JSON.stringify({
        v: value.v,
        id: value.id ?? null,
        error: { code: 'result_too_large', message: '结果超出桌面协议限制' },
      })
}
// 传输只处理帧；所有入口复用命令、身份和持久操作标识契约。
export async function desktopFrame(
  raw: unknown,
  runtime: Pick<LocalRuntime, 'call' | 'schemaVersion'>,
  protocol = 2,
): Promise<Fields> {
  let id: number | null = null
  try {
    const request = frameSchema.parse(raw)
    if (request.v !== protocol || (protocol === 1 && (request.operation_id !== undefined || request.accept_chunks !== undefined)))
      throw new CoreError('invalid_request', '协议版本不兼容')
    id = request.id
    if (
      (!(DESKTOP_METHODS as readonly string[]).includes(request.method) && !(protocol === 2 && ['undo.preview', 'undo.apply', 'undo.redo', 'calendar.list', 'calendar.create', 'calendar.update', 'calendar.delete', 'mind.notes.list', 'mind.notes.create', 'mind.notes.update', 'mind.notes.delete', 'mind.canvases.list', 'mind.canvases.items.list', 'mind.canvases.relations.list', 'mind.canvases.items.add', 'mind.canvases.items.bring-to-front', 'mind.canvases.relations.create', 'mind.canvases.relations.delete', 'mind.ref.create', 'mind.canvas-note.location', 'mind.canvases.create', 'mind.canvases.update', 'mind.canvases.delete', 'mind.canvases.notes.create', 'mind.canvases.notes.update', 'mind.canvases.items.update', 'mind.canvases.items.delete'].includes(request.method))) ||
      (protocol === 1 && request.method === 'operations.get')
    )
      throw new CoreError('invalid_request', '此能力不可用')
    validateCommandParams(request.method, request.params)
    if (protocol === 2 && isMutation(request.method) && !request.operation_id)
      throw new CoreError('invalid_request', '写入必须提供稳定操作标识')
    if (
      protocol === 1 &&
      request.method.endsWith('.list') &&
      Object.keys(request.params).length
    )
      throw new CoreError('invalid_request', '列表参数无效')
    if (request.method === 'desktop.terminal') {
      if (protocol !== 2) throw new CoreError('invalid_request', '终端需要桌面协议 2')
      const { desktopTerminal } = await import('./desktop-terminal.js')
      return { v: protocol, id, result: await desktopTerminal(request.params) }
    }
    const result =
      request.method === 'executor.diagnostics'
        ? await (desktopShellPlatform()?.diagnostics() ?? (await import('../agent/executor/platform.js')).mxcDiagnostics())
        : request.method === 'core.info'
          ? {
              protocol,
              storage: 'sqlite',
              accountMode: 'single-user',
              ...(protocol === 2
                ? { implementation: 'node', schema: runtime.schemaVersion }
                : {}),
            }
          : await runtime.call(request.method, request.params, {
              operationId: request.operation_id,
            })
    return { v: protocol, id, result }
  } catch (error) {
    return { v: protocol, id, error: visibleError(error) }
  }
}
// stdio 和直接使用 Worker 的宿主复用同一组参数规则；身份由宿主绑定。
export function validateCommandParams(method: string, params: Fields): void {
  object(params)
  if ('owner_id' in params || 'user_id' in params || 'ownerId' in params)
    throw new CoreError('invalid_request', '桌面请求参数无效')
  const allowed = Object.hasOwn(commandFields, method) ? commandFields[method] : undefined
  if (allowed) onlyFields(params, allowed)
  if (method === 'agent.memory.forget' && (typeof params.query !== 'string' || !params.query.trim()
    || params.query.length > 4000 || (params.revision !== undefined
      && (typeof params.revision !== 'string' || !/^[0-9a-f]{64}$/u.test(params.revision)))))
    throw new CoreError('invalid_request', '记忆删除请求无效')
  if (method === 'agent.sessions.startRun') {
    safeInteger(params.id)
    object(params.model)
    if (params.queueClaim !== undefined) {
      object(params.queueClaim)
      safeInteger(params.queueClaim.key)
      if (typeof params.queueClaim.token !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(params.queueClaim.token))
        throw new CoreError('invalid_request', '队列认领参数无效')
    }
    if ((params.locale !== undefined && params.locale !== 'zh-CN' && params.locale !== 'ja-JP' && params.locale !== 'en-US')
      || (params.interactive !== undefined && typeof params.interactive !== 'boolean')
      || (params.modelId !== undefined && (typeof params.modelId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(params.modelId)))
      || typeof params.text !== 'string' || Buffer.byteLength(params.text) > 12_000
      || (!params.text.trim() && (!Array.isArray(params.attachments) || !params.attachments.length)
        && (!Array.isArray(params.references) || !params.references.length))
      || (params.attachments !== undefined && (!Array.isArray(params.attachments) || params.attachments.length > 32
        || params.attachments.some(id => typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id))))
      || (params.references !== undefined && (!Array.isArray(params.references) || params.references.length > 50
        || params.references.some(ref => !ref || typeof ref !== 'object' || Array.isArray(ref)
          || typeof (ref as Record<string, unknown>).type !== 'string'
          || !['project','file','folder','event','canvas_note','conversation','skill','mcp','scheduled_task'].includes((ref as Record<string, unknown>).type as string)
          || !(typeof (ref as Record<string, unknown>).id === 'number' && Number.isSafeInteger((ref as Record<string, unknown>).id)
            || typeof (ref as Record<string, unknown>).id === 'string' && String((ref as Record<string, unknown>).id).length <= 24000)
          || typeof (ref as Record<string, unknown>).label !== 'string' || String((ref as Record<string, unknown>).label).length > 255)))
      || typeof params.clientId !== 'string' || !/^[A-Za-z0-9:_-]{1,64}$/.test(params.clientId)
      || typeof params.model.model !== 'string' || !params.model.model.trim() || params.model.model.length > 200
      || typeof params.model.base_url !== 'string' || params.model.base_url.length > 500)
      throw new CoreError('invalid_request', '运行启动参数无效')
  }
  if (method === 'agent.attachments.stage') {
    const attachment = params.attachment
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) throw new CoreError('invalid_request', '附件信息无效')
  }
  if (method === 'agent.attachments.deleteDraft'
    && (typeof params.attach_id !== 'string' || !/^[0-9a-f]{32}$/.test(params.attach_id)))
    throw new CoreError('invalid_request', '附件标识无效')
  if (method === 'agent.attachments.download'
    && (typeof params.attach_id !== 'string' || !/^[0-9a-f]{32}$/.test(params.attach_id)))
    throw new CoreError('invalid_request', '附件标识无效')
  if (method === 'agent.attachments.forSession') safeInteger(params.id)
  if (method === 'agent.sessions.queue') {
    const action = params.action
    if (!['read', 'imports', 'replace', 'patch', 'claim', 'release'].includes(String(action)))
      throw new CoreError('invalid_request', '队列操作无效')
    if (action === 'imports') onlyFields(params, ['action'])
    else {
      if (typeof params.queue_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(params.queue_id))
        throw new CoreError('invalid_request', '队列标识无效')
      if (action === 'read') onlyFields(params, ['action', 'queue_id'])
      else if (action === 'replace' || action === 'patch') {
        onlyFields(params, action === 'replace' ? ['action', 'queue_id', 'items'] : ['action', 'queue_id', 'session_id', 'items', 'removed_keys'])
        if (!Array.isArray(params.items) || params.items.length > 200
          || action === 'patch' && (!Array.isArray(params.removed_keys) || params.removed_keys.length > 200))
          throw new CoreError('invalid_request', '队列项目无效')
        if (action === 'patch') safeInteger(params.session_id)
      } else {
        onlyFields(params, action === 'claim'
          ? ['action', 'queue_id', 'session_id', 'key']
          : ['action', 'queue_id', 'session_id', 'key', 'claim_token'])
        safeInteger(params.session_id)
        safeInteger(params.key)
        if (action === 'release' && (typeof params.claim_token !== 'string' || params.claim_token.length < 1 || params.claim_token.length > 128))
          throw new CoreError('invalid_request', '队列认领参数无效')
      }
    }
  }
  if (method === 'agent.sessions.compact') {
    safeInteger(params.id)
    object(params.model)
    const command = typeof params.text === 'string' && Buffer.byteLength(params.text) <= 12_000
      ? parseAgentCommand(params.text) : null
    if (!command?.recognized || command.name !== 'compact' || isAgentCommandHelpArgument(command.argument)
      || typeof params.clientId !== 'string' || !/^[A-Za-z0-9:_-]{1,64}$/.test(params.clientId))
      throw new CoreError('invalid_request', '摘要命令无效')
    if (params.queueClaim !== undefined) {
      object(params.queueClaim)
      safeInteger(params.queueClaim.key)
      if (typeof params.queueClaim.token !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(params.queueClaim.token))
        throw new CoreError('invalid_request', '队列认领参数无效')
    }
    if (typeof params.model.model !== 'string' || !params.model.model.trim() || params.model.model.length > 200
      || typeof params.model.base_url !== 'string' || params.model.base_url.length > 500)
      throw new CoreError('invalid_request', '摘要模型参数无效')
  }
  if (method === 'agent.sessions.goal') {
    safeInteger(params.id)
    if (params.action !== 'status' && params.action !== 'pause' && params.action !== 'cancel' && params.action !== 'resume')
      throw new CoreError('invalid_request', '目标任务操作无效')
  }
  if (method === 'agent.sessions.workspace') {
    safeInteger(params.id)
    if (params.action !== 'list' && params.action !== 'show')
      throw new CoreError('invalid_request', '工作区查询操作无效')
  }
  if (method === 'agent.sessions.setWorkspace') {
    safeInteger(params.id)
    if (params.action !== 'bind' && params.action !== 'unlink'
      || (params.action === 'bind' && (typeof params.directoryId !== 'string'
        || !/^desktop:[a-f0-9-]{36}$/u.test(params.directoryId)))
      || (params.action === 'unlink' && params.directoryId !== undefined))
      throw new CoreError('invalid_request', '工作区绑定操作无效')
  }
  if (method === 'agent.sessions.respond') {
    safeInteger(params.promptId)
    object(params.model)
    const secret = Object.hasOwn(params, 'secrets')
    if (secret && params.secrets !== null) {
      object(params.secrets)
      const fields = Object.entries(params.secrets)
      if (fields.length > 16 || fields.some(([key, value]) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(key)
        || typeof value !== 'string' || value.length > 4096)) throw new CoreError('invalid_request', '凭据字段无效')
    }
    const recovering = !secret && params.eventId === undefined && params.token === undefined && params.text === undefined
    if (typeof params.model.model !== 'string' || !params.model.model.trim() || params.model.model.length > 200
      || typeof params.model.base_url !== 'string' || params.model.base_url.length > 500
      || (!recovering && (typeof params.eventId !== 'string' || !/^[A-Za-z0-9:_-]{1,64}$/.test(params.eventId)
      || (secret ? params.token !== undefined || params.text !== undefined
        : params.token === undefined
        ? typeof params.text !== 'string' || Buffer.byteLength(params.text) > 8_000
        : typeof params.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(params.token) || params.text !== undefined))))
      throw new CoreError('invalid_request', '交互回复参数无效')
  }
  if ((method === 'agent.sessions.startRun' || method === 'agent.sessions.respond') && params.embedding !== undefined) {
    const embedding = params.embedding
    object(embedding)
    onlyFields(embedding, ['provider', 'baseUrl', 'model', 'apiKey', 'dimensions', 'allowLocal'])
    if (typeof embedding.provider !== 'string' || typeof embedding.baseUrl !== 'string' || embedding.baseUrl.length > 500
      || typeof embedding.model !== 'string' || embedding.model.length > 200 || typeof embedding.apiKey !== 'string'
      || embedding.apiKey.length > 20_000 || !Number.isSafeInteger(embedding.dimensions) || Number(embedding.dimensions) < 0
      || (embedding.allowLocal !== undefined && typeof embedding.allowLocal !== 'boolean'))
      throw new CoreError('invalid_request', 'Embedding 配置无效')
    const url = URL.parse(embedding.baseUrl)
    const local = ['local', 'ollama'].includes(embedding.provider) && url && ['127.0.0.1', '[::1]'].includes(url.hostname)
    if (!url || url.username || url.password || url.search || url.hash || embedding.allowLocal === true && !local
      || (url.protocol !== 'https:' && !(local && url.protocol === 'http:')))
      throw new CoreError('invalid_request', 'Embedding 地址无效')
  }
  if (method === 'agent.sessions.events' || method === 'agent.sessions.cancelRun' || method === 'agent.sessions.respond' || method === 'agent.sessions.runModel') {
    safeInteger(params.id)
    if (params.after !== undefined) safeInteger(params.after, 0)
    if (params.imStream !== undefined && (params.imStream !== true || params.imDelivery !== true))
      throw new CoreError('invalid_request', '本机 IM 流式事件请求无效')
    if (params.imDelivery !== undefined && (params.imDelivery !== true || params.stateOnly !== undefined || params.runId === undefined))
      throw new CoreError('invalid_request', 'IM 投递事件查询参数无效')
    if (params.stateOnly !== undefined && (params.stateOnly !== true || params.after !== undefined))
      throw new CoreError('invalid_request', '运行状态查询参数无效')
    if ((method !== 'agent.sessions.events' || params.runId !== undefined) && (typeof params.runId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(params.runId)))
      throw new CoreError('invalid_request', '运行 ID 无效')
  }
  if (['undo.preview', 'undo.apply', 'undo.redo'].includes(method)) {
    if (typeof params.context_id !== 'string' || !params.context_id.trim() || params.context_id.length > 128) throw new CoreError('invalid_request', '撤销上下文无效')
    if (method !== 'undo.preview' && (typeof params.undo_id !== 'string' || !params.undo_id || params.undo_id.length > 80)) throw new CoreError('invalid_request', '撤销标识无效')
  }
  if ((method === 'skills.list' || method === 'skills.tools') && params.offset !== undefined &&
      (!Number.isSafeInteger(params.offset) || Number(params.offset) < 0))
    throw new CoreError('invalid_request', '技能分页无效')
  if (/^(skills|mcp)\.(update|delete|config)$/.test(method) &&
      (typeof params.id !== 'string' || !params.id || params.id.length > 64))
    throw new CoreError('invalid_request', '资源标识无效')
  if (/^(skills|mcp)\.(create|update)$/.test(method)) object(params.fields)
  if (method.startsWith('schedules.') && params.eventId !== undefined) safeInteger(params.eventId)
  if (method === 'schedules.list' && params.before !== undefined) safeInteger(params.before)
  if (['schedules.get', 'schedules.update', 'schedules.delete'].includes(method)) safeInteger(params.id)
  if (['schedules.create', 'schedules.update'].includes(method)) object(params.fields)
  if (method.startsWith('mind.canvases.')) {
    if (['mind.canvases.items.list', 'mind.canvases.relations.list', 'mind.canvases.notes.create', 'mind.canvases.items.add', 'mind.canvases.items.update', 'mind.canvases.items.delete', 'mind.canvases.items.bring-to-front', 'mind.canvases.relations.delete'].includes(method)) safeInteger(params.canvasId)
    if (['mind.canvases.notes.update', 'mind.canvases.items.update', 'mind.canvases.items.delete', 'mind.canvases.items.bring-to-front', 'mind.canvases.relations.delete'].includes(method)) safeInteger(params.id)
    if (method === 'mind.canvases.notes.create' && (!params.body || typeof params.body !== 'object' || Array.isArray(params.body))) throw new CoreError('invalid_request', '便签内容无效')
    if (['mind.canvases.items.add', 'mind.canvases.items.bring-to-front', 'mind.canvases.relations.create'].includes(method) && (!params.body || typeof params.body !== 'object' || Array.isArray(params.body))) throw new CoreError('invalid_request', '画布内容无效')
    if (method === 'mind.canvases.notes.update' && (!params.fields || typeof params.fields !== 'object' || Array.isArray(params.fields))) throw new CoreError('invalid_request', '便签内容无效')
    if (method === 'mind.canvases.items.update' && (!params.body || typeof params.body !== 'object' || Array.isArray(params.body))) throw new CoreError('invalid_request', '画布位置无效')
  }
  if (method === 'preferences.desktop.update' && (!params.patch || typeof params.patch !== 'object' || Array.isArray(params.patch)))
    throw new CoreError('invalid_request', '桌面外观设置无效')
  if (method === 'mind.ref.create' && (!params.body || typeof params.body !== 'object' || Array.isArray(params.body)))
    throw new CoreError('invalid_request', '引用内容无效')
  if (method === 'mind.canvas-note.location') safeInteger(params.nodeId)
}
export async function execute(
  data: DataServices,
  method: string,
  params: Fields,
): Promise<unknown> {
  validateCommandParams(method, params)
  switch (method) {
    case 'projects.list':
      if ('archived' in params && typeof params.archived !== 'boolean')
        throw new CoreError('invalid_request', '归档状态无效')
      return (await data.projects.list(params.archived as boolean | undefined)).map(
        ({ id, name, version }) => ({ id, name, version }),
      )
    case 'projects.create':
      return data.projects.create(params)
    case 'projects.rename':
      return data.projects.update(safeInteger(params.id), safeInteger(params.version), {
        name: params.name,
      })
    case 'projects.update':
      object(params.fields)
      return data.projects.update(
        safeInteger(params.id),
        safeInteger(params.version),
        params.fields,
      )
    case 'projects.board.list':
      return listDesktopProjects(data.projects, params.collection, safeInteger(params.offset ?? 0, 0))
    case 'projects.board.get':
      return getDesktopProject(data.projects, safeInteger(params.id))
    case 'projects.board.create':
      return projectResponse(await data.projects.create(desktopProjectFields(params.fields)), 0)
    case 'projects.board.update':
      return projectResponse(await data.projects.update(
        safeInteger(params.id), safeInteger(params.version), desktopProjectFields(params.fields),
      ), 0)
    case 'clients.list':
      return (await data.clients.list()).map(({ id, name }) => ({ id, name }))
    case 'clients.create':
      return data.clients.create(params)
    case 'clients.update':
      object(params.fields)
      return data.clients.update(safeInteger(params.id), params.fields)
    case 'clients.delete':
      await data.clients.delete(safeInteger(params.id))
      return null
    case 'projects.createWithClient': {
      object(params.project)
      object(params.client)
      const project = await data.projects.create(params.project),
        client = await data.clients.create(params.client)
      return { project, client }
    }
    default:
      throw new CoreError('invalid_request', '此 Core 能力不可用')
  }
}
