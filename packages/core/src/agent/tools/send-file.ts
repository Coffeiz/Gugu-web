import { sql, type Kysely } from 'kysely'
import { z } from 'zod'
import { dataContext } from '../../contracts/index.js'
import type { RunIdentity, ToolResult } from '../models.js'
import type { ToolDefinition } from './contracts.js'
import { downloadSendFileImage, type RemoteSendFileImage } from './send-file-image.js'

const sourceKeys = ['file_id', 'file', 'attach_id', 'url'] as const
type Source = { key: 'file_id'; value: number } | { key: 'file'; value: string } | { key: 'attach_id'; value: string }
type Artifact = { name: string; ext: string; size_bytes: number } & ({ file_id: number } | { attach_id: string })
type RemoteImagePort = {
  open: Parameters<typeof downloadSendFileImage>[1]
  stage(ownerId: string, image: RemoteSendFileImage, name: string, signal: AbortSignal):
    Promise<{ attach_id: string; img_width: number | null; img_height: number | null } | { error: string }>
}

const plainName = z.string().trim().min(1).max(255).regex(/^[^/\\\p{Cc}]+$/u)
const input = z.object({
  file_id: z.number().int().positive().max(2_147_483_647).optional(), file: plainName.optional(),
  attach_id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/u).optional(),
  url: z.string().trim().min(1).max(4096).optional(),
  title: z.string().max(4096).optional(), source_type: z.enum(sourceKeys).optional(),
}).strict().refine(args => {
  const provided = sourceKeys.filter(key => args[key] !== undefined)
  return provided.length === 1 && (!args.source_type || args.source_type === provided[0])
})

/** 工具准备属主的附件卡片，发送由采用同一任务租约的结果渠道负责。 */
export function createScheduledSendFileTool(resolve: (identity: RunIdentity, source: Source, signal: AbortSignal) =>
  Promise<Artifact | { error: string; candidates?: unknown }>, remote: RemoteImagePort): ToolDefinition {
  return {
    definition: { name: 'send_file', schema: { type: 'function', function: {
      name: 'send_file', description: '用户要求发送文件时，按文件库 ID、名称、已有聊天附件或公网图片 URL 准备本轮投递。',
      parameters: { type: 'object', additionalProperties: false, properties: {
        file_id: { type: 'integer', minimum: 1 }, file: { type: 'string' }, attach_id: { type: 'string' }, url: { type: 'string' },
        title: { type: 'string' }, source_type: { type: 'string', enum: [...sourceKeys] },
      }, oneOf: sourceKeys.map(key => ({ required: [key] })) },
    } } },
    effect: 'read',
    effectForInput: args => input.parse(args).url === undefined ? 'read' : 'write',
    validate: args => input.safeParse(args),
    async execute(args, scope) {
      const { file_id, file, attach_id, url, title } = input.parse(args)
      const label = [...(title ?? '').trim()].slice(0, 80).join('')
      const value = { ok: true, message: '已准备好附件，将随本轮结果尝试投递，是否送达以后续回执为准。' }
      if (url !== undefined) {
        const image = await downloadSendFileImage(url, remote.open, scope.signal)
        if ('error' in image) return { kind: 'completed', successful: false, mutated: false, value: image }
        const name = label || '图片'
        const staged = await remote.stage(scope.identity.ownerId, image, name, scope.signal)
        if ('error' in staged) return { kind: 'completed', successful: false, mutated: false, value: staged }
        const { attach_id: attachId, img_width: width, img_height: height } = staged
        return { kind: 'completed', successful: true, mutated: true, value, artifact: {
          attach_id: attachId, name, ext: image.ext, size_bytes: image.bytes.length, kind: 'image',
          img_width: width, img_height: height,
        } }
      }
      const source: Source = file_id !== undefined ? { key: 'file_id', value: file_id }
        : file !== undefined ? { key: 'file', value: file } : { key: 'attach_id', value: attach_id! }
      const artifact = await resolve(scope.identity, source, scope.signal)
      scope.signal.throwIfAborted()
      if ('error' in artifact) return { kind: 'completed', successful: false, mutated: false, value: artifact }
      const suffix = artifact.ext ? `.${artifact.ext}` : ''
      const name = suffix && label.toLowerCase().endsWith(suffix.toLowerCase()) ? label.slice(0, -suffix.length).trimEnd() : label
      return { kind: 'completed', successful: true, mutated: false, artifact: { ...artifact, name: name || artifact.name },
        value }
    },
  }
}

/** Web 文件库内优先精确文件名，再匹配部分名称。重名保留为待消歧状态。 */
export function createPostgresSendFileLookup<DB>(db: Kysely<DB>) {
  type Row = { id: number; display_name: string; storage_key: string; storage_backend: string; ext: string | null;
    space: string; folder_id: number | null }
  return async (ownerId: string, source: Exclude<Source, { key: 'attach_id' }>) => {
    const owner = dataContext(ownerId).ownerId
    const base = sql<Row>`SELECT id,display_name,storage_key,storage_backend,ext,space,folder_id
      FROM files WHERE user_id=${owner} AND deleted_at IS NULL`
    if (source.key === 'file_id') return (await sql<Row>`${base} AND id=${source.value}`.execute(db)).rows
    const separator = source.value.lastIndexOf('.')
    const name = separator < 0 ? source.value : source.value.slice(0, separator)
    if (!name) return []
    const exact = (await sql<Row>`${base} AND display_name=${name} ORDER BY id LIMIT 10`.execute(db)).rows
    if (exact.length) return exact
    const pattern = '%' + name.replace(/[\\%_]/gu, character => '\\' + character) + '%'
    return (await sql<Row>`${base} AND display_name ILIKE ${pattern} ORDER BY id LIMIT 10`.execute(db)).rows
  }
}

export interface ImSendFileInput { identity: RunIdentity; roundId: string; toolCallId: string; fileId?: number; attachId?: string; filePath?: string }
export interface ImSendFilePort {
  /** 只对已授权owner私聊开放文件库ID；附件仍需Host逐次核对完整IM scope。 */
  readonly allowFileId: boolean
  readonly allowFilePath?: boolean
  send(input: ImSendFileInput & {signal:AbortSignal}): Promise<'sent'|'failed'|'unknown'>
  recover(input: ImSendFileInput): Promise<'sent'|'failed'|'unknown'>
}
const output=(status:'sent'|'failed'|'unknown'):ToolResult=>status==='unknown'?{kind:'unknown'}:{kind:'completed',successful:status==='sent',mutated:status==='sent',
  value:{delivery_status:status,message:status==='sent'?'平台已接受文件发送':'文件未能发送'}}

/** 最小已接线来源；URL、文件名和Shell逻辑路径尚无正式授权端口，不向模型宣称支持。 */
export function createImSendFileTool(port:ImSendFilePort):ToolDefinition {
  const attach = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/u.test(value))
  const path = z.string().max(2048).regex(/^\/(personal|project|workspace)\/[^\x00-\x1f\x7f\\]+$/u)
  const schema = z.strictObject({
    attach_id: attach.optional(),
    ...(port.allowFileId ? { file_id: z.number().int().positive().safe().optional() } : {}),
    ...(port.allowFilePath ? { file: path.optional() } : {}),
  }).refine(value => Object.values(value).filter(item => item !== undefined).length === 1)
  const args = (raw: unknown) => {
    const value = schema.parse(raw)
    if (typeof value.file_id === 'number') return { fileId: value.file_id }
    if (typeof value.file === 'string') return { filePath: value.file }
    return { attachId: value.attach_id }
  }
  const properties = {
    ...(port.allowFileId ? { file_id: { type: 'integer', minimum: 1 } } : {}),
    ...(port.allowFilePath ? { file: { type: 'string', description: '文件库逻辑路径，例如 /personal/示例.pdf' } } : {}),
    attach_id: { type: 'string', minLength: 1, maxLength: 256 },
  }
  const keys = Object.keys(properties)
  return { definition: { name: 'send_file', schema: { type: 'function', function: {
    name: 'send_file', description: '仅在用户明确要求时发送已授权文件或本会话附件；平台结果不明确时不会重发。',
    parameters: { type: 'object', properties, additionalProperties: false,
      ...(keys.length > 1 ? { oneOf: keys.map(key => ({ required: [key] })) } : { required: keys }) },
  } } }, effect: 'write',
    validate:input=>schema.safeParse(input),
    async execute(input,scope,call){scope.signal.throwIfAborted();return output(await port.send({identity:scope.identity,roundId:scope.roundId,toolCallId:call.id,...args(input),signal:scope.signal}))},
    async reconcile(input,identity,call){return output(await port.recover({identity,roundId:identity.roundId,toolCallId:call.id,...args(input)}))},
  }
}
