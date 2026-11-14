import { createHash } from 'node:crypto'
import { runBestEffort } from '../../../adapters/best-effort.js'
import type { MindNoteReadResponse } from '../mind-notes-read.js'

const noteColors = new Set(['amber', 'coral', 'blue', 'teal'])
const referencePattern = /\[\[(?<type>[a-z_]+):(?<id>\d+)\|(?<label>[^\]]*)\]\]/g

export interface MindNoteCreateInput {
  contentMd: string
  contentPlain: string
  indexedHash: string
  title: string | null
  color: string | null
  capturedAt: Date
}

export interface MindNoteCreateMetadata {
  undoContextId: string | null
  clientId: string | null
  mutationId?: string | null
}

export interface MindNoteCreatePublication {
  ownerId: string
  note: MindNoteReadResponse
  clientId: string | null
  mutationId: string | null
}

export interface MindNoteCreateRuntime {
  insert(ownerId: string, input: MindNoteCreateInput, undoContextId: string | null): Promise<MindNoteReadResponse>
  publishCreated(publication: MindNoteCreatePublication): Promise<void>
  reportFailure?(operation: string, error?: unknown): void
}

export class MindNoteCreateError extends Error {
  readonly statusCode = 422

  constructor(message: string) {
    super(message)
    this.name = 'MindNoteCreateError'
  }
}

export function mindNotePlainText(markdown: string): string {
  return markdown
    .replace(referencePattern, (_match, _type, _id, label: string) => label)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}```.*$/gm, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/(\*\*|__|~~|\*|_)/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function payloadRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new MindNoteCreateError('便签内容无效')
  return value as Record<string, unknown>
}

function noteContent(value: unknown): string {
  const content = typeof value === 'object' && value !== null && 'contentMd' in value
    ? (value as Record<string, unknown>).contentMd
    : typeof value === 'object' && value !== null ? (value as Record<string, unknown>).content_md : undefined
  const result = content === undefined ? '' : content
  if (typeof result !== 'string') throw new MindNoteCreateError('便签正文必须是文本')
  return result
}

export function mindNoteTitleValidationError(title: unknown): string | null {
  if (title !== undefined && title !== null && typeof title !== 'string') return '便签标题必须是文本'
  if (typeof title === 'string' && [...title].length > 300) return '便签标题不能超过 300 个字符'
  return null
}

function noteTitle(body: Record<string, unknown>): string | null {
  const title = body.title
  const error = mindNoteTitleValidationError(title)
  if (error) throw new MindNoteCreateError(error)
  return title === undefined ? null : title as string | null
}

function noteColor(body: Record<string, unknown>): string | null {
  const color = body.color
  if (color !== undefined && color !== null && typeof color !== 'string')
    throw new MindNoteCreateError('便签颜色必须是现有色板中的值')
  if (typeof color === 'string' && !noteColors.has(color))
    throw new MindNoteCreateError('便签颜色必须是现有色板中的值')
  return color === undefined ? null : color as string | null
}

function noteCapturedAt(value: unknown, now: Date): Date {
  if (value === undefined || value === null) return now
  if (typeof value !== 'string') throw new MindNoteCreateError('记录时间无效')
  const raw = value.trim()
  const hasTimezone = /(?:z|[+-]\d{2}(?::?\d{2})?)$/i.test(raw)
  const capturedAt = new Date(hasTimezone || /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : `${raw}Z`)
  if (Number.isNaN(capturedAt.getTime())) throw new MindNoteCreateError('记录时间无效')
  if (capturedAt.getTime() > now.getTime()) throw new MindNoteCreateError('不能创建未来日期的记录')
  return capturedAt
}

/** 保持 Python MindNoteCreate 的默认值、字段校验和未来日期边界。 */
export function prepareMindNoteCreate(value: unknown, now = new Date()): MindNoteCreateInput {
  const body = payloadRecord(value)
  const contentMd = noteContent(value)
  const title = noteTitle(body)
  const color = noteColor(body)
  const capturedAtValue = body.capturedAt === undefined ? body.captured_at : body.capturedAt
  const capturedAt = noteCapturedAt(capturedAtValue, now)

  const contentPlain = mindNotePlainText(contentMd)
  return {
    contentMd,
    contentPlain,
    indexedHash: createHash('sha256').update(contentPlain, 'utf8').digest('hex'),
    title,
    color,
    capturedAt,
  }
}

export function createMindNoteCreator(runtime: MindNoteCreateRuntime) {
  return async function createMindNote(
    ownerId: string,
    value: unknown,
    metadata: MindNoteCreateMetadata,
  ): Promise<MindNoteReadResponse> {
    const input = prepareMindNoteCreate(value)
    const note = await runtime.insert(ownerId, input, metadata.undoContextId)
    await runBestEffort(
      'Mind note resource notification',
      () => runtime.publishCreated({
        ownerId, note, clientId: metadata.clientId, mutationId: metadata.mutationId ?? null,
      }),
      (operation, error) => runtime.reportFailure?.(operation, error),
    )
    return note
  }
}
