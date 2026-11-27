import { z } from 'zod'
import type { RunIdentity, ToolResult } from '../../models.js'
import type { ToolDefinition } from '../contracts.js'
import { downloadSendFileImage, type RemoteSendFileImage } from './send-file-image.js'

const sourceKeys = ['file', 'attach_id', 'url'] as const
type Source = { key: 'file'; value: string } | { key: 'attach_id'; value: string }
type Artifact = { name: string; ext: string; size_bytes: number } & ({ file_path: string } | { attach_id: string })
type RemoteImagePort = {
  open: Parameters<typeof downloadSendFileImage>[1]
  stage(ownerId: string, image: RemoteSendFileImage, name: string, signal: AbortSignal):
    Promise<{ attach_id: string; img_width: number | null; img_height: number | null } | { error: string }>
}

const input = z.object({
  file: z.string().trim().min(1).max(4096).regex(/^\/(personal|project|workspace)\/[^\\\p{Cc}]+$/u).optional(),
  attach_id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/u).optional(),
  url: z.string().trim().min(1).max(4096).optional(),
  title: z.string().max(4096).optional(), source_type: z.enum(sourceKeys).optional(),
}).strict().refine(args => {
  const provided = sourceKeys.filter(key => args[key] !== undefined)
  return provided.length === 1 && (!args.source_type || args.source_type === provided[0])
})

/** 工具准备属主的附件卡片，发送由采用同一任务租约的结果渠道负责。 */
export function createScheduledSendFileTool(resolve: (identity: RunIdentity, source: Source, signal: AbortSignal) =>
  Promise<Artifact | { error: string; candidates?: unknown }>, remote: RemoteImagePort, archiveFolder?: (identity: RunIdentity, path: string, signal: AbortSignal) =>
  Promise<Artifact | { error: string }>): ToolDefinition {
  const folderInput = z.strictObject({ kind: z.literal('folder'), path: z.string().min(1).max(4096) })
  return {
    definition: { name: 'send_item', schema: { type: 'function', function: {
      name: 'send_item', description: '用户要求发送文件时，按文件库沙盒绝对路径、已有聊天附件或公网图片 URL 准备本轮投递。' + (archiveFolder ? '文件夹使用 kind=folder 和沙盒绝对路径，打包为 ZIP 随本轮发送。' : ''),
      parameters: { type: 'object', additionalProperties: false, properties: {
        file: { type: 'string', description: '文件的沙盒绝对路径，例如 /personal/报告.pdf' }, attach_id: { type: 'string' }, url: { type: 'string' },
        ...(archiveFolder ? { kind: { type: 'string', enum: ['folder'] }, path: { type: 'string' } } : {}),
        title: { type: 'string' }, source_type: { type: 'string', enum: [...sourceKeys] },
      }, oneOf: [...sourceKeys.map(key => ({ required: [key] })), ...(archiveFolder ? [{ required: ['kind', 'path'] }] : [])] },
    } } },
    effect: 'read',
    effectForInput: args => (archiveFolder && folderInput.safeParse(args).success) || input.parse(args).url !== undefined ? 'write' : 'read',
    validate: args => archiveFolder ? z.union([input, folderInput]).safeParse(args) : input.safeParse(args),
    async execute(args, scope) {
      const folder = folderInput.safeParse(args)
      if (archiveFolder && folder.success) {
        const artifact = await archiveFolder(scope.identity, folder.data.path, scope.signal)
        if ('error' in artifact) return { kind: 'completed', successful: false, mutated: false, value: artifact }
        return { kind: 'completed', successful: true, mutated: true,
          value: { ok: true, message: '已将文件夹打包为 ZIP，附件随本轮结果投递。' }, artifact }
      }
      const { file, attach_id, url, title } = input.parse(args)
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
      const source: Source = file !== undefined ? { key: 'file', value: file } : { key: 'attach_id', value: attach_id! }
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

export interface ImSendFileInput { identity: RunIdentity; roundId: string; toolCallId: string; attachId?: string; filePath?: string }
export interface ImSendFilePort {
  /** 附件和文件路径由 Host 逐次核对授权。 */
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
    ...(port.allowFilePath ? { file: path.optional() } : {}),
  }).refine(value => Object.values(value).filter(item => item !== undefined).length === 1)
  const args = (raw: unknown) => {
    const value = schema.parse(raw)
    if (typeof value.file === 'string') return { filePath: value.file }
    return { attachId: value.attach_id }
  }
  const properties = {
    ...(port.allowFilePath ? { file: { type: 'string', description: '文件库逻辑路径，例如 /personal/示例.pdf' } } : {}),
    attach_id: { type: 'string', minLength: 1, maxLength: 256 },
  }
  const keys = Object.keys(properties)
  return { definition: { name: 'send_item', schema: { type: 'function', function: {
    name: 'send_item', description: '仅在用户明确要求时发送已授权文件或本会话附件；平台结果不明确时不会重发。',
    parameters: { type: 'object', properties, additionalProperties: false,
      ...(keys.length > 1 ? { oneOf: keys.map(key => ({ required: [key] })) } : { required: keys }) },
  } } }, effect: 'write',
    validate:input=>schema.safeParse(input),
    async execute(input,scope,call){scope.signal.throwIfAborted();return output(await port.send({identity:scope.identity,roundId:scope.roundId,toolCallId:call.id,...args(input),signal:scope.signal}))},
    async reconcile(input,identity,call){return output(await port.recover({identity,roundId:identity.roundId,toolCallId:call.id,...args(input)}))},
  }
}
