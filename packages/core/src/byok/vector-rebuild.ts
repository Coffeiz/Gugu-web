import { createHash } from 'node:crypto'
import { dataContext } from '../contracts/index.js'

export type UserMemoryVectorKind = 'pattern' | 'memory'
export type StoredMemoryVector = { v: number[]; t: string }
export type UserMemoryVectorRebuildResult = {
  patternVectors: number
  memoryVectors: number
  withPatterns: number
  failedUsers: number
  ragIndexFailed: boolean
}

export interface UserMemoryVectorRebuildPorts {
  readPatterns(ownerId: string): Promise<unknown>
  readMemory(ownerId: string): Promise<string | null>
  readVectors(ownerId: string, kind: UserMemoryVectorKind): Promise<unknown>
  writeVectors(ownerId: string, kind: UserMemoryVectorKind, vectors: Record<string, StoredMemoryVector>): Promise<void>
  embed(ownerId: string, text: string, signal: AbortSignal): Promise<readonly number[] | null>
  rebuildMemoryIndex(ownerId: string, signal: AbortSignal): Promise<void>
}

const CHUNK_MAX = 400
const emptyVectors = (): Record<string, StoredMemoryVector> => ({})

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function patternsFrom(value: unknown): Array<{ id: string; text: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap(raw => {
    const row = object(raw)
    const id = typeof row?.id === 'string' ? row.id : ''
    const text = typeof row?.text === 'string' ? row.text.trim() : ''
    return id && text ? [{ id, text }] : []
  })
}

function codePoints(value: string): string[] { return Array.from(value) }
function length(value: string): number { return codePoints(value).length }
function take(value: string, count: number): string { return codePoints(value).slice(0, count).join('') }

function splitMemoryBlock(block: string, limit = CHUNK_MAX): string[] {
  const output: string[] = []
  for (const rawParagraph of block.split(/\n\s*\n/u)) {
    const paragraph = rawParagraph.trim()
    if (!paragraph) continue
    if (length(paragraph) <= limit) { output.push(paragraph); continue }
    let buffer = ''
    for (const sentence of paragraph.split(/(?<=[。！？!?\n])/u)) {
      let remaining = sentence
      while (length(remaining) > limit) {
        if (buffer) { output.push(buffer.trim()); buffer = '' }
        output.push(take(remaining, limit).trim())
        remaining = codePoints(remaining).slice(limit).join('')
      }
      if (buffer && length(buffer) + length(remaining) > limit) {
        output.push(buffer.trim())
        buffer = remaining
      } else buffer += remaining
    }
    if (buffer.trim()) output.push(buffer.trim())
  }
  return output.filter(Boolean)
}

/** Python memory store 的 400 字符分块与事件章节上下文规则。 */
export function splitUserMemoryVectorChunks(memoryText: string): string[] {
  const text = (memoryText || '').trim()
  if (!text) return []
  const headings = [...text.matchAll(/^##\s+记录长期记忆：.+$/gmu)]
  if (!headings.length) return splitMemoryBlock(text)
  const output: string[] = []
  if (headings[0]!.index! > 0) output.push(...splitMemoryBlock(text.slice(0, headings[0]!.index!).trim()))
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!
    const start = heading.index!
    const end = index + 1 < headings.length ? headings[index + 1]!.index! : text.length
    const section = text.slice(start, end).trim()
    if (length(section) <= CHUNK_MAX) { output.push(section); continue }
    const [title, ...bodyLines] = section.split('\n')
    const body = bodyLines.join('\n')
    const context = body.split('\n').map(line => line.trim())
      .filter(line => line.startsWith('- 时间：') || line.startsWith('- 类型：') || line.startsWith('- 状态：'))
    const prefix = [title!.trim(), ...context].filter(Boolean).join('\n').trim()
    const blocks = body.split(/\n\s*\n|(?=^###\s+)/gmu).map(block => block.trim()).filter(Boolean)
    const contentLimit = Math.max(1, CHUNK_MAX - length(prefix) - 2)
    for (const block of blocks) {
      const combined = `${prefix}\n\n${block}`.trim()
      if (length(combined) <= CHUNK_MAX) output.push(combined)
      else output.push(...splitMemoryBlock(block, contentLimit).map(part => `${prefix}\n\n${part}`.trim()))
    }
  }
  return output.filter(Boolean)
}

function chunkKey(text: string): string {
  return createHash('md5').update(text.trim(), 'utf8').digest('hex').slice(0, 12)
}

async function requireVector(ports: UserMemoryVectorRebuildPorts, ownerId: string, text: string, signal: AbortSignal): Promise<number[]> {
  signal.throwIfAborted()
  const vector = await ports.embed(ownerId, text, signal)
  signal.throwIfAborted()
  if (!vector?.length || vector.some(value => !Number.isFinite(value))) throw new Error('Embedding 向量生成失败')
  return [...vector]
}

/** 重建当前 owner 的旧格式向量缓存；规则/完整用例在 Core，文件与出站由 Host 提供。 */
export function createUserMemoryVectorRebuilder(ports: UserMemoryVectorRebuildPorts) {
  return async (rawOwnerId: string, modelTag: string, signal = new AbortController().signal): Promise<UserMemoryVectorRebuildResult> => {
    const ownerId = dataContext(rawOwnerId).ownerId
    if (!modelTag.trim()) throw new Error('Embedding 模型标记无效')
    const counts = { patternVectors: 0, memoryVectors: 0 }
    let withPatterns = 0
    let failedUsers = 0
    let ragIndexFailed = false
    try {
      const previousPatterns = object(await ports.readVectors(ownerId, 'pattern'))
      const patterns = patternsFrom(await ports.readPatterns(ownerId))
      withPatterns = patterns.length ? 1 : 0
      if (patterns.length) {
        const vectors: Record<string, StoredMemoryVector> = {}
        for (const pattern of patterns) {
          vectors[pattern.id] = { v: await requireVector(ports, ownerId, pattern.text, signal), t: modelTag }
          counts.patternVectors += 1
        }
        await ports.writeVectors(ownerId, 'pattern', vectors)
      } else if (previousPatterns && Object.keys(previousPatterns).length) {
        await ports.writeVectors(ownerId, 'pattern', emptyVectors())
      }

      const previousMemory = object(await ports.readVectors(ownerId, 'memory'))
      const memory = (await ports.readMemory(ownerId) || '').trim()
      const chunks = splitUserMemoryVectorChunks(memory)
      if (chunks.length) {
        const vectors: Record<string, StoredMemoryVector> = {}
        for (const chunk of chunks) {
          vectors[chunkKey(chunk)] = { v: await requireVector(ports, ownerId, chunk, signal), t: modelTag }
          counts.memoryVectors += 1
        }
        await ports.writeVectors(ownerId, 'memory', vectors)
      } else if (previousMemory && Object.keys(previousMemory).length) {
        await ports.writeVectors(ownerId, 'memory', emptyVectors())
      }
    } catch {
      signal.throwIfAborted()
      failedUsers = 1
    }

    try { await ports.rebuildMemoryIndex(ownerId, signal) }
    catch {
      signal.throwIfAborted()
      ragIndexFailed = true
    }
    return {
      patternVectors: failedUsers ? 0 : counts.patternVectors,
      memoryVectors: failedUsers ? 0 : counts.memoryVectors,
      withPatterns: failedUsers ? 0 : withPatterns,
      failedUsers,
      ragIndexFailed,
    }
  }
}
