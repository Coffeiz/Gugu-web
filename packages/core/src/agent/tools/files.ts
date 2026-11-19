import { z } from 'zod'
import type { RunIdentity, ToolCall, ToolResult } from '../index.js'
import type { ToolDefinition } from './contracts.js'
import { strip } from '../../shared/values.js'
import { asciiDecimalDigits, isDecimalDigits } from '../../shared/unicode-decimal.js'
import { casefoldSearchText } from '../../search/unicode.js'
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

export interface FileDirectoryQuery {
  readonly space?: 'personal' | 'project' | 'workspace' | 'mind' | 'asset'
  /** 只接受文件库登记路径；与 Shell scope=logical 的本地目录不同。 */
  readonly file_path?: string
  readonly project_id?: number
  readonly workspace_directory_id?: number
  readonly mind_map_id?: number
  readonly folder_id?: number
  readonly kind: 'both' | 'file' | 'folder'
  readonly ext?: string
  readonly q?: string
  readonly queries?: readonly string[]
  readonly mode?: 'OR' | 'AND'
  readonly limit: number
  readonly file_cursor?: string
  readonly folder_cursor?: string
  readonly sort_by: 'name' | 'type' | 'stage' | 'createdAt' | 'size' | 'id'
  readonly sort_order: 'asc' | 'desc'
}
export interface FileDirectoryResult {
  readonly files: readonly Record<string, unknown>[]
  readonly folders: readonly Record<string, unknown>[]
  readonly files_has_more: boolean
  readonly next_file_cursor: string | null
  readonly folders_has_more: boolean
  readonly next_folder_cursor: string | null
  readonly total?: number
}
export interface FileDirectoryPort {
  /** 复用 Host 文件域分页服务，owner 必须来自可信 RunIdentity。 */
  list(identity: RunIdentity, query: FileDirectoryQuery, signal: AbortSignal): Promise<FileDirectoryResult>
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

export interface FileGrepCandidate {
  readonly file_id: number
  readonly name: string
  readonly space: 'personal' | 'project' | 'workspace'
  readonly path: string | null
  readonly project_id: number | null
  readonly folder_id: number | null
  readonly workspace_directory_id: number | null
  readonly size_bytes: number
  readonly is_text: boolean
}
export interface FileGrepPort {
  /** Host 按 owner 与当前 Run 解析所有活动个人/项目/工作区文件及逻辑路径。 */
  list(identity: RunIdentity, signal: AbortSignal): Promise<readonly FileGrepCandidate[]>
  /** 只读取 owner 文件库中的登记文件；不可接收物理路径。 */
  readText(identity: RunIdentity, fileId: number, signal: AbortSignal): Promise<string | null>
}

const grepSchema = z.object({
  query: z.string().min(1).max(500).refine(value => Boolean(value.trim()) && !/[\r\n]/u.test(value)),
  path: z.string().max(2048).optional(),
  context_lines: z.number().int().min(0).max(20).default(2),
  case_sensitive: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
}).strict()
const grepMaxFileBytes = 4 * 1024 * 1024
const grepMaxLineChars = 700
const grepMaxResultBytes = 128 * 1024
const grepReadConcurrency = 8
const grepDataUri = /data:[^,\s]+;base64,[A-Za-z0-9+/=_-]+/giu
const grepLineMarker = '…[行内容已截断]…'
const grepDataMarker = '[内嵌Base64数据已省略]'

function normalizeGrepPath(value: string | undefined): string | null {
  if (value === undefined || value === '') return null
  const text = value.trim()
  if (!text.startsWith('/') || text.includes('\\') || text.includes('\0')) throw new Error('路径必须是 /personal、/project 或 /workspace 下的逻辑路径')
  const parts = text.slice(1).split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('路径不能包含空目录、. 或 ..')
  if (!['personal', 'project', 'workspace'].includes(parts[0] ?? '')) throw new Error('路径只允许 /personal、/project 或 /workspace')
  return `/${parts.join('/')}`
}

function grepUnderPath(path: string, prefix: string | null): boolean {
  return prefix === null || path === prefix || path.startsWith(`${prefix.replace(/\/+$/u, '')}/`)
}

function clipGrepLine(line: string, needle?: string, caseSensitive = false): { text: string; clipped: boolean } {
  if (line.length <= grepMaxLineChars) return { text: line, clipped: false }
  const budget = grepMaxLineChars - grepLineMarker.length
  const haystack = caseSensitive ? line : casefoldSearchText(line)
  const target = needle ? (caseSensitive ? needle : casefoldSearchText(needle)) : ''
  const found = target ? haystack.indexOf(target) : 0
  const start = Math.max(0, (found < 0 ? 0 : found) - Math.max(0, Math.floor((budget - target.length) / 2)))
  const end = Math.min(line.length, start + budget)
  const actualStart = Math.max(0, end - budget)
  const prefix = actualStart ? '…' : ''
  const suffix = end < line.length ? '…' : ''
  const available = grepMaxLineChars - grepLineMarker.length - prefix.length - suffix.length
  const snippetStart = Math.max(0, Math.min(actualStart, line.length - available))
  return { text: `${prefix}${line.slice(snippetStart, snippetStart + available)}${suffix}${grepLineMarker}`, clipped: true }
}

function grepMatch(text: string, candidate: FileGrepCandidate, query: string, contextLines: number, caseSensitive: boolean, remaining: number) {
  const original = text.split(/\r?\n|\r/u)
  grepDataUri.lastIndex = 0
  const lines = original.map(line => line.replace(grepDataUri, grepDataMarker))
  const needle = caseSensitive ? query : casefoldSearchText(query)
  const hits: number[] = []
  for (let index = 0; index < lines.length; index++) {
    const value = caseSensitive ? lines[index]! : casefoldSearchText(lines[index]!)
    if (value.includes(needle)) {
      hits.push(index)
      if (hits.length > remaining) break
    }
  }
  if (!hits.length) return { result: null, matchCount: 0, truncated: false, reasons: [] as string[], stop: false }
  const reasons = new Set<string>()
  if (lines.some((line, index) => line !== original[index])) reasons.add('embedded_data_uri')
  const selected = hits.slice(0, remaining)
  if (selected.length < hits.length) reasons.add('match_limit')
  let clipped = false
  const matches = selected.map(index => {
    const content = clipGrepLine(lines[index]!, query, caseSensitive)
    clipped ||= content.clipped
    const context = []
    for (let at = Math.max(0, index - contextLines); at < Math.min(lines.length, index + contextLines + 1); at++) {
      const snippet = clipGrepLine(lines[at]!)
      clipped ||= snippet.clipped
      context.push({ line: at + 1, text: snippet.text })
    }
    return { line: index + 1, text: content.text, context }
  })
  if (clipped) reasons.add('line_length')
  return { result: { file_id: candidate.file_id, name: candidate.name, space: candidate.space, path: candidate.path,
    project_id: candidate.project_id, folder_id: candidate.folder_id, workspace_directory_id: candidate.workspace_directory_id, matches },
    matchCount: selected.length, truncated: reasons.size > 0, reasons: [...reasons], stop: false }
}

function encodedGrepSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

/** 按逐行字面量搜索已授权文件正文；只访问 Host 提供的 owner-scoped 文件端口。 */
export function createGrepFilesTool(port: FileGrepPort): ToolDefinition {
  return {
    definition: { name: 'grep', schema: { type: 'function', function: {
      name: 'grep', description: '按关键词逐行搜索当前用户有权访问的个人、项目和 Workspace 文本文件；返回逻辑路径、行号、匹配行及可选上下文，不执行 Shell 命令。', parameters: {
        type: 'object', properties: {
          query: { type: 'string', minLength: 1, maxLength: 500 }, path: { type: 'string', maxLength: 2048 },
          context_lines: { type: 'integer', minimum: 0, maximum: 20, default: 2 },
          case_sensitive: { type: 'boolean', default: false }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        }, required: ['query'], additionalProperties: false,
      },
    } } },
    effect: 'read',
    validate(input) { return grepSchema.safeParse(input) },
    async execute(input, scope) {
      const args = grepSchema.parse(input)
      let requestedPath: string | null
      try { requestedPath = normalizeGrepPath(args.path) }
      catch (error) { return failure(error instanceof Error ? error.message : '文件路径无效') }
      scope.signal.throwIfAborted()
      try {
        const candidates = await port.list(scope.identity, scope.signal)
        scope.signal.throwIfAborted()
        let scannedFiles = 0, skippedFiles = 0, totalMatches = 0, truncated = false, stop = false
        const truncationReasons = new Set<string>()
        const results: Array<NonNullable<ReturnType<typeof grepMatch>['result']>> = []
        for (let offset = 0; offset < candidates.length && !stop; offset += grepReadConcurrency) {
          const group = candidates.slice(offset, offset + grepReadConcurrency)
          const batch: Array<{ candidate: FileGrepCandidate; text: string | null } | undefined> = new Array(group.length)
          await Promise.all(group.map(async (candidate, index) => {
            scope.signal.throwIfAborted()
            if (requestedPath && candidate.space !== requestedPath.split('/')[1]) return
            if (!candidate.is_text) { skippedFiles++; return }
            if (candidate.path === null || !grepUnderPath(candidate.path, requestedPath)) return
            scannedFiles++
            if (candidate.size_bytes > grepMaxFileBytes) { skippedFiles++; return }
            try {
              const text = await port.readText(scope.identity, candidate.file_id, scope.signal)
              scope.signal.throwIfAborted()
              batch[index] = { candidate, text }
            } catch {
              scope.signal.throwIfAborted()
              skippedFiles++
            }
          }))
          // Promise.all completes in candidate order even though file reads overlap.
          for (const item of batch) {
            if (!item) continue
            const outcome = grepMatch(item.text ?? '', item.candidate, args.query, args.context_lines, args.case_sensitive, args.limit - totalMatches)
            if (item.text === null) { skippedFiles++; continue }
            if (!outcome.result) continue
            const grouped = [...results, outcome.result]
            while (outcome.result.matches.length && encodedGrepSize(grouped) > grepMaxResultBytes) outcome.result.matches.pop()
            if (outcome.result.matches.length < outcome.matchCount) {
              truncated = true
              truncationReasons.add('result_byte_limit')
            }
            const retained = outcome.result.matches.length
            if (retained) results.push(outcome.result)
            totalMatches += retained
            for (const reason of outcome.reasons) truncationReasons.add(reason)
            truncated ||= outcome.truncated
            if (retained < outcome.matchCount || totalMatches >= args.limit) { stop = true; break }
          }
        }
        return { kind: 'completed', successful: true, mutated: false, value: {
          success: true, query: args.query, path: requestedPath, context_lines: args.context_lines,
          scanned_files: scannedFiles, skipped_files: skippedFiles, matched_files: results.length,
          total_matches: totalMatches, truncated, truncation_reasons: [...truncationReasons].sort(), results,
        } }
      } catch {
        scope.signal.throwIfAborted()
        return failure('文件搜索失败')
      }
    },
  }
}

export interface EditableTextFile {
  readonly id: number
  readonly name: string
  readonly content: string
  readonly version: number
}
export interface FileEditPort {
  /** 解析当前 lease 的 owner 文件及正文；不接受宿主路径。 */
  read(identity: RunIdentity, id: number, signal: AbortSignal): Promise<EditableTextFile | null>
  /** 只解析当前 owner 文件库中的逻辑路径；返回稳定文件 ID。 */
  resolveFilePath?(identity: RunIdentity, path: string, signal: AbortSignal): Promise<number | null>
  /** Host 使用现有文件正文事务服务执行版本 CAS、Undo 与持久化。 */
  update(identity: RunIdentity, id: number, content: string, version: number, signal: AbortSignal): Promise<{ version: number; size_bytes: number }>
}
export interface FileRenamePort {
  /** 只解析当前 owner 已登记的文件库逻辑路径；不接受宿主文件系统路径。 */
  resolveFilePath?(identity: RunIdentity, path: string, signal: AbortSignal): Promise<number | null>
  rename(identity: RunIdentity, id: number, name: string, extension: string | undefined, expectedVersion: number | undefined, roundId: string, call: ToolCall, signal: AbortSignal): Promise<ToolResult>
  reconcile?(identity: RunIdentity & { roundId: string }, call: ToolCall): Promise<ToolResult>
}
export interface FileCopyPort {
  /** 只解析当前 owner 已登记的文件库逻辑路径；不接受宿主文件系统路径。 */
  resolveFilePath?(identity: RunIdentity, path: string, signal: AbortSignal): Promise<number | null>
  copy(identity: RunIdentity, id: number, destination: { space: 'personal' | 'project' | 'workspace'; project_id?: number; workspace_directory_id?: number; folder_id?: number }, roundId: string, call: ToolCall, signal: AbortSignal): Promise<ToolResult>
  reconcile?(identity: RunIdentity & { roundId: string }, call: ToolCall): Promise<ToolResult>
}
export interface FileCreatePort {
  /** 按当前可信会话解析可写工作区目录；不接受模型提供的目录 ID。 */
  resolveWorkspaceDirectory?(identity: RunIdentity, signal: AbortSignal): Promise<number | null>
  create(identity: RunIdentity, input: { filename: string; content: string; space: 'personal' | 'project' | 'workspace'; project_id?: number; workspace_directory_id?: number; folder_id?: number }, roundId: string, call: ToolCall, signal: AbortSignal): Promise<
    | { kind: 'created'; file_id: number; name: string; size_bytes: number; mutated: boolean }
    | { kind: 'failed'; error: string }
    | { kind: 'unknown' }
  >
}
const CREATE_FILE_MAX_BYTES = 256 * 1024
const CREATE_BINARY_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp'])
const createFilename = z.string().trim().min(1).max(300).refine(value => {
  if (/[\\/:*?"<>|\u0000-\u001f]/u.test(value) || value === '.' || value === '..') return false
  const dot = value.lastIndexOf('.')
  return dot >= 0 && dot < value.length - 1 && /^[A-Za-z0-9][A-Za-z0-9._+\-]{0,19}$/u.test(value.slice(dot + 1))
}, '文件名必须包含合法扩展名且不能含路径分隔符')
const createFileFieldsSchema = z.object({
  filename: createFilename,
  content: z.string().max(CREATE_FILE_MAX_BYTES),
  space: z.enum(['personal', 'project', 'workspace']),
  project_id: z.number().int().positive().safe().optional(),
  folder_id: z.number().int().positive().safe().optional(),
}).strict().refine(value => (value.space === 'project') === (value.project_id !== undefined)
  && !(value.space === 'personal' && value.project_id !== undefined))
const createFileSchema = createFileFieldsSchema
const createFileBatchItemSchema = z.object({
  filename: createFilename, content: z.string().max(CREATE_FILE_MAX_BYTES),
  space: z.enum(['personal', 'project', 'workspace']).optional(),
  project_id: z.number().int().positive().safe().optional(), folder_id: z.number().int().positive().safe().optional(),
}).strict()
const createFileBatchSchema = z.object({
  target: z.object({ space: z.enum(['personal', 'project', 'workspace']).optional(),
    project_id: z.number().int().positive().safe().optional(), folder_id: z.number().int().positive().safe().optional() }).strict().optional(),
  files: z.array(createFileBatchItemSchema).min(1).max(20),
}).strict()
const createFileInputSchema = z.union([createFileBatchSchema, createFileSchema])

/** 创建 UTF-8 文本文件，目标空间与持久化副作用由 Host 文件上传服务负责。 */
export function createCreateFileTool(port: FileCreatePort): ToolDefinition {
  return {
    definition: { name: 'create_file', schema: { type: 'function', function: {
      name: 'create_file', description: '在个人、项目或当前会话工作区创建 UTF-8 文本文件；支持最多 20 个文件逐项创建。名称冲突会保留两者，不覆盖现有文件。', parameters: {
        type: 'object',
        oneOf: [
          { type: 'object', properties: {
            filename: { type: 'string', minLength: 1, maxLength: 300 }, content: { type: 'string', maxLength: CREATE_FILE_MAX_BYTES },
            space: { type: 'string', enum: ['personal', 'project', 'workspace'] }, project_id: { type: 'integer', minimum: 1 }, folder_id: { type: 'integer', minimum: 1 },
          }, required: ['filename', 'content', 'space'], additionalProperties: false },
          { type: 'object', properties: {
            target: { type: 'object', properties: { space: { type: 'string', enum: ['personal', 'project', 'workspace'] },
              project_id: { type: 'integer', minimum: 1 }, folder_id: { type: 'integer', minimum: 1 } }, additionalProperties: false },
            files: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: {
              filename: { type: 'string', minLength: 1, maxLength: 300 }, content: { type: 'string', maxLength: CREATE_FILE_MAX_BYTES },
              space: { type: 'string', enum: ['personal', 'project', 'workspace'] }, project_id: { type: 'integer', minimum: 1 }, folder_id: { type: 'integer', minimum: 1 },
            }, required: ['filename', 'content'], additionalProperties: false } },
          }, required: ['files'], additionalProperties: false },
        ],
      },
    } } },
    effect: 'write',
    validate(input) { return createFileInputSchema.safeParse(input) },
    async execute(input, scope, call) {
      const args = createFileInputSchema.parse(input)
      scope.signal.throwIfAborted()
      try {
        const createOne = async (candidate: z.infer<typeof createFileFieldsSchema>, itemCall: ToolCall) => {
          const dot = candidate.filename.lastIndexOf('.')
          const extension = candidate.filename.slice(dot + 1).toLowerCase()
          if (CREATE_BINARY_EXTENSIONS.has(extension)) return { kind: 'failed' as const,
            error: `create_file 只写 UTF-8 文本，不能直接生成 ${extension}；请使用上传文件` }
          if (new TextEncoder().encode(candidate.content).byteLength > CREATE_FILE_MAX_BYTES)
            return { kind: 'failed' as const, error: '文件过大，单文件上限 256KB' }
          let workspaceDirectoryId: number | undefined
          if (candidate.space === 'workspace') {
            workspaceDirectoryId = await port.resolveWorkspaceDirectory?.(scope.identity, scope.signal) ?? undefined
            if (!workspaceDirectoryId) return { kind: 'failed' as const, error: '当前会话没有可写入的工作区目录；请绑定工作区或选择 personal/project' }
          }
          return port.create(scope.identity, { ...candidate, ...(workspaceDirectoryId ? { workspace_directory_id: workspaceDirectoryId } : {}) },
            scope.roundId, itemCall, scope.signal)
        }
        const toResult = (outcome: Awaited<ReturnType<typeof createOne>>, item: unknown) => {
          if (outcome.kind === 'unknown') return { unknown: true as const }
          if (outcome.kind === 'failed') return { error: outcome.error, item }
          return { file_id: outcome.file_id, name: outcome.name, size_bytes: outcome.size_bytes, mutated: outcome.mutated }
        }
        if ('files' in args) {
          const target = args.target ?? {}
          const created: Array<Record<string, unknown>> = [], failed: Array<Record<string, unknown>> = []
          for (const [index, item] of args.files.entries()) {
            scope.signal.throwIfAborted()
            const space = item.space ?? target.space ?? (item.project_id ?? target.project_id ? 'project' : 'personal')
            const projectId = item.project_id ?? target.project_id
            const candidate = { ...item, space, ...(projectId !== undefined ? { project_id: projectId } : {}),
              ...((item.folder_id ?? target.folder_id) !== undefined ? { folder_id: item.folder_id ?? target.folder_id } : {}) }
            const valid = createFileFieldsSchema.safeParse(candidate)
            if (!valid.success) {
              failed.push({ index, name: item.filename, error: '文件目标空间或参数无效' })
              continue
            }
            const itemCall = { ...call, id: `${call.id}:file:${index}`, input: valid.data }
            const result = toResult(await createOne(valid.data, itemCall), item.filename)
            if ('unknown' in result) return { kind: 'unknown' }
            if ('error' in result) failed.push({ index, name: item.filename, error: result.error })
            else created.push({ index, ...result })
          }
          return { kind: 'completed', successful: true, mutated: created.some(item => item.mutated === true), value: {
            success: true, created_count: created.length, failed_count: failed.length, created, failed,
          } }
        }
        const itemCall = { ...call, input: args }
        const outcome = await createOne(args, itemCall)
        if (outcome.kind === 'unknown') return { kind: 'unknown' }
        if (outcome.kind === 'failed') return failure(outcome.error)
        return { kind: 'completed', successful: true, mutated: outcome.mutated,
          value: { file_id: outcome.file_id, name: outcome.name, size_bytes: outcome.size_bytes } }
      } catch {
        return { kind: 'unknown' }
      }
    },
  }
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

export interface FolderCreatePort {
  create(input: { identity: RunIdentity; roundId: string; toolCallId: string;
    args: { folder_name: string; space: 'personal' | 'project' | 'workspace'; project_id?: number; workspace_directory_id?: number; parent_id?: number };
    signal: AbortSignal }): Promise<ToolResult>
  reconcile(input: { identity: RunIdentity; roundId: string; toolCallId: string;
    args: { folder_name: string; space: 'personal' | 'project' | 'workspace'; project_id?: number; workspace_directory_id?: number; parent_id?: number } }): Promise<ToolResult>
}
export interface FolderRenamePort {
  rename(input: { identity: RunIdentity; roundId: string; toolCallId: string; folderId: number; name: string;
    expectedVersion?: number; signal: AbortSignal }): Promise<ToolResult>
  reconcile(input: { identity: RunIdentity; roundId: string; toolCallId: string; folderId: number; name: string;
    expectedVersion?: number }): Promise<ToolResult>
}
export interface FileMoveItemsPort {
  move(identity: RunIdentity, input: {
    files: readonly (number | string)[]
    folders: readonly number[]
    target: { space: 'personal' | 'project'; project_id?: number; folder_id?: number }
  }, signal: AbortSignal): Promise<{
    moved_files: number
    moved_folders: number
    failed_count: number
    files: readonly Record<string, unknown>[]
    folders: readonly Record<string, unknown>[]
    failed: readonly Record<string, unknown>[]
  }>
}

export interface FileArchivePort {
  compress(identity: RunIdentity, input: { entries: Array<{ kind: 'file' | 'folder'; id: number }>; folder_id?: number; archive_name?: string }, roundId: string, call: ToolCall, signal: AbortSignal): Promise<{
    file_id: number; name: string
  } | { kind: 'unknown' }>
  extract(identity: RunIdentity, input: { file_id: number; folder_id?: number; format?: 'zip' | 'tar' | 'tar.gz' | 'tgz' }, roundId: string, call: ToolCall, signal: AbortSignal): Promise<{
    created_count: number; file_count: number; folder_count: number; skipped_count: number; rejected_count: number;
    file_ids: number[]; folder_ids: number[]
  } | { kind: 'unknown' }>
  reconcile?(identity: RunIdentity & { roundId: string }, call: ToolCall): Promise<ToolResult>
}

/** 文件归档工具复用 Host 文件库事务，不解释或执行宿主路径。 */
export function createFileArchiveTools(port: FileArchivePort): ToolDefinition[] {
  const compressSchema = z.object({
    entries: z.array(z.object({ kind: z.enum(['file', 'folder']), id: z.number().int().positive().safe() }).strict()).min(1),
    folder_id: z.number().int().positive().safe().optional(),
    archive_name: z.string().max(300).optional(),
  }).strict()
  const extractSchema = z.object({
    file_id: z.number().int().positive().safe(), folder_id: z.number().int().positive().safe().optional(),
    format: z.enum(['zip', 'tar', 'tar.gz', 'tgz']).optional(),
  }).strict()
  return [
    {
      definition: { name: 'compress_files', schema: { type: 'function', function: {
        name: 'compress_files', description: '把文件库中的文件或文件夹打包成 ZIP。entries 明确区分文件和文件夹，所有条目须属于同一空间；源内容上限 512MB，不覆盖已有文件，重名自动追加序号。',
        parameters: { type: 'object', properties: {
          entries: { type: 'array', minItems: 1, items: { type: 'object', properties: { kind: { type: 'string', enum: ['file', 'folder'] }, id: { type: 'integer', minimum: 1 } }, required: ['kind', 'id'], additionalProperties: false } },
          folder_id: { type: 'integer', minimum: 1 }, archive_name: { type: 'string', maxLength: 300 },
        }, required: ['entries'], additionalProperties: false },
      } } },
      effect: 'write', validate(input) { return compressSchema.safeParse(input) },
      async execute(input, scope, call) {
        const args = compressSchema.parse(input)
        scope.signal.throwIfAborted()
        try {
          const value = await port.compress(scope.identity, args, scope.roundId, call, scope.signal)
          if (!('file_id' in value)) return { kind: 'unknown' }
          return { kind: 'completed', successful: true, mutated: true, value: { success: true, ...value } }
        } catch (error) {
          scope.signal.throwIfAborted()
          return failure(error instanceof Error && error.message.length <= 160 ? error.message : '文件压缩失败')
        }
      },
      ...(port.reconcile ? { async reconcile(_input, identity, call) { return port.reconcile!({ ...identity }, call) } } : {}),
    },
    {
      definition: { name: 'extract_files', schema: { type: 'function', function: {
        name: 'extract_files', description: '把文件库中的 ZIP/TAR/TAR.GZ 解压到指定文件夹。最多 10,000 个条目，受 2GB 安全上限和用户剩余配额约束；压缩包保留不动，重名自动追加序号。',
        parameters: { type: 'object', properties: {
          file_id: { type: 'integer', minimum: 1 }, folder_id: { type: 'integer', minimum: 1 },
          format: { type: 'string', enum: ['zip', 'tar', 'tar.gz', 'tgz'] },
        }, required: ['file_id'], additionalProperties: false },
      } } },
      effect: 'write', validate(input) { return extractSchema.safeParse(input) },
      async execute(input, scope, call) {
        const args = extractSchema.parse(input)
        scope.signal.throwIfAborted()
        try {
          const result = await port.extract(scope.identity, args, scope.roundId, call, scope.signal)
          if (!('created_count' in result)) return { kind: 'unknown' }
          return { kind: 'completed', successful: true, mutated: result.created_count > 0, value: {
            success: true, ...result, file_ids: result.file_ids.slice(0, 100), folder_ids: result.folder_ids.slice(0, 100),
            ids_truncated: result.file_ids.length > 100 || result.folder_ids.length > 100,
          } }
        } catch (error) {
          scope.signal.throwIfAborted()
          return failure(error instanceof Error && error.message.length <= 160 ? error.message : '文件解压失败')
        }
      },
      ...(port.reconcile ? { async reconcile(_input, identity, call) { return port.reconcile!({ ...identity }, call) } } : {}),
    },
  ]
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
const folderCreateSchema = z.object({
  folder_name: z.string().trim().min(1).max(255),
  space: z.enum(['personal', 'project', 'workspace']),
  project_id: z.number().int().positive().safe().optional(),
  workspace_directory_id: z.number().int().positive().safe().optional(),
  parent_id: z.number().int().positive().safe().optional(),
}).strict().refine(value => (value.space === 'project') === (value.project_id !== undefined)
  && (value.space === 'workspace') === (value.workspace_directory_id !== undefined)
  && !(value.project_id && value.workspace_directory_id)
  && !/[\\/:*?"<>|\u0000-\u001f]/u.test(value.folder_name) && value.folder_name !== '.' && value.folder_name !== '..')

/** 文件夹创建只接受明确空间和直接父目录，由 Host 文件域执行 owner 校验与 Undo。 */
export function createCreateFolderTool(port: FolderCreatePort): ToolDefinition {
  return {
    definition: { name: 'create_folder', schema: { type: 'function', function: {
      name: 'create_folder', description: '在明确的个人、项目或工作区空间中创建子文件夹。父文件夹必须属于同一目标空间。', parameters: {
        type: 'object', properties: {
          folder_name: { type: 'string', minLength: 1, maxLength: 255 }, space: { type: 'string', enum: ['personal', 'project', 'workspace'] },
          project_id: { type: 'integer', minimum: 1 }, workspace_directory_id: { type: 'integer', minimum: 1 }, parent_id: { type: 'integer', minimum: 1 },
        }, required: ['folder_name', 'space'], additionalProperties: false,
      },
    } } },
    effect: 'write',
    validate(input) { return folderCreateSchema.safeParse(input) },
    async execute(input, scope, call) {
      const args = folderCreateSchema.parse(input)
      scope.signal.throwIfAborted()
      try {
        return await port.create({ identity: scope.identity, roundId: scope.roundId, toolCallId: call.id, args, signal: scope.signal })
      } catch {
        return { kind: 'unknown' }
      }
    },
    reconcile(input, identity, call) {
      return port.reconcile({ identity, roundId: identity.roundId, toolCallId: call.id, args: folderCreateSchema.parse(input) })
    },
  }
}

const folderRenameSchema = z.object({
  folder_id: z.number().int().positive().safe(),
  new_folder_name: z.string().trim().min(1).max(255),
  expected_version: z.number().int().positive().safe().optional(),
}).strict().refine(value => value.new_folder_name !== '.' && value.new_folder_name !== '..'
  && !/[\\/:*?"<>|\u0000-\u001f]/u.test(value.new_folder_name))

/** 通过稳定 ID 重命名文件夹，Host 复用 owner 校验、版本 CAS 与 PathMirror。 */
export function createRenameFolderTool(port: FolderRenamePort): ToolDefinition {
  return {
    definition: { name: 'rename_folder', schema: { type: 'function', function: {
      name: 'rename_folder', description: '通过 folder_id 重命名文件夹。新名称不能包含路径分隔符或与同级文件夹冲突。', parameters: {
        type: 'object', properties: {
          folder_id: { type: 'integer', minimum: 1 }, new_folder_name: { type: 'string', minLength: 1, maxLength: 255 },
          expected_version: { type: 'integer', minimum: 1 },
        }, required: ['folder_id', 'new_folder_name'], additionalProperties: false,
      },
    } } },
    effect: 'write',
    validate(input) { return folderRenameSchema.safeParse(input) },
    async execute(input, scope, call) {
      const args = folderRenameSchema.parse(input)
      scope.signal.throwIfAborted()
      try {
        return await port.rename({ identity: scope.identity, roundId: scope.roundId, toolCallId: call.id,
          folderId: args.folder_id, name: args.new_folder_name, expectedVersion: args.expected_version, signal: scope.signal })
      } catch (error) {
        if (scope.signal.aborted) throw scope.signal.reason ?? new Error('重命名已取消')
        return { kind: 'unknown' }
      }
    },
    reconcile(input, identity, call) {
      const args = folderRenameSchema.parse(input)
      return port.reconcile({ identity, roundId: identity.roundId, toolCallId: call.id,
        folderId: args.folder_id, name: args.new_folder_name, expectedVersion: args.expected_version })
    },
  }
}

const moveItemsSchema = z.object({
  files: z.array(z.union([z.number().int().positive().safe(), z.string().trim().min(1).max(2048)])).max(50).default([]),
  folders: z.array(z.number().int().positive().safe()).max(50).default([]),
  target: z.object({
    space: z.enum(['personal', 'project']),
    project_id: z.number().int().positive().safe().optional(),
    folder_id: z.number().int().positive().safe().optional(),
  }).strict().refine(value => (value.space === 'project') === (value.project_id !== undefined)),
}).strict().refine(value => value.files.every(file => typeof file !== 'string' || (() => {
  const parts = file.startsWith('/') && !file.includes('\\') && !file.includes('\0') ? file.slice(1).split('/') : []
  return parts.length >= 2 && ['personal', 'project', 'workspace'].includes(parts[0] ?? '')
    && parts.every(part => part && part !== '.' && part !== '..')
})()) && value.files.length + value.folders.length > 0
  && value.files.length + value.folders.length <= 50)

/** 按明确 ID 将文件/文件夹移动到个人或项目空间；逐项报告部分失败。 */
export function createMoveItemsTool(port: FileMoveItemsPort): ToolDefinition {
  return {
    definition: { name: 'move_items', schema: { type: 'function', function: {
      name: 'move_items', description: '按文件 ID 或 list_dir 返回的文件库逻辑路径，以及文件夹 ID，移动到明确的个人或项目空间。文件夹会连同后代一起移动；每项分别报告结果。', parameters: {
        type: 'object', properties: {
          files: { type: 'array', maxItems: 50, items: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', minLength: 1, maxLength: 2048 }] } },
          folders: { type: 'array', maxItems: 50, items: { type: 'integer', minimum: 1 } },
          target: { type: 'object', properties: {
            space: { type: 'string', enum: ['personal', 'project'] }, project_id: { type: 'integer', minimum: 1 }, folder_id: { type: 'integer', minimum: 1 },
          }, required: ['space'], additionalProperties: false },
        }, required: ['target'], additionalProperties: false,
      },
    } } },
    effect: 'write',
    validate(input) { return moveItemsSchema.safeParse(input) },
    async execute(input, scope) {
      const args = moveItemsSchema.parse(input)
      scope.signal.throwIfAborted()
      try {
        const result = await port.move(scope.identity, args, scope.signal)
        return { kind: 'completed', successful: true, mutated: result.moved_files + result.moved_folders > 0, value: result }
      } catch {
        if (scope.signal.aborted) throw scope.signal.reason ?? new Error('移动已取消')
        return { kind: 'unknown' }
      }
    },
  }
}
const copySchema = z.object({
  file_id: z.number().int().positive().safe().optional(),
  file: z.string().trim().min(1).max(2048).optional(),
  space: z.enum(['personal', 'project', 'workspace']),
  project_id: z.number().int().positive().safe().optional(),
  workspace_directory_id: z.number().int().positive().safe().optional(),
  folder_id: z.number().int().positive().safe().optional(),
}).strict().refine(value => (value.file_id !== undefined) !== (value.file !== undefined)
  && (value.space === 'project') === (value.project_id !== undefined)
  && (value.space === 'workspace') === (value.workspace_directory_id !== undefined)
  && !(value.project_id && value.workspace_directory_id))

/** 文件复制目标必须是明确的个人、项目或工作区空间；只开放保留两者。 */
export function createCopyFileTool(port: FileCopyPort): ToolDefinition {
  return {
    definition: { name: 'copy_file', schema: { type: 'function', function: {
      name: 'copy_file', description: '按 file_id 或 list_dir 返回的 /personal、/project、/workspace 文件库逻辑路径定位源文件，并复制到明确指定的个人、项目或工作区空间。复制总是保留源文件和已有目标，不执行覆盖。', parameters: {
        type: 'object', properties: {
          file_id: { type: 'integer', minimum: 1 }, file: { type: 'string', minLength: 1, maxLength: 2048 }, space: { type: 'string', enum: ['personal', 'project', 'workspace'] },
          project_id: { type: 'integer', minimum: 1 }, workspace_directory_id: { type: 'integer', minimum: 1 }, folder_id: { type: 'integer', minimum: 1 },
        }, required: ['space'], oneOf: [{ required: ['file_id'] }, { required: ['file'] }], additionalProperties: false,
      },
    } } },
    effect: 'write',
    validate(input) { return copySchema.safeParse(input) },
    async execute(input, scope, call) {
      const args = copySchema.parse(input)
      scope.signal.throwIfAborted()
      try {
        let fileId = args.file_id
        if (fileId === undefined) {
          const path = args.file!
          const parts = path.startsWith('/') && !path.includes('\\') && !path.includes('\0') ? path.slice(1).split('/') : []
          if (parts.length < 2 || !['personal', 'project', 'workspace'].includes(parts[0] ?? '')
            || parts.some(part => !part || part === '.' || part === '..')) return failure('文件路径必须是登记的文件库逻辑路径')
          if (!port.resolveFilePath) return failure('文件库路径解析能力不可用，请改用 file_id')
          fileId = (await port.resolveFilePath(scope.identity, path, scope.signal)) ?? undefined
          scope.signal.throwIfAborted()
          if (fileId === undefined) return failure('文件路径不存在或不唯一；请用 list_dir 确认')
        }
        return await port.copy(scope.identity, fileId, {
          space: args.space,
          ...(args.project_id !== undefined ? { project_id: args.project_id } : {}),
          ...(args.workspace_directory_id !== undefined ? { workspace_directory_id: args.workspace_directory_id } : {}),
          ...(args.folder_id !== undefined ? { folder_id: args.folder_id } : {}),
        }, scope.roundId, call, scope.signal)
      } catch {
        return { kind: 'unknown' }
      }
    },
    ...(port.reconcile ? { reconcile(_input, identity, call) { return port.reconcile!(identity, call) } } : {}),
  }
}
const renameOneSchema = z.object({
  file_id: z.number().int().positive().safe().optional(),
  file: z.string().trim().min(1).max(2048).optional(),
  new_name: z.string().trim().min(1).max(300),
  format: z.string().min(1).max(20).regex(/^[A-Za-z0-9][A-Za-z0-9._+\-]{0,19}$/u).optional(),
  expected_version: z.number().int().positive().safe().optional(),
}).strict().refine(input => (input.file_id !== undefined) !== (input.file !== undefined)
  && !/[\\/:*?"<>|\u0000-\u001f]/u.test(input.new_name) && input.new_name !== '.' && input.new_name !== '..')
const renameBatchSchema = z.object({ renames: z.array(renameOneSchema).min(1).max(50) }).strict()
const renameInputSchema = z.union([renameOneSchema, renameBatchSchema])

const renameExtensionAliases: Record<string, readonly string[]> = {
  md: ['markdown', 'md'], txt: ['text', 'txt'], yaml: ['yaml', 'yml'],
  json: ['json'], csv: ['csv'], tsv: ['tsv'], docx: ['docx'], pdf: ['pdf'], xlsx: ['xlsx'],
}
function renameNameParts(name: string, format?: string): { displayName: string; extension?: string } | null {
  if (format !== undefined) {
    const requested = format.toLowerCase()
    const extension = ({ markdown: 'md', md: 'md', text: 'txt', txt: 'txt', yml: 'yaml', yaml: 'yaml' } as Record<string, string>)[requested] ?? requested
    const aliases = [...(renameExtensionAliases[extension] ?? [extension])].sort((a, b) => b.length - a.length)
    let displayName = name
    while (true) {
      const alias = aliases.find(candidate => displayName.toLowerCase().endsWith(`.${candidate}`))
      if (!alias) break
      displayName = displayName.slice(0, -(alias.length + 1))
    }
    return { displayName, extension }
  }
  const dot = name.lastIndexOf('.')
  if (dot < 0) return { displayName: name }
  const displayName = name.slice(0, dot), extension = name.slice(dot + 1).toLowerCase()
  if (!/^[A-Za-z0-9][A-Za-z0-9._+\-]{0,19}$/u.test(extension)) return null
  return { displayName, extension }
}

/** 文件名修改委托给 Host 现有文件域事务，避免工具自行计算存储路径。 */
export function createRenameFileTool(port: FileRenamePort): ToolDefinition {
  return {
    definition: { name: 'rename_file', schema: { type: 'function', function: {
      name: 'rename_file', description: '重命名 owner 文件库中的文件，可用 file_id 或 list_dir 返回的登记路径定位。new_name 含后缀时修改完整文件名，不含点时保留原后缀；format 可显式指定后缀。修改后缀不会转换内容或 MIME，Host 负责类型边界、路径规划、版本 CAS 与 Undo。', parameters: {
        type: 'object', properties: {
          file_id: { type: 'integer', minimum: 1 }, file: { type: 'string', minLength: 1, maxLength: 2048 },
          new_name: { type: 'string', minLength: 1, maxLength: 300 },
          format: { type: 'string', minLength: 1, maxLength: 20, pattern: '^[A-Za-z0-9][A-Za-z0-9._+\\-]{0,19}$' },
          expected_version: { type: 'integer', minimum: 1 },
          renames: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', properties: {
            file_id: { type: 'integer', minimum: 1 }, file: { type: 'string', minLength: 1, maxLength: 2048 },
            new_name: { type: 'string', minLength: 1, maxLength: 300 },
            format: { type: 'string', minLength: 1, maxLength: 20, pattern: '^[A-Za-z0-9][A-Za-z0-9._+\\-]{0,19}$' },
            expected_version: { type: 'integer', minimum: 1 },
          }, required: ['new_name'], oneOf: [{ required: ['file_id'] }, { required: ['file'] }], additionalProperties: false } },
        }, oneOf: [
          { required: ['renames'], not: { anyOf: [{ required: ['file_id'] }, { required: ['file'] }, { required: ['new_name'] }, { required: ['format'] }, { required: ['expected_version'] }] } },
          { required: ['new_name'], oneOf: [{ required: ['file_id'] }, { required: ['file'] }], not: { required: ['renames'] } },
        ], additionalProperties: false,
      },
    } } },
    effect: 'write',
    validate(input) { return renameInputSchema.safeParse(input) },
    async execute(input, scope, call) {
      const args = renameInputSchema.parse(input)
      scope.signal.throwIfAborted()
      const renameOne = async (item: z.infer<typeof renameOneSchema>, itemCall: ToolCall): Promise<ToolResult> => {
        try {
          if (port.reconcile) {
            const recovered = await port.reconcile({ ...scope.identity, roundId: scope.roundId }, itemCall)
            if (recovered.kind !== 'unknown') return recovered
          }
          const parts = renameNameParts(item.new_name, item.format)
          if (!parts) return failure('文件名必须包含合法扩展名')
          let fileId = item.file_id
          if (fileId === undefined) {
            const path = item.file!
            const pathParts = path.startsWith('/') && !path.includes('\\') && !path.includes('\0') ? path.slice(1).split('/') : []
            if (pathParts.length < 2 || !['personal', 'project', 'workspace'].includes(pathParts[0] ?? '')
              || pathParts.some(part => !part || part === '.' || part === '..')) return failure('文件路径必须是登记的文件库逻辑路径')
            if (!port.resolveFilePath) return failure('文件库路径解析能力不可用，请改用 file_id')
            fileId = (await port.resolveFilePath(scope.identity, path, scope.signal)) ?? undefined
            scope.signal.throwIfAborted()
            if (fileId === undefined) return failure('文件路径不存在或不唯一；请用 list_dir 确认')
          }
          return await port.rename(scope.identity, fileId, parts.displayName, parts.extension, item.expected_version, scope.roundId, itemCall, scope.signal)
        } catch (error) {
          const message = error instanceof Error ? error.message : ''
          if (message === '文件已被其他端修改，请刷新后重试' || message === '文件名未变化') return failure(message)
          return { kind: 'unknown' }
        }
      }
      if ('renames' in args) {
        const renamed: Array<Record<string, unknown>> = [], failed: Array<Record<string, unknown>> = []
        for (const [index, item] of args.renames.entries()) {
          scope.signal.throwIfAborted()
          const itemCall = { ...call, id: `${call.id}:${index}`, input: item }
          const result = await renameOne(item, itemCall)
          if (result.kind === 'unknown') return result
          if (result.kind !== 'completed') return { kind: 'unknown' }
          if (result.successful) renamed.push({ index, ...(result.value as Record<string, unknown>) })
          else failed.push({ item: item.file ?? item.file_id, error: (result.value as Record<string, unknown>)?.error ?? '文件重命名失败' })
        }
        return { kind: 'completed', successful: true, mutated: renamed.length > 0, value: {
          success: true, renamed_count: renamed.length, failed_count: failed.length, renamed, failed,
        } }
      }
      return await renameOne(args, call)
    },
    ...(port.reconcile ? { reconcile(input, identity, call) {
      return 'renames' in (input as Record<string, unknown>) ? Promise.resolve({ kind: 'unknown' })
        : port.reconcile!(identity, call)
    } } : {}),
  }
}

const editLineSchema = z.object({
  target_lines: z.string().max(64), content: z.string().max(1024 * 1024), expected: z.string().max(1024 * 1024).optional(),
}).strict()
const EDIT_FILE_MAX_BYTES = 256 * 1024
const editFieldsSchema = z.object({
  mode: z.enum(['replace', 'append', 'find_replace', 'line_edit']).optional(),
  operation: z.enum(['replace', 'append', 'replace_text']).optional(),
  content: z.string().max(1024 * 1024).optional(),
  find: z.string().min(1).max(1024 * 1024).optional(),
  replace: z.string().max(1024 * 1024).optional(),
  old_text: z.string().min(1).max(1024 * 1024).optional(),
  new_text: z.string().max(1024 * 1024).optional(),
  line_edits: z.array(editLineSchema).min(1).max(50).optional(),
  expected_version: z.number().int().positive().safe().optional(),
  replace_all: z.boolean().default(false),
}).strict()
function validateEditSpec(input: z.infer<typeof editFieldsSchema>, context: z.RefinementCtx, allowMissingMode = false) {
  const mode = input.mode ?? (input.operation === 'replace_text' ? 'find_replace' : input.operation)
  if (!mode) {
    if (!allowMissingMode) context.addIssue({ code: 'custom', message: '需要指定编辑 mode' })
    return
  }
  if (input.mode && input.operation) context.addIssue({ code: 'custom', message: 'mode 与 operation 不能同时提供' })
  const hasContent = input.content !== undefined, hasFind = input.find !== undefined || input.old_text !== undefined
  const hasReplace = input.replace !== undefined || input.new_text !== undefined, hasLines = input.line_edits !== undefined
  if (input.find !== undefined && input.old_text !== undefined || input.replace !== undefined && input.new_text !== undefined)
    context.addIssue({ code: 'custom', message: '编辑字段重复' })
  if (mode === 'replace' || mode === 'append') {
    if (!hasContent || hasFind || hasReplace || hasLines) context.addIssue({ code: 'custom', message: '编辑参数与操作类型不匹配' })
  } else if (mode === 'find_replace') {
    if (hasContent || !hasFind || !hasReplace || hasLines || input.replace_all && input.find !== undefined)
      context.addIssue({ code: 'custom', message: '编辑参数与操作类型不匹配' })
  } else if (hasContent || hasFind || hasReplace || !hasLines || input.replace_all)
    context.addIssue({ code: 'custom', message: '编辑参数与操作类型不匹配' })
}
const editItemSchema = editFieldsSchema.extend({
  file_id: z.number().int().positive().safe().optional(), file: z.string().min(1).max(2048).optional(),
})
const editSchema = editFieldsSchema.extend({
  file_id: z.number().int().positive().safe().optional(), file: z.string().min(1).max(2048).optional(),
  edits: z.array(editItemSchema).min(1).max(20).optional(),
}).superRefine((input, context) => {
  if (input.edits === undefined && (input.file_id !== undefined) === (input.file !== undefined))
    context.addIssue({ code: 'custom', message: '必须且只能指定 file_id 或 file' })
  if (input.edits !== undefined && input.file_id !== undefined && input.file !== undefined)
    context.addIssue({ code: 'custom', message: 'file_id 与 file 不能同时提供' })
  if (input.edits !== undefined && (input.content !== undefined || input.find !== undefined || input.replace !== undefined
    || input.old_text !== undefined || input.new_text !== undefined || input.line_edits !== undefined
    || input.replace_all || input.expected_version !== undefined)) context.addIssue({ code: 'custom', message: '批量编辑不能与顶层编辑内容混用' })
  if (input.edits === undefined) validateEditSpec(input, context)
  else for (const item of input.edits) {
    const targetCount = Number(item.file_id !== undefined) + Number(item.file !== undefined)
    if (targetCount > 1) context.addIssue({ code: 'custom', message: '每项只能指定 file_id 或 file' })
    if (targetCount === 0 && input.file_id === undefined && input.file === undefined)
      context.addIssue({ code: 'custom', message: '每项必须指定 file_id 或 file，或提供顶层默认目标' })
    const merged = { ...input, ...item }
    validateEditSpec(merged, context, true)
    if (!merged.mode && !merged.operation) context.addIssue({ code: 'custom', message: '需要指定编辑 mode' })
  }
})

function countMatches(text: string, needle: string): number {
  let count = 0, offset = 0
  while ((offset = text.indexOf(needle, offset)) !== -1) { count++; offset += needle.length }
  return count
}

function editLines(text: string, edits: readonly z.infer<typeof editLineSchema>[]): { text: string; changedLines: number } | { error: string } {
  const lines = text.match(/[^\r\n\v\f\x1c-\x1e\x85\u2028\u2029]*(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]|$)/gu)?.filter(line => line !== '') ?? []
  const parsed: Array<{ start: number; end: number; content: string; expected?: string }> = []
  for (const edit of edits) {
    const target = edit.target_lines.trim()
    let start: number, end: number
    if (target.toLowerCase() === 'all') { start = 1; end = lines.length }
    else {
      const match = /^([\p{Nd}]+)(?:\s*[-,]\s*([\p{Nd}]+))?$/u.exec(target)
      if (!match) return { error: 'target_lines 格式无效，请使用 all、8、8-11 或 8,11' }
      start = Number(asciiDecimalDigits(match[1]!)); end = Number(asciiDecimalDigits(match[2] ?? match[1]!))
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lines.length)
        return { error: `target_lines 超出范围，当前正文共有 ${lines.length} 行` }
      if (edit.expected === undefined) return { error: '数字行编辑必须提供 expected 原文，请先读取最新正文并按原始物理行号定位' }
    }
    parsed.push({ start, end, content: edit.content, ...(edit.expected !== undefined ? { expected: edit.expected } : {}) })
  }
  const ordered = [...parsed].sort((left, right) => right.start - left.start)
  for (let index = 0; index + 1 < ordered.length; index++) {
    if (ordered[index + 1]!.end >= ordered[index]!.start) return { error: 'line_edits 的目标行范围不能重叠' }
  }
  const normalize = (value: string) => value.replace(/\r\n|\r/gu, '\n').replace(/\n+$/u, '')
  for (const edit of ordered) {
    const old = lines.slice(edit.start - 1, edit.end)
    if (edit.expected !== undefined && normalize(old.join('')) !== normalize(edit.expected))
      return { error: `target_lines ${edit.start}-${edit.end} 的原文校验失败；正文可能已变化，请重新读取后再编辑` }
    let replacement = edit.content
    if (replacement && old.length && /(?:\n|\r)$/u.test(old[old.length - 1]!) && !/(?:\n|\r)$/u.test(replacement)) replacement += '\n'
    const replacementLines = replacement.match(/[^\r\n\v\f\x1c-\x1e\x85\u2028\u2029]*(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]|$)/gu)?.filter(line => line !== '') ?? []
    lines.splice(edit.start - 1, edit.end - edit.start + 1, ...replacementLines)
  }
  return { text: lines.join(''), changedLines: parsed.reduce((total, edit) => total + edit.end - edit.start + 1, 0) }
}

/** 通过 owner 文件 ID 或逻辑路径编辑文本，保存复用 Host 版本 CAS 与 Undo 服务。 */
export function createEditFileTool(port: FileEditPort): ToolDefinition {
  return {
    definition: { name: 'edit_file', schema: { type: 'function', function: {
      name: 'edit_file', description: '按 file_id 或 /personal、/project、/workspace 逻辑路径编辑文本。支持全文替换、追加、查找替换、按行替换/删除及最多 20 项逐项结果批量编辑；数字行编辑必须提供 expected 原文。', parameters: {
        type: 'object', properties: {
          file_id: { type: 'integer', minimum: 1 }, file: { type: 'string', minLength: 1, maxLength: 2048 },
          mode: { type: 'string', enum: ['replace', 'append', 'find_replace', 'line_edit'] },
          operation: { type: 'string', enum: ['replace', 'append', 'replace_text'] },
          expected_version: { type: 'integer', minimum: 1 }, content: { type: 'string', maxLength: 1048576 },
          find: { type: 'string', minLength: 1, maxLength: 1048576 }, replace: { type: 'string', maxLength: 1048576 },
          old_text: { type: 'string', minLength: 1, maxLength: 1048576 }, new_text: { type: 'string', maxLength: 1048576 },
          replace_all: { type: 'boolean', default: false },
          line_edits: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', properties: {
            target_lines: { type: 'string', maxLength: 64 }, content: { type: 'string', maxLength: 1048576 }, expected: { type: 'string', maxLength: 1048576 },
          }, required: ['target_lines', 'content'], additionalProperties: false } },
          edits: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: {
            file_id: { type: 'integer', minimum: 1 }, file: { type: 'string', minLength: 1, maxLength: 2048 },
            mode: { type: 'string', enum: ['replace', 'append', 'find_replace', 'line_edit'] }, operation: { type: 'string', enum: ['replace', 'append', 'replace_text'] },
            expected_version: { type: 'integer', minimum: 1 }, content: { type: 'string', maxLength: 1048576 },
            find: { type: 'string', minLength: 1, maxLength: 1048576 }, replace: { type: 'string', maxLength: 1048576 },
            old_text: { type: 'string', minLength: 1, maxLength: 1048576 }, new_text: { type: 'string', maxLength: 1048576 },
            replace_all: { type: 'boolean', default: false },
            line_edits: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', properties: {
              target_lines: { type: 'string', maxLength: 64 }, content: { type: 'string', maxLength: 1048576 }, expected: { type: 'string', maxLength: 1048576 },
            }, required: ['target_lines', 'content'], additionalProperties: false } },
          }, additionalProperties: false } },
        }, additionalProperties: false,
      },
    } } },
    effect: 'write',
    validate(input) { return editSchema.safeParse(input) },
    async execute(input, scope) {
      const args = editSchema.parse(input)
      scope.signal.throwIfAborted()
      const modeFor = (spec: z.infer<typeof editFieldsSchema>) => spec.mode
        ?? (spec.operation === 'replace_text' ? 'find_replace' : spec.operation)
      const resolve = async (target: { file_id?: number; file?: string }) => {
        if (target.file_id !== undefined) return target.file_id
        if (!target.file || !port.resolveFilePath) return null
        return port.resolveFilePath(scope.identity, target.file, scope.signal)
      }
      const apply = async (target: { file_id?: number; file?: string }, spec: z.infer<typeof editFieldsSchema>) => {
        const mode = modeFor(spec)
        if (!mode) return { error: '需要指定编辑 mode' }
        const id = await resolve(target)
        scope.signal.throwIfAborted()
        if (id === null) return { error: '文件不存在或无权访问' }
        const current = await port.read(scope.identity, id, scope.signal)
        scope.signal.throwIfAborted()
        if (!current) return { error: '文件不存在或无权访问' }
        if (spec.expected_version !== undefined && spec.expected_version !== current.version)
          return { error: '文件已被其他端修改，请刷新后重试' }
        let content: string
        let change: string | undefined
        if (mode === 'replace') { content = spec.content!; change = `整体替换为 ${Array.from(content).length} 字` }
        else if (mode === 'append') { content = current.content + spec.content!; change = `末尾追加 ${Array.from(spec.content!).length} 字` }
        else if (mode === 'find_replace') {
          const find = spec.find ?? spec.old_text!, replacement = spec.replace ?? spec.new_text!
          const count = countMatches(current.content, find)
          if (!count) return { error: '未找到要替换的内容（find）' }
          if (!spec.replace_all && count > 1) return { error: '目标文本出现多次，请指定 replace_all' }
          const replaceAll = spec.mode === 'find_replace' || spec.replace_all
          content = replaceAll ? current.content.split(find).join(replacement) : current.content.replace(find, replacement)
          change = `替换 ${replaceAll ? count : 1} 处`
        } else {
          const edited = editLines(current.content, spec.line_edits!)
          if ('error' in edited) return edited
          content = edited.text; change = `按行修改 ${edited.changedLines} 行`
        }
        if (content === current.content) return { error: '文件内容未变化' }
        if (new TextEncoder().encode(content).byteLength > EDIT_FILE_MAX_BYTES) return { error: '修改后文件过大，单文件上限 256KB' }
        scope.signal.throwIfAborted()
        try {
          const updated = await port.update(scope.identity, id, content, current.version, scope.signal)
          const oldLength = Array.from(current.content).length, newLength = Array.from(content).length
          const warning = oldLength >= 200 && newLength < oldLength * 0.5
            ? `修改后正文明显变短（约 ${oldLength} 字 → ${newLength} 字），请用 read_file 读回核对是否误删内容。`
            : undefined
          return { success: true, file_id: current.id, name: current.name, version: updated.version, size_bytes: updated.size_bytes,
            change, ...(warning ? { warning } : {}) }
        } catch (error) {
          if (error instanceof Error && error.message === '文件已被其他端修改，请刷新后重试')
            return { error: error.message }
          return { unknown: true }
        }
      }
      try {
        if (!args.edits) {
          const result = await apply({ ...(args.file_id !== undefined ? { file_id: args.file_id } : {}), ...(args.file !== undefined ? { file: args.file } : {}) }, args)
          if ('unknown' in result) return { kind: 'unknown' }
          if ('error' in result) return failure(result.error)
          return { kind: 'completed', successful: true, mutated: true, value: {
            file_id: result.file_id, name: result.name, version: result.version, size_bytes: result.size_bytes,
            ...(result.warning ? { warning: result.warning } : {}),
          } }
        }
        const edited: Array<Record<string, unknown>> = [], failed: Array<Record<string, unknown>> = []
        for (const item of args.edits) {
          scope.signal.throwIfAborted()
          const target = item.file_id !== undefined || item.file !== undefined
            ? { ...(item.file_id !== undefined ? { file_id: item.file_id } : {}), ...(item.file !== undefined ? { file: item.file } : {}) }
            : { ...(args.file_id !== undefined ? { file_id: args.file_id } : {}), ...(args.file !== undefined ? { file: args.file } : {}) }
          const spec = { ...args, ...item }
          const result = await apply(target, spec)
          if ('unknown' in result) return { kind: 'unknown' }
          if ('success' in result) edited.push(result)
          else failed.push({ item: target.file ?? target.file_id, error: result.error })
        }
        return { kind: 'completed', successful: true, mutated: edited.length > 0, value: {
          success: true, edited_count: edited.length, failed_count: failed.length, edited, failed,
        } }
      } catch (error) {
        scope.signal.throwIfAborted()
        const message = error instanceof Error ? error.message : ''
        return failure(message === '文件已被其他端修改，请刷新后重试' ? message
          : message === '内容过大（上限 256KB）' || message === '文件过大，超出可改上限 256KB' ? message : '文件编辑失败')
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

const directorySchema = z.object({
  space: z.enum(['personal', 'project', 'workspace', 'mind', 'asset']).optional(),
  file_path: z.string().min(1).max(2048).optional(),
  project_id: z.number().int().positive().safe().optional(),
  workspace_directory_id: z.number().int().positive().safe().optional(),
  mind_map_id: z.number().int().positive().safe().optional(),
  folder_id: z.number().int().positive().safe().optional(),
  kind: z.enum(['both', 'file', 'folder']).default('both'),
  ext: z.string().min(1).max(20).optional(),
  q: z.string().max(200).optional(),
  queries: z.array(z.string().max(64)).max(8).optional(),
  mode: z.enum(['OR', 'AND']).default('OR'),
  limit: z.number().int().min(1).max(200).default(100),
  file_cursor: z.string().max(4096).optional(),
  folder_cursor: z.string().max(4096).optional(),
  sort_by: z.enum(['name', 'type', 'stage', 'createdAt', 'size', 'id']).default('createdAt'),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
}).strict().refine(query => Boolean(query.file_path) !== Boolean(query.space))
  .refine(query => !query.file_path || (query.file_path.startsWith('/') && !query.file_path.includes('\\') && !query.file_path.includes('\0')
    && query.file_path.split('/').slice(1).every(part => part.length > 0 && part !== '.' && part !== '..')))
  .refine(query => !query.file_path || /^\/(personal|project|workspace)(\/|$)/u.test(query.file_path))
  .refine(query => !query.file_path || !(query.project_id || query.workspace_directory_id || query.mind_map_id || query.folder_id || query.ext || query.q || query.queries
    || query.file_cursor || query.folder_cursor))
  .refine(query => (!query.project_id || query.space === 'project')
  && (!query.workspace_directory_id || query.space === 'workspace')
  && (!query.mind_map_id || query.space === 'mind')
  && !(query.project_id && query.workspace_directory_id))

function normalizeDirectoryQueries(query: z.infer<typeof directorySchema>): string[] {
  const source = query.queries?.length ? query.queries : query.q !== undefined ? [query.q] : []
  const seen = new Set<string>(), normalized: string[] = []
  for (const value of source) {
    const term = value.trim().slice(0, 64)
    const key = term.toLocaleLowerCase('und')
    if (!term || seen.has(key)) continue
    seen.add(key)
    normalized.push(term)
    if (normalized.length === 8) break
  }
  return normalized
}

/** 文件目录仅以明确空间和 Host 分页端口访问，不暴露宿主路径或任意目录枚举。 */
export function createListDirectoryTool(port: FileDirectoryPort): ToolDefinition {
  return {
    definition: { name: 'list_dir', schema: { type: 'function', function: {
      name: 'list_dir', description: '浏览文件库的直接文件和子文件夹。可明确指定空间及项目/工作区 ID，或通过 file_path 指定 /personal、/project、/workspace 下的文件库登记路径；它不是 Shell 本地目录，也不是宿主机路径。', parameters: {
        type: 'object', properties: {
          file_path: { type: 'string', minLength: 1, maxLength: 2048 },
          space: { type: 'string', enum: ['personal', 'project', 'workspace', 'mind', 'asset'] },
          project_id: { type: 'integer', minimum: 1 }, workspace_directory_id: { type: 'integer', minimum: 1 },
          mind_map_id: { type: 'integer', minimum: 1 }, folder_id: { type: 'integer', minimum: 1 },
          kind: { type: 'string', enum: ['both', 'file', 'folder'], default: 'both' },
          ext: { type: 'string', minLength: 1, maxLength: 20 }, q: { type: 'string', maxLength: 200 },
          queries: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 64 } },
          mode: { type: 'string', enum: ['OR', 'AND'], default: 'OR' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
          file_cursor: { type: 'string', maxLength: 4096 }, folder_cursor: { type: 'string', maxLength: 4096 },
          sort_by: { type: 'string', enum: ['name', 'type', 'stage', 'createdAt', 'size', 'id'], default: 'createdAt' },
          sort_order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
        }, anyOf: [{ required: ['space'], not: { required: ['file_path'] } }, { required: ['file_path'], not: { required: ['space'] } }], additionalProperties: false,
      },
    } } },
    effect: 'read',
    validate(input) { return directorySchema.safeParse(input) },
    async execute(input, scope) {
      const query = directorySchema.parse(input)
      const normalizedQueries = normalizeDirectoryQueries(query)
      scope.signal.throwIfAborted()
      try {
        const result = await port.list(scope.identity, { ...query, ...(normalizedQueries.length ? { queries: normalizedQueries } : {}), mode: query.mode }, scope.signal)
        scope.signal.throwIfAborted()
        return { kind: 'completed', successful: true, mutated: false,
          value: { ...result, total: result.total ?? result.files.length, shown: result.files.length, truncated: result.files_has_more } }
      } catch (error) {
        scope.signal.throwIfAborted()
        return failure(error instanceof Error && error.message.length <= 160 ? error.message : '目录读取失败')
      }
    },
  }
}

/** 文件夹软删除只接受稳定 owner 文件夹 ID，Host 负责级联回收站与 Undo。 */
export function createDeleteFolderTool(port: FileFolderDeletePort): ToolDefinition {
  const schema = z.object({ folder_id: z.number().int().positive().safe() }).strict()
  return {
    definition: { name: 'delete_folder', schema: { type: 'function', function: {
      name: 'delete_folder', description: '将指定文件夹及其子文件夹和文件整体移入回收站（30 天内可恢复）。先用 list_dir 确认 folder_id。',
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
      name: 'delete_file', description: '将指定文件按 file_id 或文件库逻辑路径移入回收站，也可批量传入 1-50 个 file_ids（30 天内可恢复）。批量删除会整体校验，缺失文件时不会删除其他项；此操作不会永久删除。路径只接受 list_dir 返回的 /personal、/project、/workspace 文件库路径，不接受宿主机路径。',
      parameters: { type: 'object', properties: {
        file_id: { type: 'integer', minimum: 1 },
        file: { type: 'string', minLength: 1, maxLength: 2048, description: 'list_dir 返回的 /personal、/project 或 /workspace 文件库逻辑路径' },
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
          if (fileId === null) return failure('文件路径不存在或不唯一；请用 list_dir 确认')
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
