import { z } from 'zod'
import type { RunIdentity, ToolCall, ToolResult } from '../index.js'
import type { ToolDefinition } from './contracts.js'
import { strip } from '../../shared/values.js'
import { asciiDecimalDigits, isDecimalDigits } from '../../shared/unicode-decimal.js'
import { extractOfficeText, OFFICE_TEXT_EXTENSIONS, OFFICE_TEXT_MAX_BYTES } from '../../files/office-text.js'

const itemSchema = z.object({ file_id: z.number().int().positive().safe().optional(), file: z.string().max(2048).optional(), attach_id: z.string().trim().min(1).max(256).optional(), target_lines: z.string().default('all'), title: z.string().max(120).optional(), result_id: z.string().max(80).optional() }).strict()
  .refine(value => Number(value.file_id !== undefined) + Number(value.file !== undefined) + Number(value.attach_id !== undefined) === 1)
const inputSchema = z.object({
  file_id: z.number().int().positive().safe().optional(),
  file: z.string().max(2048).optional(),
  attach_id: z.string().trim().min(1).max(256).optional(),
  target_lines: z.string().default('all'),
  items: z.array(itemSchema).min(1).max(20).optional(),
}).strict().refine(value => Number(value.file_id !== undefined) + Number(value.file !== undefined) + Number(value.attach_id !== undefined) + Number(value.items !== undefined) === 1)
const MAX_BYTES = 32 * 1024 * 1024
const MAX_BATCH_BYTES = 64 * 1024 * 1024
const CHAT_ATTACHMENT_TEXT_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'csv', 'yaml', 'yml', 'log', 'py', 'js', 'ts', 'tsx', 'jsx', 'vue', 'html', 'css', 'scss',
  'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp', 'sh', 'sql', 'xml', 'toml', 'ini', 'conf', 'env', 'tex',
])

export interface OwnedTextFile {
  readonly id: number
  readonly name: string
  readonly root: string
  readonly relativePath: string
  /** 领域服务判定文本类型；不得将媒体或需提取的文档标记为文本。 */
  readonly text: boolean
  readonly extensionless: boolean
  readonly extension?: string
}

export interface ReadFilePorts {
  /** 同时验证 owner、会话/群身份、文件 scope、软删除和文件可读权限；不允许仅凭 file_id 返回记录。 */
  resolveOwnedFile(identity: RunIdentity, id: number, signal: AbortSignal): Promise<OwnedTextFile | null>
  /** 只按可信 owner 查询暂存/历史聊天附件；媒体附件由明确的媒体读取能力处理。 */
  resolveOwnedAttachment?(identity: RunIdentity, attachId: string, signal: AbortSignal): Promise<OwnedTextAttachment | null>
  /** 只解析 owner 文件库中的 /personal、/project、/workspace 逻辑路径，不接收宿主路径。 */
  resolveFilePath?(identity: RunIdentity, path: string, signal: AbortSignal): Promise<OwnedTextFile | null>
  /** Host 必须注入 packages/fs 的 openLocalFile，禁止直接打开模型传入的宿主路径。 */
  openFile(root: string, relativePath: string): Promise<{
    size: number
    handle: {
      read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
      close(): Promise<void>
    }
  } | null>
}

export interface OwnedTextAttachment {
  readonly attach_id: string
  readonly name: string
  readonly kind: string
  readonly extension: string
  readonly size_bytes: number
  readonly root: string
  readonly relativePath: string
}

export interface FileFolderDeletePort {
  /** 软删当前 owner 的文件夹子树，并由 Host 文件域写入回收站与 Undo。 */
  remove(identity: RunIdentity, folderId: number, roundId: string, call: ToolCall, signal: AbortSignal): Promise<Record<string, unknown> | { kind: 'unknown' }>
  reconcile?(identity: RunIdentity & { roundId: string }, call: ToolCall): Promise<ToolResult>
}

export interface FileDeletePort {
  /** 只解析当前 owner 已登记的文件库逻辑路径；不得把路径交给宿主文件系统。 */
  resolveFilePath?(identity: RunIdentity, path: string, signal: AbortSignal): Promise<number | null>
  /** 将当前 owner 文件软删除到回收站；Host 在同一事务写入 Agent 收据和 Undo。 */
  remove(identity: RunIdentity, fileId: number, roundId: string, call: ToolCall, signal: AbortSignal): Promise<ToolResult>
  /** 有原子领域操作时按旧版 1-50 个 ID 批量软删除；不得逐项降级。 */
  removeMany?(identity: RunIdentity, fileIds: readonly number[], roundId: string, call: ToolCall, signal: AbortSignal): Promise<ToolResult>
  reconcile?(identity: RunIdentity & { roundId: string }, call: ToolCall): Promise<ToolResult>
}

export interface FilePathCandidate {
  file_id: number
  name: string
  path: string | null
}

export interface FilePathLookup {
  list(identity: RunIdentity, signal: AbortSignal): Promise<readonly FilePathCandidate[]>
}

export interface SaveUploadedFilePort {
  save(identity: RunIdentity, input: {
    source: 'latest' | 'attach_id' | 'attach_ids'
    attach_id?: string
    attach_ids?: readonly string[]
    space: 'personal' | 'project' | 'workspace'
    project_id?: number
    folder_id?: number
  }, roundId: string, call: ToolCall, signal: AbortSignal): Promise<
    | { kind: 'saved'; value: Record<string, unknown>; mutated: boolean }
    | { kind: 'failed'; error: string }
  >
}

const saveUploadedFileSchema = z.object({
  source: z.enum(['latest', 'attach_id', 'attach_ids']).optional(),
  attach_id: z.string().trim().min(1).max(128).optional(),
  attach_ids: z.array(z.string().trim().min(1).max(128)).min(1).max(20).refine(ids => new Set(ids).size === ids.length).optional(),
  space: z.enum(['personal', 'project', 'workspace']).default('personal'),
  project_id: z.number().int().positive().safe().optional(),
  folder_id: z.number().int().positive().safe().optional(),
}).strict().refine(value => {
  if (value.source === 'latest') return value.attach_id === undefined && value.attach_ids === undefined
  if (value.source === 'attach_id') return value.attach_id !== undefined && value.attach_ids === undefined
  if (value.source === 'attach_ids') return value.attach_ids !== undefined && value.attach_id === undefined
  return (value.attach_id !== undefined) !== (value.attach_ids !== undefined)
}).refine(value => (value.space === 'project') === (value.project_id !== undefined))

/** 保存当前 owner 可访问的聊天附件；Workspace 目录由 Host 从可信会话绑定解析。 */
export function createSaveUploadedFileTool(port: SaveUploadedFilePort): ToolDefinition {
  return {
    definition: { name: 'save_uploaded_file', schema: { type: 'function', function: {
      name: 'save_uploaded_file',
      description: '把当前对话中的已授权附件保存到个人、指定项目文件夹或当前会话工作区。工作区目录由会话绑定确定；可精确保存一个或一组 attach_id，也可选择最近的附件；不会覆盖已有文件。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          source: { type: 'string', enum: ['latest', 'attach_id', 'attach_ids'] },
          attach_id: { type: 'string', minLength: 1, maxLength: 128 },
          attach_ids: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } },
          space: { type: 'string', enum: ['personal', 'project', 'workspace'], default: 'personal' },
          project_id: { type: 'integer', minimum: 1 }, folder_id: { type: 'integer', minimum: 1 },
        },
        anyOf: [{ required: ['source'] }, { required: ['attach_id'] }, { required: ['attach_ids'] }],
        not: { required: ['attach_id', 'attach_ids'] },
        oneOf: [
          { properties: { space: { const: 'personal' } }, not: { required: ['project_id'] } },
          { required: ['space', 'project_id'], properties: { space: { const: 'project' } } },
          { required: ['space'], properties: { space: { const: 'workspace' } }, not: { required: ['project_id'] } },
        ],
        allOf: [
          { if: { properties: { source: { const: 'latest' } }, required: ['source'] }, then: { not: { anyOf: [{ required: ['attach_id'] }, { required: ['attach_ids'] }] } } },
          { if: { properties: { source: { const: 'attach_id' } }, required: ['source'] }, then: { required: ['attach_id'], not: { required: ['attach_ids'] } } },
          { if: { properties: { source: { const: 'attach_ids' } }, required: ['source'] }, then: { required: ['attach_ids'], not: { required: ['attach_id'] } } },
          { if: { properties: { space: { const: 'project' } }, required: ['space'] }, then: { required: ['project_id'] } },
          { if: { properties: { space: { const: 'personal' } }, required: ['space'] }, then: { not: { required: ['project_id'] } } },
          { if: { properties: { space: { const: 'workspace' } }, required: ['space'] }, then: { not: { required: ['project_id'] } } },
        ],
      },
    } } },
    effect: 'write',
    validate: input => saveUploadedFileSchema.safeParse(input),
    async execute(input, scope, call) {
      const args = saveUploadedFileSchema.parse(input)
      const source = args.source ?? (args.attach_ids ? 'attach_ids' : 'attach_id')
      scope.signal.throwIfAborted()
      try {
        const outcome = await port.save(scope.identity, { ...args, source }, scope.roundId, call, scope.signal)
        if (outcome.kind === 'failed') return failure(outcome.error)
        return { kind: 'completed', successful: true, mutated: outcome.mutated, value: outcome.value }
      } catch {
        return { kind: 'unknown' }
      }
    },
  }
}

export interface RecentAttachment {
  attach_id: string
  name: string
  ext: string
  kind: string
  platform: string | null
  size_bytes: number
  img_width: number | null
  img_height: number | null
  duration?: number | null
  state: 'draft' | 'attached'
  staged_about?: string
}

export interface RecentAttachmentsPort {
  list(identity: RunIdentity, signal: AbortSignal): Promise<readonly RecentAttachment[]>
}

export interface PresentedFile {
  readonly file_id: number
  readonly name: string
  readonly ext: string
}
export type FilePresentationResolution = { readonly file: PresentedFile } | {
  readonly error: string
  readonly candidates?: readonly Record<string, unknown>[]
}
export interface FilePresentationPort {
  /** Host 只解析当前 owner 已登记的文件，并要求当前 Web Run lease。 */
  resolve(identity: RunIdentity, selector: { readonly file_id?: number; readonly file?: string }, signal: AbortSignal): Promise<FilePresentationResolution>
}

const presentFileSchema = z.object({
  file_id: z.number().int().positive().safe().optional(),
  file: z.string().max(2048).optional(),
}).strict().refine(input => (input.file_id !== undefined) !== (input.file !== undefined))

/** 只把 owner 文件标识交给当前网页预览器；文件读取仍由既有 owner 文件端点执行。 */
export function createPresentFileTool(port: FilePresentationPort): ToolDefinition {
  return {
    definition: { name: 'present_file', schema: { type: 'function', function: {
      name: 'present_file',
      description: '在发起当前对话的网页打开文件预览。可传 file_id、文件库逻辑路径或文件名；不创建聊天附件。',
      parameters: {
        type: 'object', properties: { file_id: { type: 'integer', minimum: 1 }, file: { type: 'string', maxLength: 2048 } },
        oneOf: [{ required: ['file_id'], not: { required: ['file'] } }, { required: ['file'], not: { required: ['file_id'] } }],
        additionalProperties: false,
      },
    } } },
    effect: 'read',
    validate: input => presentFileSchema.safeParse(input),
    async execute(input, scope) {
      const selector = presentFileSchema.parse(input)
      scope.signal.throwIfAborted()
      try {
        const resolved = await port.resolve(scope.identity, selector, scope.signal)
        scope.signal.throwIfAborted()
        if ('error' in resolved) return { kind: 'completed', successful: false, mutated: false,
          value: { error: resolved.error, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) } }
        const { file } = resolved
        const title = file.ext ? `${file.name}.${file.ext}` : file.name
        return { kind: 'completed', successful: true, mutated: false, value: {
          ok: true, message: `已在当前浏览器打开《${title}》。`, file_id: file.file_id, name: file.name, ext: file.ext,
        } }
      } catch {
        scope.signal.throwIfAborted()
        return failure('文件展示失败')
      }
    },
  }
}

const recentAttachmentsSchema = z.object({}).strict()

/** 列出 owner 草稿附件与当前 Web 会话已挂载附件，不读取附件正文或路径。 */
export function createListRecentAttachmentsTool(port: RecentAttachmentsPort): ToolDefinition {
  return {
    definition: { name: 'list_recent_attachments', schema: { type: 'function', function: {
      name: 'list_recent_attachments',
      description: '列出当前账号暂存附件和当前会话近期已挂载附件，返回 attach_id 与媒体元数据。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    } } },
    effect: 'read',
    validate: input => recentAttachmentsSchema.safeParse(input),
    async execute(_input, scope) {
      scope.signal.throwIfAborted()
      try {
        const items = await port.list(scope.identity, scope.signal)
        scope.signal.throwIfAborted()
        return { kind: 'completed', successful: true, mutated: false, value: items.length
          ? { count: items.length, items, note: '已挂载附件可通过 save_uploaded_file 保存到文件库；媒体读取能力由当前 Host 提供。' }
          : { count: 0, items: [], note: '暂存区和当前会话中都没有近期附件' } }
      } catch {
        scope.signal.throwIfAborted()
        return failure('近期附件读取失败')
      }
    },
  }
}
function failure(error: string): ToolResult {
  return { kind: 'completed', value: { error }, successful: false, mutated: false }
}

/** 对齐 Python splitlines(keepends=True)，保留原始物理换行和绝对行号。 */
function selectLines(text: string, target: string) {
  const lines = text.match(/[^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]*(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]|$)/gu)?.filter(line => line !== '') ?? []
  const all = strip(target).toLowerCase() === 'all'
  if (!lines.length && all) return { content: text, numbered_content: '', line_range: { start: 0, end: 0 } }
  const parts = target.split(/[-,]/u).map(strip)
  if (!all && (parts.length > 2 || parts.some(part => !isDecimalDigits(part))))
    return { error: 'target_lines 格式无效，请使用 all、8、8-11 或 8,11' }
  const start = all ? 1 : Number(asciiDecimalDigits(parts[0]!))
  const end = all ? lines.length : Number(asciiDecimalDigits(parts[1] ?? parts[0]!))
  if (start < 1 || end < start || end > lines.length) return { error: `target_lines 超出范围，当前正文共有 ${lines.length} 行` }
  const selected = lines.slice(start - 1, end)
  return { content: all ? text : selected.join(''), numbered_content: selected.map((line, index) => `${start + index}: ${line.replace(/[\r\n]+$/u, '')}`).join('\n'), line_range: { start, end } }
}

/** 只开放 owner 解析后的文件库与聊天附件文本，以及受限 PDF/Office 提取；不接收任意宿主路径、媒体或 URL。 */
export function createReadFileTool(ports: ReadFilePorts): ToolDefinition {
  return {
    definition: { name: 'read_file', schema: { type: 'function', function: {
      name: 'read_file', description: '读取文件库或聊天附件中的 UTF-8 文本，或提取 PDF/Office 正文。文件库可按 file_id、逻辑路径定位；聊天附件使用 attach_id。可按正文行号选择内容并按顺序批量读取最多 20 项。历史图片、音频和视频须由对应媒体能力读取。', parameters: {
        type: 'object', properties: {
          file_id: { type: 'integer', minimum: 1 },
          file: { type: 'string', maxLength: 2048 },
          attach_id: { type: 'string', minLength: 1, maxLength: 256 },
          target_lines: { type: 'string', default: 'all' },
          items: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: {
            file_id: { type: 'integer', minimum: 1 }, file: { type: 'string', maxLength: 2048 }, attach_id: { type: 'string', minLength: 1, maxLength: 256 }, target_lines: { type: 'string', default: 'all' },
            title: { type: 'string', maxLength: 120 }, result_id: { type: 'string', maxLength: 80 },
          }, oneOf: [{ required: ['file_id'], not: { anyOf: [{ required: ['file'] }, { required: ['attach_id'] }] } }, { required: ['file'], not: { anyOf: [{ required: ['file_id'] }, { required: ['attach_id'] }] } }, { required: ['attach_id'], not: { anyOf: [{ required: ['file_id'] }, { required: ['file'] }] } }], additionalProperties: false } },
        }, oneOf: [
          { required: ['file_id'], not: { anyOf: [{ required: ['file'] }, { required: ['attach_id'] }, { required: ['items'] }] } },
          { required: ['file'], not: { anyOf: [{ required: ['file_id'] }, { required: ['attach_id'] }, { required: ['items'] }] } },
          { required: ['attach_id'], not: { anyOf: [{ required: ['file_id'] }, { required: ['file'] }, { required: ['items'] }] } },
          { required: ['items'], not: { anyOf: [{ required: ['file_id'] }, { required: ['file'] }, { required: ['attach_id'] }] } },
        ], additionalProperties: false,
      },
    } } },
    effect: 'read',
    validate(input) { return inputSchema.safeParse(input) },
    async execute(input, scope) {
      const args = inputSchema.parse(input)
      scope.signal.throwIfAborted()
      const readOne = async (selector: { file_id?: number; file?: string; attach_id?: string }, targetLines: string, byteLimit = MAX_BYTES, batch = false): Promise<ToolResult> => {
        try {
          const attachment = selector.attach_id !== undefined
            ? ports.resolveOwnedAttachment
              ? await ports.resolveOwnedAttachment(scope.identity, selector.attach_id, scope.signal)
              : null
            : null
          const file = selector.attach_id !== undefined ? null : selector.file_id !== undefined
            ? await ports.resolveOwnedFile(scope.identity, selector.file_id, scope.signal)
            : selector.file !== undefined && ports.resolveFilePath
              ? await ports.resolveFilePath(scope.identity, selector.file, scope.signal) : null
          scope.signal.throwIfAborted()
          if (selector.attach_id !== undefined && !attachment) return failure('附件不存在或无权访问')
          if (attachment && (attachment.kind !== 'text'
            || (!CHAT_ATTACHMENT_TEXT_EXTENSIONS.has(attachment.extension.toLowerCase())
              && !OFFICE_TEXT_EXTENSIONS.has(attachment.extension.toLowerCase()))))
            return failure('历史附件目前只支持文本和 PDF/Office 正文读取')
          if (!file && !attachment) return failure('文件不存在或无权访问')
          const extension = attachment?.extension ?? file?.extension
          const office = Boolean(extension && OFFICE_TEXT_EXTENSIONS.has(extension.toLowerCase()))
          if (file && !file.text && !file.extensionless && !office) return failure('该文件类型尚不支持读取')
          if (attachment && (!Number.isSafeInteger(attachment.size_bytes) || attachment.size_bytes < 0)) return failure('附件元数据无效')
          if (attachment && office && attachment.size_bytes > Math.min(byteLimit, OFFICE_TEXT_MAX_BYTES)) return failure(batch && byteLimit < OFFICE_TEXT_MAX_BYTES
            ? '本批次剩余容量不足，未读取该附件' : 'Office 文档超过 30MB 提取上限')
          if (attachment && attachment.size_bytes > byteLimit) return failure(batch && byteLimit < MAX_BYTES
            ? '本批次剩余容量不足，未读取该附件' : '附件过大，超出可读上限')
          const source = attachment ?? file!
          const opened = await ports.openFile(source.root, source.relativePath)
          if (!opened) return failure(attachment ? '历史附件不存在，无法读取' : '文件不存在，无法读取')
          try {
            scope.signal.throwIfAborted()
            if (office && opened.size > Math.min(byteLimit, OFFICE_TEXT_MAX_BYTES)) return failure(batch && byteLimit < OFFICE_TEXT_MAX_BYTES
              ? '本批次剩余容量不足，未读取该文件' : 'Office 文档超过 30MB 提取上限')
            if (opened.size > byteLimit) return failure(batch && byteLimit < MAX_BYTES
              ? '本批次剩余容量不足，未读取该文件' : '文件过大，超出可读上限')
            // 多读一字节，防止 stat 后文件增长绕过大小限制。
            const bytes = new Uint8Array(byteLimit + 1)
            let size = 0
            while (size < bytes.length) {
              scope.signal.throwIfAborted()
              const read = await opened.handle.read(bytes, size, Math.min(65536, bytes.length - size), size)
              if (!read.bytesRead) break
              size += read.bytesRead
            }
            scope.signal.throwIfAborted()
            if (size > byteLimit) return failure(batch && byteLimit < MAX_BYTES
              ? '本批次剩余容量不足，未读取该文件' : '文件过大，超出可读上限')
            let text: string
            if (office) {
              try { text = await extractOfficeText(bytes.subarray(0, size), extension!) }
              catch { return failure('Office 文档无法提取文本') }
              scope.signal.throwIfAborted()
            } else {
              const extensionless = file?.extensionless === true
              try { text = new TextDecoder('utf-8', { fatal: extensionless, ignoreBOM: !extensionless }).decode(bytes.subarray(0, size)) }
              catch { return failure('内容不是 UTF-8 文本') }
            }
            if (file?.extensionless && /[\x00-\x08\x0b\x0e-\x1f\x7f-\x9f]/u.test(text)) return failure('内容不是 UTF-8 文本')
            if (!file?.extensionless) {
              let end = 0
              for (let count = 0; count < 200_000 && end < text.length; count++) end += text.codePointAt(end)! > 0xffff ? 2 : 1
              text = text.slice(0, end)
            }
            const selected = selectLines(text, targetLines)
            if ('error' in selected) return failure(selected.error!)
            return { kind: 'completed', value: { ...(attachment ? { attach_id: attachment.attach_id } : { file_id: file!.id }), name: source.name, ...selected, _source_size_bytes: size }, successful: true, mutated: false }
          } finally { await opened.handle.close() }
        } catch {
          scope.signal.throwIfAborted()
          return failure('读取失败')
        }
      }
      if (args.file_id !== undefined || args.file !== undefined || args.attach_id !== undefined)
        return readOne({ file_id: args.file_id, file: args.file, attach_id: args.attach_id }, args.target_lines)
      const results: Array<{ index: number; label: string; successful: boolean; value: unknown }> = []
      let totalBytes = 0, successfulCount = 0
      for (const [offset, item] of args.items!.entries()) {
        scope.signal.throwIfAborted()
        const label = item.title?.trim() || item.result_id?.trim() || (item.file_id !== undefined ? `文件 ${item.file_id}`
          : item.attach_id !== undefined ? `附件 ${item.attach_id}` : item.file!)
        if (totalBytes >= MAX_BATCH_BYTES) {
          results.push({ index: offset + 1, label, successful: false, value: { error: '已达到批次源文件总量上限，后续项目未读取' } })
          continue
        }
        const remaining = MAX_BATCH_BYTES - totalBytes
        const byteLimit = Math.min(MAX_BYTES, remaining)
        const outcome = await readOne({ file_id: item.file_id, file: item.file, attach_id: item.attach_id }, item.target_lines, byteLimit, true)
        if (outcome.kind !== 'completed') continue
        const value: Record<string, unknown> = outcome.value && typeof outcome.value === 'object' && !Array.isArray(outcome.value)
          ? { ...outcome.value as Record<string, unknown> } : { error: '读取失败' }
        const size = typeof value._source_size_bytes === 'number' ? value._source_size_bytes : 0
        delete value._source_size_bytes
        if (outcome.successful) { totalBytes += size; successfulCount++ }
        results.push({ index: offset + 1, label, successful: outcome.successful, value })
      }
      return { kind: 'completed', successful: successfulCount > 0, mutated: false,
        value: { results, successful_count: successfulCount, failed_count: results.length - successfulCount, total_source_size_bytes: totalBytes } }
    },
  }
}

export function createDeleteFolderTool(port: FileFolderDeletePort): ToolDefinition {
  const schema = z.object({ folder_id: z.number().int().positive().safe() }).strict()
  return {
    definition: { name: 'delete_folder', schema: { type: 'function', function: {
      name: 'delete_folder', description: '将指定文件夹及其子文件夹和文件整体移入回收站（30 天内可恢复）。请使用已确认的 folder_id。',
      parameters: { type: 'object', properties: { folder_id: { type: 'integer', minimum: 1 } }, required: ['folder_id'], additionalProperties: false },
    } } },
    effect: 'write', validate(input) { return schema.safeParse(input) },
    async execute(input, scope, call) {
      const { folder_id } = schema.parse(input)
      scope.signal.throwIfAborted()
      try {
        const value = await port.remove(scope.identity, folder_id, scope.roundId, call, scope.signal)
        if (!('success' in value)) return { kind: 'unknown' }
        return { kind: 'completed', successful: true, mutated: true, value }
      } catch (error) {
        scope.signal.throwIfAborted()
        return failure(error instanceof Error && error.message === '文件夹不存在' ? error.message : '文件夹删除失败')
      }
    },
    ...(port.reconcile ? { async reconcile(_input, identity, call) { return port.reconcile!({ ...identity }, call) } } : {}),
  }
}

/** 文件软删除只接受稳定 owner 文件 ID；路径解析与回收站副作用由 Host 文件域负责。 */
export function createDeleteFileTool(port: FileDeletePort): ToolDefinition {
  const schema = z.object({
    file_id: z.number().int().positive().safe().optional(),
    file: z.string().trim().min(1).max(2048).optional(),
    file_ids: z.array(z.number().int().positive().safe()).min(1).max(50).optional(),
  }).strict().refine(value => Number(value.file_id !== undefined) + Number(value.file !== undefined) + Number(value.file_ids !== undefined) === 1
    && (value.file_ids === undefined || new Set(value.file_ids).size === value.file_ids.length))
  return {
    definition: { name: 'delete_file', schema: { type: 'function', function: {
      name: 'delete_file', description: '将指定文件按 file_id 或文件库逻辑路径移入回收站，也可批量传入 1-50 个 file_ids（30 天内可恢复）。批量删除会整体校验，缺失文件时不会删除其他项；此操作不会永久删除。路径只接受 /personal、/project、/workspace 文件库路径，不接受宿主机路径。',
      parameters: { type: 'object', properties: {
        file_id: { type: 'integer', minimum: 1 },
        file: { type: 'string', minLength: 1, maxLength: 2048, description: '/personal、/project 或 /workspace 文件库逻辑路径' },
        file_ids: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
      }, oneOf: [{ required: ['file_id'] }, { required: ['file'] }, { required: ['file_ids'] }], additionalProperties: false },
    } } },
    effect: 'write', validate(input) { return schema.safeParse(input) },
    async execute(input, scope, call) {
      const args = schema.parse(input)
      scope.signal.throwIfAborted()
      try {
        if (args.file_ids && !port.removeMany) return failure('文件批量删除能力不可用')
        if (args.file_id !== undefined) return await port.remove(scope.identity, args.file_id, scope.roundId, call, scope.signal)
        if (args.file !== undefined) {
          const path = args.file
          const parts = path.startsWith('/') && !path.includes('\\') && !path.includes('\0') ? path.slice(1).split('/') : []
          if (parts.length < 2 || !['personal', 'project', 'workspace'].includes(parts[0] ?? '')
            || parts.some(part => !part || part === '.' || part === '..')) return failure('文件路径必须是登记的文件库逻辑路径')
          if (!port.resolveFilePath) return failure('文件库路径解析能力不可用，请改用 file_id')
          const fileId = await port.resolveFilePath(scope.identity, path, scope.signal)
          scope.signal.throwIfAborted()
          if (fileId === null) return failure('文件路径不存在或不唯一；请使用明确的 file_id')
          return await port.remove(scope.identity, fileId, scope.roundId, call, scope.signal)
        }
        return await port.removeMany!(scope.identity, args.file_ids!, scope.roundId, call, scope.signal)
      } catch (error) {
        scope.signal.throwIfAborted()
        return failure(error instanceof Error && error.message === '文件不存在' ? error.message : '文件删除失败')
      }
    },
    ...(port.reconcile ? { async reconcile(_input, identity, call) { return port.reconcile!({ ...identity }, call) } } : {}),
  }
}
