import { sendImMedia, validateImOutboundFile } from '@gugu/gateway'
import type { FileHandle } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Pool } from 'pg'
import { openLocalFile } from '@gugu/fs/node'
import { normalizePersistentArtifact, type RunIdentity } from '@gugu/core/agent'
import { type ImActor } from '@gugu/core/im/access'
import { imCanUseTool } from '@gugu/core/agent/scenes/im'
import type { ImRunDeliveryPorts } from '@gugu/core/im/run-delivery'
import { isOwnedFileStorageKey } from '../../../files/store.js'
import { createWorkspaceFileReads } from '../../../workspaces/files.js'
import { imAttachmentScopeKey, type ImAttachmentScope } from '../inbound/attachments.js'
import type { GatewayPlatformSender } from '../connections.js'
import type { NodeImBotBinding } from '../inbound/inbox.js'
import { createImRunScope } from '../agent/scope.js'
import { imAcceptedEvidence, type ImAcceptedSource } from '../agent/evidence.js'

type Metadata = { name: string; ext: string; mime: string; size: number; storageKey?: string; identity?: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const same = (a: RunIdentity, b: RunIdentity) => a.ownerId === b.ownerId && a.sessionId === b.sessionId && a.runId === b.runId
class Rejected extends Error { constructor() { super('IM 制品投递未完成') } }

/** 只投递已有授权引用；不把rootId当路径，不创建对象身份，也不承接send_file工具。 */
export function createImRunArtifactSender(options: {
  pool: Pick<Pool, 'query'>; secretKey: string; storageRoot: string; identity: RunIdentity; actor: ImActor
  scope: ImAttachmentScope; messageIds: readonly string[]; payload: Readonly<Record<string, unknown>>
  sender(binding: NodeImBotBinding): GatewayPlatformSender | null
  /** 实时校验Bot、actor及冻结出站权限版本；不要求已终态Run仍持有活动执行租约。 */
  authorize(): Promise<boolean>
}): (input: Parameters<ImRunDeliveryPorts<unknown>['sender']['artifact']>[0], signal?: AbortSignal) => ReturnType<ImRunDeliveryPorts<unknown>['sender']['artifact']> {
  const proof = createImRunScope(options), { identity, actor, scope, payload, binding } = proof
  const pathFiles = createWorkspaceFileReads(options.pool, options.storageRoot)
  const scopeKey = imAttachmentScopeKey(scope)
  let source: ImAcceptedSource | undefined
  async function authorized() {
    if (!imCanUseTool(actor, 'send_item')) throw new Rejected()
    try { const read = await proof.read(); source = read; return read.watermark } catch { throw new Rejected() }
  }
  function metadata(name: unknown, ext: unknown, mime: unknown, size: unknown): Metadata {
    const file = { name, ext, mime, size: Number(size) }
    if (!validateImOutboundFile(scope.platform, file)) throw new Rejected()
    return { ...file, ext: file.ext.toLowerCase() }
  }
  async function attached(attachId: string, watermark: number): Promise<Metadata> {
    const rows = (await options.pool.query<Record<string, unknown>>(`SELECT a.name,a.ext,a.mime,a.size,a.storage_key,a.extra,m.conversation_seq
      FROM chat_attachments a JOIN conversation_messages m ON m.id=a.message_id JOIN conversation_sessions s ON s.id=m.session_id
      WHERE a.attach_id=$3 AND a.user_id=$1 AND s.user_id=$1 AND s.id=$2 AND a.state='attached'
        AND a.platform=$4 AND a.extra->>'im_ingress_scope'=$5 AND m.conversation_seq<=$6`,
    [identity.ownerId, identity.sessionId, attachId, scope.platform, scopeKey, watermark])).rows
    const row = rows[0]
    if (rows.length !== 1 || !row || typeof row.storage_key !== 'string' || !isOwnedFileStorageKey(identity.ownerId, row.storage_key)
      || !object(row.extra) || row.extra.im_ingress_scope !== scopeKey || !Number.isSafeInteger(Number(row.conversation_seq))
      || Number(row.conversation_seq) > watermark) throw new Rejected()
    return { ...metadata(row.name, row.ext, row.mime, row.size), storageKey: row.storage_key }
  }
  async function bytes(handle: FileHandle, expected: Metadata, signal?: AbortSignal): Promise<Buffer> {
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size !== expected.size) throw new Rejected()
      const data = Buffer.alloc(expected.size + 1)
      let offset = 0
      while (offset < data.length) {
        signal?.throwIfAborted()
        const read = await handle.read(data, offset, Math.min(1024 * 1024, data.length - offset), offset)
        if (!read.bytesRead) break
        offset += read.bytesRead
      }
      const after = await handle.stat()
      if (offset !== expected.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Rejected()
      return data.subarray(0, offset)
    } finally { await handle.close() }
  }
  return async (input, signal) => {
    let started = false
    try {
      if (!same(input.identity, identity) || !input.deliveryId) throw new Rejected()
      signal?.throwIfAborted()
      const artifact = normalizePersistentArtifact(input.artifact)
      if (!object(artifact) || ['rootId', 'root_id', 'relativePath', 'relative_path'].some(key => key in artifact) || artifact.kind === 'link_buttons') throw new Rejected()
      const attachId = artifact.attach_id, filePath = artifact.file_path
      if (['attach_id', 'file_path'].filter(key => artifact[key] !== undefined).length !== 1
        || !!attachId === !!filePath || attachId !== undefined && (typeof attachId !== 'string' || !attachId || attachId.length > 256)
        || filePath !== undefined && (typeof filePath !== 'string' || !filePath.startsWith('/'))) throw new Rejected()
      const watermark = await authorized()
      let resolved: Metadata, data: Buffer, readAllowed: () => Promise<boolean>
      if (typeof attachId === 'string') {
        resolved = await attached(attachId, watermark)
        const opened = await openLocalFile(options.storageRoot, resolved.storageKey!)
        if (!opened) throw new Rejected()
        data = await bytes(opened.handle, resolved, signal)
        readAllowed = async () => { const current = await attached(attachId, await authorized()); return current.storageKey === resolved.storageKey && current.size === resolved.size }
      } else {
        if (actor.role !== 'owner' || scope.chatType !== 'c2c') throw new Rejected()
        const opened = await pathFiles.openSandboxPath(identity.ownerId, filePath as string)
        const suffix = extname(opened.fileName).slice(1)
        resolved = { ...metadata(suffix ? opened.fileName.slice(0, -suffix.length - 1) : opened.fileName,
          suffix, opened.mimeType, opened.size), identity: opened.identity }
        data = await bytes(opened.handle, resolved, signal)
        readAllowed = async () => {
          await authorized()
          const current = await pathFiles.openSandboxPath(identity.ownerId, filePath as string).catch(() => null)
          if (!current) return false
          try { return current.identity === resolved.identity && current.size === resolved.size }
          finally { await current.handle.close() }
        }
      }
      const guard = async () => { try { return !signal?.aborted && await readAllowed() && await options.authorize() === true } catch { return false } }
      const sender = options.sender(binding)
      if (!sender || sender.platform !== scope.platform) throw new Rejected()
      // 私聊批次的飞书会话取自已按消息锚点验证的末条事实。
      const last = Array.isArray(payload._batch_messages) ? payload._batch_messages.at(-1) : payload
      started = true
      const result = await sendImMedia({ platform: sender, scope, file: resolved, bytes: data,
        feishuChatId: object(last) ? last.chat_id : null, wechatContextToken: payload.context_token, signal, authorize: guard })
      if (!result) throw new Rejected()
      return imAcceptedEvidence({ scope, source: source!, ...result, kind: 'artifact', bytes: data })
    } catch (error) { return error instanceof Rejected ? 'rejected' : started ? 'unknown' : 'rejected' }
  }
}
