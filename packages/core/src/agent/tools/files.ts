import { z } from 'zod'
import type { RunIdentity, ToolResult } from '../index.js'
import type { ToolDefinition } from './contracts.js'
import { strip } from '../../shared/values.js'
import { asciiDecimalDigits, isDecimalDigits } from '../../shared/unicode-decimal.js'

const inputSchema = z.object({ file_id: z.number().int().positive().safe(), target_lines: z.string().default('all') }).strict()
const MAX_BYTES = 32 * 1024 * 1024

export interface OwnedTextFile {
  readonly id: number
  readonly name: string
  readonly root: string
  readonly relativePath: string
  /** 领域服务判定文本类型；不得将媒体或需提取的文档标记为文本。 */
  readonly text: boolean
  readonly extensionless: boolean
}

export interface ReadFilePorts {
  /** 同时验证 owner、会话/群身份、文件 scope、软删除和文件可读权限；不允许仅凭 file_id 返回记录。 */
  resolveOwnedFile(identity: RunIdentity, id: number, signal: AbortSignal): Promise<OwnedTextFile | null>
  /** Host 必须注入 packages/fs 的 openLocalFile，禁止直接打开模型传入的宿主路径。 */
  openFile(root: string, relativePath: string): Promise<{
    size: number
    handle: {
      read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
      close(): Promise<void>
    }
  } | null>
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

/** 只开放 file_id 的 UTF-8 文本切片；批量、逻辑路径、媒体、历史附件和 URL 尚未迁移。 */
export function createReadFileTool(ports: ReadFilePorts): ToolDefinition {
  return {
    definition: { name: 'read_file', schema: { type: 'function', function: {
      name: 'read_file', description: '读取文件库 UTF-8 文本，按原始物理行号选择正文。', parameters: {
        type: 'object', properties: { file_id: { type: 'integer', minimum: 1 }, target_lines: { type: 'string', default: 'all' } }, required: ['file_id'], additionalProperties: false,
      },
    } } },
    effect: 'read',
    validate(input) { return inputSchema.safeParse(input) },
    async execute(input, scope) {
      const args = inputSchema.parse(input)
      scope.signal.throwIfAborted()
      try {
        const file = await ports.resolveOwnedFile(scope.identity, args.file_id, scope.signal)
        scope.signal.throwIfAborted()
        if (!file) return failure('文件不存在或无权访问')
        if (!file.text && !file.extensionless) return failure('该文件类型尚不支持读取')
        const opened = await ports.openFile(file.root, file.relativePath)
        if (!opened) return failure('文件不存在，无法读取')
        try {
          scope.signal.throwIfAborted()
          if (opened.size > MAX_BYTES) return failure('文件过大，超出可读上限')
          // 多读一字节，防止 stat 后文件增长绕过大小限制。
          const bytes = new Uint8Array(MAX_BYTES + 1)
          let size = 0
          while (size < bytes.length) {
            scope.signal.throwIfAborted()
            const read = await opened.handle.read(bytes, size, Math.min(65536, bytes.length - size), size)
            if (!read.bytesRead) break
            size += read.bytesRead
          }
          scope.signal.throwIfAborted()
          if (size > MAX_BYTES) return failure('文件过大，超出可读上限')
          let text: string
          try { text = new TextDecoder('utf-8', { fatal: file.extensionless, ignoreBOM: !file.extensionless }).decode(bytes.subarray(0, size)) }
          catch { return failure('内容不是 UTF-8 文本') }
          if (file.extensionless && /[\x00-\x08\x0b\x0e-\x1f\x7f-\x9f]/u.test(text)) return failure('内容不是 UTF-8 文本')
          // 普通文本沿用 doctext 的字符上限；无后缀沿用独立严格解码分支。
          if (!file.extensionless) {
            let end = 0
            for (let count = 0; count < 200_000 && end < text.length; count++) end += text.codePointAt(end)! > 0xffff ? 2 : 1
            text = text.slice(0, end)
          }
          const selected = selectLines(text, args.target_lines)
          if ('error' in selected) return failure(selected.error!)
          return { kind: 'completed', value: { file_id: file.id, name: file.name, ...selected, _source_size_bytes: size }, successful: true, mutated: false }
        } finally { await opened.handle.close() }
      } catch {
        scope.signal.throwIfAborted()
        return failure('读取失败')
      }
    },
  }
}
