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
  /** Host 用档案写入锁保护快照读取和最终写入。生成向量在锁外执行。 */
  withSourceLock?<T>(ownerId: string, operation: () => Promise<T>): Promise<T>
  embed(ownerId: string, text: string, signal: AbortSignal): Promise<readonly number[] | null>
  rebuildMemoryIndex(ownerId: string, signal: AbortSignal): Promise<void>
}

const CHUNK_MAX = 400

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

export function userMemoryVectorChunkKey(text: string): string {
  return createHash('md5').update(text.trim(), 'utf8').digest('hex').slice(0, 12)
}

type LongMemoryVectorRefreshPorts = Pick<UserMemoryVectorRebuildPorts, 'readMemory' | 'readVectors' | 'writeVectors' | 'embed'>
  & Required<Pick<UserMemoryVectorRebuildPorts, 'withSourceLock'>>

/** 沿用旧版块键，只补当前模型缺失的长期记忆向量。 */
export function createUserLongMemoryVectorRefresher(ports: LongMemoryVectorRefreshPorts) {
  return async (rawOwnerId: string, modelTag: string, signal: AbortSignal): Promise<void> => {
    const owner = dataContext(rawOwnerId).ownerId
    if (!modelTag.trim()) throw new Error('Embedding 模型标记无效')
    const read = async () => {
      signal.throwIfAborted()
      return { memory: await ports.readMemory(owner), vectors: object(await ports.readVectors(owner, 'memory')) ?? {} }
    }
    const snapshot = await ports.withSourceLock(owner, read)
    const expected = JSON.stringify(snapshot)
    const chunks = new Map(splitUserMemoryVectorChunks(snapshot.memory ?? '').map(text => [userMemoryVectorChunkKey(text), text]))
    const next: Record<string, StoredMemoryVector> = {}
    for (const [key, text] of chunks) {
      const cached = object(snapshot.vectors[key])
      const values = cached?.v
      const previous = typeof cached?.t === 'string' && Array.isArray(values) && values.length && values.every(Number.isFinite)
        ? { v: values as number[], t: cached.t } : undefined
      if (previous?.t === modelTag) {
        next[key] = previous
        continue
      }
      const vector = await generateVector(ports, owner, text, signal)
      if (vector) next[key] = { v: vector, t: modelTag }
      else if (previous) next[key] = previous
    }
    if (JSON.stringify(next) === JSON.stringify(snapshot.vectors)) return
    await ports.withSourceLock(owner, async () => {
      if (JSON.stringify(await read()) !== expected) return
      signal.throwIfAborted()
      await ports.writeVectors(owner, 'memory', next)
    })
  }
}

async function generateVector(ports: Pick<UserMemoryVectorRebuildPorts, 'embed'>, ownerId: string, text: string, signal: AbortSignal): Promise<number[] | null> {
  signal.throwIfAborted()
  const vector = await ports.embed(ownerId, text, signal)
  signal.throwIfAborted()
  if (!vector?.length || vector.some(value => !Number.isFinite(value))) return null
  return [...vector]
}

async function requireVector(ports: Pick<UserMemoryVectorRebuildPorts, 'embed'>, ownerId: string, text: string, signal: AbortSignal): Promise<number[]> {
  const vector = await generateVector(ports, ownerId, text, signal)
  if (!vector) throw new Error('Embedding 向量生成失败')
  return vector
}

type PatternVectorRefreshPorts = Pick<UserMemoryVectorRebuildPorts, 'readPatterns' | 'readVectors' | 'writeVectors' | 'embed'>
  & Required<Pick<UserMemoryVectorRebuildPorts, 'withSourceLock'>>

/** 对应 Python sync_pattern_vecs 的增量补齐。发布前复核档案和缓存，避免覆盖管理重建。 */
export function createUserPatternVectorRefresher(ports: PatternVectorRefreshPorts) {
  return async (rawOwnerId: string, modelTag: string, signal: AbortSignal): Promise<void> => {
    const ownerId = dataContext(rawOwnerId).ownerId
    if (!modelTag.trim()) throw new Error('Embedding 模型标记无效')
    async function readCurrent() {
      signal.throwIfAborted()
      const patterns = patternsFrom(await ports.readPatterns(ownerId))
      const vectors = object(await ports.readVectors(ownerId, 'pattern')) ?? {}
      return { patterns, vectors }
    }

    const snapshot = await ports.withSourceLock(ownerId, readCurrent)
    const liveIds = new Set(snapshot.patterns.map(pattern => pattern.id))
    const retained = new Map<string, StoredMemoryVector>()
    for (const [id, cached] of Object.entries(snapshot.vectors)) {
      const row = object(cached)
      const value = row?.v
      if (liveIds.has(id) && typeof row?.t === 'string' && Array.isArray(value) && value.length && value.every(Number.isFinite))
        retained.set(id, { v: value, t: row.t })
    }
    let changed = retained.size !== Object.keys(snapshot.vectors).length
    for (const { id, text } of snapshot.patterns) {
      if (retained.get(id)?.t === modelTag) continue
      const vector = await generateVector(ports, ownerId, text, signal)
      if (vector) {
        retained.set(id, { v: vector, t: modelTag })
        changed = true
      }
    }
    if (!changed) return

    await ports.withSourceLock(ownerId, async () => {
      const current = await readCurrent()
      signal.throwIfAborted()
      if (JSON.stringify(current) !== JSON.stringify(snapshot)) return
      await ports.writeVectors(ownerId, 'pattern', Object.fromEntries(retained))
    })
  }
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
    const withLock = <T>(operation: () => Promise<T>) =>
      ports.withSourceLock ? ports.withSourceLock(ownerId, operation) : operation()
    const readPatterns = async () => {
      signal.throwIfAborted()
      return patternsFrom(await ports.readPatterns(ownerId))
    }
    const readMemory = async () => (await ports.readMemory(ownerId) || '').trim()

    async function publish(kind: UserMemoryVectorKind, expected: string, readSource: () => Promise<string>,
      previous: Record<string, unknown> | null, vectors: Record<string, StoredMemoryVector>) {
      await withLock(async () => {
        signal.throwIfAborted()
        if (await readSource() !== expected) throw new Error('生成向量期间记忆档案已更新')
        if (JSON.stringify(object(await ports.readVectors(ownerId, kind))) !== JSON.stringify(previous))
          throw new Error('生成向量期间记忆向量缓存已更新')
        signal.throwIfAborted()
        await ports.writeVectors(ownerId, kind, vectors)
      })
    }

    try {
      signal.throwIfAborted()
      const { previousPatterns, patterns } = await withLock(async () => ({
        patterns: await readPatterns(),
        previousPatterns: object(await ports.readVectors(ownerId, 'pattern')),
      }))
      withPatterns = patterns.length ? 1 : 0
      if (patterns.length || (previousPatterns && Object.keys(previousPatterns).length)) {
        const vectors: Record<string, StoredMemoryVector> = {}
        for (const pattern of patterns) {
          vectors[pattern.id] = { v: await requireVector(ports, ownerId, pattern.text, signal), t: modelTag }
          counts.patternVectors += 1
        }
        await publish('pattern', JSON.stringify(patterns), async () => JSON.stringify(await readPatterns()), previousPatterns, vectors)
      }

      const { previousMemory, memory } = await withLock(async () => ({
        memory: await readMemory(),
        previousMemory: object(await ports.readVectors(ownerId, 'memory')),
      }))
      const chunks = splitUserMemoryVectorChunks(memory)
      if (chunks.length || (previousMemory && Object.keys(previousMemory).length)) {
        const vectors: Record<string, StoredMemoryVector> = {}
        for (const chunk of chunks) {
          vectors[userMemoryVectorChunkKey(chunk)] = { v: await requireVector(ports, ownerId, chunk, signal), t: modelTag }
          counts.memoryVectors += 1
        }
        await publish('memory', memory, readMemory, previousMemory, vectors)
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
