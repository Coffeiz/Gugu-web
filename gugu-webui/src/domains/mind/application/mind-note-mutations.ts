import { createHash } from 'node:crypto'
import { runBestEffort } from '../../../adapters/best-effort.js'
import { mindNotePlainText, mindNoteTitleValidationError } from './mind-note-create.js'
import type { MindNoteReadResponse } from '../mind-notes-read.js'

export interface MindNoteUpdateInput {
  version: number
  contentMd?: string
  contentPlain?: string
  indexedHash?: string
  title?: string | null
  color?: string | null
  capturedAt?: Date
}

export interface MindNoteMutationMetadata {
  undoContextId: string | null
  clientId: string | null
  mutationId?: string | null
}

export interface MindNoteMutationPublication {
  ownerId: string
  note: MindNoteReadResponse
  clientId: string | null
  mutationId: string | null
}

export interface MindNoteMutationRuntime {
  update(
    ownerId: string,
    noteId: number,
    input: MindNoteUpdateInput,
    undoContextId: string | null,
  ): Promise<{ note: MindNoteReadResponse; changed: boolean }>
  delete(ownerId: string, noteId: number, undoContextId: string | null): Promise<void>
  publishUpdated(publication: MindNoteMutationPublication): Promise<void>
  publishDeleted(publication: {
    ownerId: string
    noteId: number
    clientId: string | null
    mutationId: string | null
  }): Promise<void>
  reportFailure?(operation: string, error?: unknown): void
}

export class MindNoteMutationError extends Error {
  constructor(message: string, readonly statusCode: 404 | 409 | 422) {
    super(message)
    this.name = 'MindNoteMutationError'
  }
}

const noteColors = new Set(['amber', 'coral', 'blue', 'teal'])

function payloadRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new MindNoteMutationError('便签内容无效', 422)
  return value as Record<string, unknown>
}

function integerVersion(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim())
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

function capturedDate(value: unknown, now: Date): Date {
  if (typeof value !== 'string') throw new MindNoteMutationError('记录时间无效', 422)
  const raw = value.trim()
  const hasTimezone = /(?:z|[+-]\d{2}(?::?\d{2})?)$/i.test(raw)
  const date = new Date(hasTimezone || /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : `${raw}Z`)
  if (Number.isNaN(date.getTime())) throw new MindNoteMutationError('记录时间无效', 422)
  if (date.getTime() > now.getTime()) throw new MindNoteMutationError('不能创建未来日期的记录', 422)
  return date
}

function applyContent(body: Record<string, unknown>, input: MindNoteUpdateInput): void {
  const key = Object.hasOwn(body, 'contentMd') ? 'contentMd' : 'content_md'
  if (!Object.hasOwn(body, key)) return
  const contentMd = body[key]
  if (typeof contentMd !== 'string') throw new MindNoteMutationError('便签正文必须是文本', 422)
  const contentPlain = mindNotePlainText(contentMd)
  input.contentMd = contentMd
  input.contentPlain = contentPlain
  input.indexedHash = createHash('sha256').update(contentPlain, 'utf8').digest('hex')
}

function applyTitle(body: Record<string, unknown>, input: MindNoteUpdateInput): void {
  if (!Object.hasOwn(body, 'title')) return
  const title = body.title
  const error = mindNoteTitleValidationError(title)
  if (error) throw new MindNoteMutationError(error, 422)
  input.title = title as string | null
}

function applyColor(body: Record<string, unknown>, input: MindNoteUpdateInput): void {
  if (!Object.hasOwn(body, 'color')) return
  const color = body.color
  if (color !== null && (typeof color !== 'string' || !noteColors.has(color)))
    throw new MindNoteMutationError('便签颜色必须是现有色板中的值', 422)
  input.color = color as string | null
}

function applyCapturedAt(body: Record<string, unknown>, input: MindNoteUpdateInput, now: Date): void {
  const key = Object.hasOwn(body, 'capturedAt') ? 'capturedAt' : 'captured_at'
  if (Object.hasOwn(body, key)) input.capturedAt = capturedDate(body[key], now)
}

/** 对齐 MindNoteUpdate：版本必填，只接受 note 的可编辑字段。 */
export function prepareMindNoteUpdate(value: unknown, now = new Date()): MindNoteUpdateInput {
  const body = payloadRecord(value)
  const version = integerVersion(body.version)
  if (version === null) throw new MindNoteMutationError('版本号无效', 422)

  const input: MindNoteUpdateInput = { version }
  applyContent(body, input)
  applyTitle(body, input)
  applyColor(body, input)
  applyCapturedAt(body, input, now)
  return input
}

export function createMindNoteMutations(runtime: MindNoteMutationRuntime) {
  return {
    async update(ownerId: string, noteId: number, value: unknown, metadata: MindNoteMutationMetadata) {
      const input = prepareMindNoteUpdate(value)
      const result = await runtime.update(ownerId, noteId, input, metadata.undoContextId)
      if (result.changed) {
        await runBestEffort(
          'Mind note update notification',
          () => runtime.publishUpdated({
            ownerId, note: result.note, clientId: metadata.clientId, mutationId: metadata.mutationId ?? null,
          }),
          (operation, error) => runtime.reportFailure?.(operation, error),
        )
      }
      return result.note
    },

    async delete(ownerId: string, noteId: number, metadata: MindNoteMutationMetadata) {
      await runtime.delete(ownerId, noteId, metadata.undoContextId)
      await runBestEffort(
        'Mind note delete notification',
        () => runtime.publishDeleted({
          ownerId, noteId, clientId: metadata.clientId, mutationId: metadata.mutationId ?? null,
        }),
        (operation, error) => runtime.reportFailure?.(operation, error),
      )
    },
  }
}
