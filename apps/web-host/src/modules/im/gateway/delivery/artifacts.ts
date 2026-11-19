import type { FileHandle } from 'node:fs/promises'
import type { Pool } from 'pg'
import { openLocalFile } from '@gugu/fs/node'
import { normalizePersistentArtifact, type RunIdentity } from '@gugu/core/agent'
import { imCanUseTool, type ImActor } from '@gugu/core/im/access'
import type { ImRunDeliveryPorts } from '@gugu/core/im/run-delivery'
import type { FileReadOperations } from '../../../files/browse.js'
import { isOwnedFileStorageKey } from '../../../files/store.js'
import { imAttachmentScopeKey, type ImAttachmentScope } from '../inbound/attachments.js'
import type { GatewayPlatformSender } from '../platform-connections.js'
import type { NodeImBotBinding } from '../inbound/inbox.js'
import { createImRunScope } from '../agent/scope.js'
import { imAcceptedEvidence, type ImAcceptedSource } from '../agent/evidence.js'

type Metadata = { name: string; ext: string; mime: string; size: number; storageKey?: string; version?: number }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const positive = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= 2147483647
const same = (a: RunIdentity, b: RunIdentity) => a.ownerId === b.ownerId && a.sessionId === b.sessionId && a.runId === b.runId
class Rejected extends Error { constructor() { super('IM 制品投递未完成') } }

/** 只投递已有授权引用；不把rootId当路径，不创建对象身份，也不承接send_file工具。 */
export function createImRunArtifactSender(options: {
  pool: Pick<Pool, 'query'>; secretKey: string; storageRoot: string; identity: RunIdentity; actor: ImActor
  scope: ImAttachmentScope; messageIds: readonly string[]; payload: Readonly<Record<string, unknown>>
  /** 必须复用现有owned文件读取服务；仅owner允许读取兼容file_id。 */
  files: Pick<FileReadOperations, 'openContent' | 'getFile'>
  sender(binding: NodeImBotBinding): GatewayPlatformSender | null
  /** 实时校验Bot、actor及冻结出站权限版本；不要求已终态Run仍持有活动执行租约。 */
  authorize(): Promise<boolean>
}): (input: Parameters<ImRunDeliveryPorts<unknown>['sender']['artifact']>[0], signal?: AbortSignal) => ReturnType<ImRunDeliveryPorts<unknown>['sender']['artifact']> {
  const proof = createImRunScope(options), { identity, actor, scope, payload, binding } = proof
  const scopeKey = imAttachmentScopeKey(scope)
  const limit = scope.platform === 'qq' ? 30 * 1024 * 1024 : scope.platform === 'wechat' ? 20 * 1024 * 1024 : scope.platform === 'telegram' ? 50_000_000 : 100 * 1024 * 1024
  let source: ImAcceptedSource | undefined
  async function authorized() {
    if (!imCanUseTool(actor, 'send_file')) throw new Rejected()
    try { const read = await proof.read(); source = read; return read.watermark } catch { throw new Rejected() }
  }
  function metadata(name: unknown, ext: unknown, mime: unknown, size: unknown): Metadata {
    if (typeof name !== 'string' || !name || /[\x00-\x1f\x7f"\\/]/u.test(name) || [...name].length > 180
      || typeof ext !== 'string' || !/^[A-Za-z0-9]{0,16}$/.test(ext) || typeof mime !== 'string' || !mime
      || !Number.isSafeInteger(Number(size)) || Number(size) < 1 || Number(size) > limit) throw new Rejected()
    return { name, ext: ext.toLowerCase(), mime, size: Number(size) }
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
      const attachId = artifact.attach_id, fileId = artifact.file_id ?? artifact.id
      if (['attach_id', 'file_id', 'id'].filter(key => artifact[key] !== undefined).length !== 1
        || !!attachId === !!fileId || attachId !== undefined && (typeof attachId !== 'string' || !attachId || attachId.length > 256)
        || fileId !== undefined && !positive(String(fileId))) throw new Rejected()
      const watermark = await authorized()
      let resolved: Metadata, data: Buffer, readAllowed: () => Promise<boolean>
      if (typeof attachId === 'string') {
        resolved = await attached(attachId, watermark)
        const opened = await openLocalFile(options.storageRoot, resolved.storageKey!)
        if (!opened) throw new Rejected()
        data = await bytes(opened.handle, resolved, signal)
        readAllowed = async () => { const current = await attached(attachId, await authorized()); return current.storageKey === resolved.storageKey && current.size === resolved.size }
      } else {
        if (actor.role !== 'owner' || !imCanUseTool(actor, 'read_file')) throw new Rejected()
        const opened = await options.files.openContent(identity.ownerId, Number(fileId))
        if (!opened) throw new Rejected()
        try {
          if (!object(opened.file) || Number(opened.file.id) !== Number(fileId)) throw new Rejected()
          const ext = opened.file.ext, name = opened.file.displayName
          resolved = { ...metadata(name, ext, opened.mimeType, opened.size), version: Number(opened.file.version) }
          if (!Number.isSafeInteger(resolved.version) || resolved.version! < 1) throw new Rejected()
        } catch (error) { await opened.handle.close(); throw error }
        data = await bytes(opened.handle, resolved, signal)
        readAllowed = async () => { await authorized(); const current = await options.files.getFile(identity.ownerId, Number(fileId));
          return object(current) && Number(current.id) === Number(fileId) && Number(current.version) === resolved.version }
      }
      const guard = async () => { try { return !signal?.aborted && await readAllowed() && await options.authorize() === true } catch { return false } }
      if (!await guard()) throw new Rejected()
      const sender = options.sender(binding)
      if (!sender || sender.platform !== scope.platform) throw new Rejected()
      const name = resolved.ext ? `${resolved.name}.${resolved.ext}` : resolved.name
      const image = /^image\/(png|jpeg|gif|webp|bmp)$/.test(resolved.mime)
      started = true
      let receipt: Parameters<typeof imAcceptedEvidence>[0]['receipt'], recipient = scope.chatId ?? scope.platformUserId
      if (sender.platform === 'telegram') receipt = await sender.sender.file({ chatId: recipient, chatType: scope.chatType }, data, name, signal, guard)
      else if (sender.platform === 'feishu') {
        // 私聊聚合最外chat_id固定为null；原平台目标只取已被proof.read逐锚验证的末条事实。
        const last = Array.isArray(payload._batch_messages) ? payload._batch_messages.at(-1) : payload
        const target = scope.chatType === 'group' ? scope.chatId : object(last) ? last.chat_id : null
        if (typeof target !== 'string' || !/^oc_[A-Za-z0-9_-]+$/.test(target)) throw new Rejected()
        recipient = target
        receipt = await sender.sender.file(recipient, data, resolved.name, resolved.ext, signal, guard)
      } else if (sender.platform === 'wechat') {
        if (scope.chatType !== 'c2c' || typeof payload.context_token !== 'string' || !payload.context_token) throw new Rejected()
        const target = { userId: scope.platformUserId, contextToken: payload.context_token }
        receipt = image ? await sender.sender.image(target, data, signal, guard) : await sender.sender.file(target, data, name, signal, guard)
      } else {
        const target = { id: scope.chatId ?? scope.platformUserId, chatType: scope.chatType }
        const media = await sender.mediaUpload.upload({ target: scope.chatType === 'group' ? 'groups' : 'users', openid: target.id,
          fileType: image ? 1 : 4, data, fileName: name, signal, authorize: guard })
        if (typeof media.file_info !== 'string' || !await guard()) throw new Rejected()
        receipt = await sender.sender.media(target, { fileInfo: media.file_info, image, filename: name }, signal, guard)
      }
      return imAcceptedEvidence({ scope, source: source!, recipient, kind: 'artifact', bytes: data, receipt })
    } catch (error) { return error instanceof Rejected ? 'rejected' : started ? 'unknown' : 'rejected' }
  }
}
