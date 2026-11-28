import { createHash } from 'node:crypto'
import { CoreError } from '../contracts/index.js'
import { splitUserMemoryVectorChunks, userMemoryVectorChunkKey } from '../byok/vector-rebuild.js'
import { prepareAccountMemoryCleanupChanges } from './account-cleanup-apply.js'
import { readAccountMemoryCleanupSource, type AccountMemoryCleanupPlan } from './account-cleanup-preview.js'

const files = ['pattern.json', 'profile.json', 'memory.md', 'daily.md', 'pattern_vec.json', 'memory_vec.json', 'facts.json', 'facts.md'] as const
type File = typeof files[number]
type WritableFile = Exclude<File, 'facts.json' | 'facts.md'>
// 先写入搬迁目的地。中断可以暂时保留副本，不能让记录从两个位置同时消失。
const writableFiles = ['memory.md', 'profile.json', 'pattern.json', 'daily.md', 'pattern_vec.json', 'memory_vec.json'] as const

export interface AccountMemoryCleanupResult {
  touched: boolean
  removed: number
  moved: number
  profileEvents: number
  daily: number
}

export interface AccountMemoryCleanupPublication {
  operationId: string
  planDigest: string
  before: Record<File, string>
  changes: Partial<Record<WritableFile, string>>
  result: AccountMemoryCleanupResult
}

export interface AccountMemoryCleanupFilesPort {
  read(name: File): Promise<Uint8Array | null>
  write(name: WritableFile, content: string): Promise<void>
  loadPublication(): Promise<AccountMemoryCleanupPublication | null>
  savePublication(value: AccountMemoryCleanupPublication): Promise<void>
}

function digest(value: string | Uint8Array | null): string {
  return value === null ? 'missing' : createHash('sha256').update(value).digest('hex')
}

function conflict(): CoreError {
  return new CoreError('conflict', '记忆维护预览已过期，源数据发生变化，请重新生成预览')
}

function pruneVectors(raw: Uint8Array, ids: readonly string[]): string {
  const active = new Set(ids)
  try {
    const cache: unknown = JSON.parse(new TextDecoder().decode(raw))
    if (cache && typeof cache === 'object' && !Array.isArray(cache)) {
      return JSON.stringify(Object.fromEntries(Object.entries(cache).filter(([id]) => active.has(id))))
    }
  } catch { /* 无效向量缓存可重建。 */ }
  return '{}'
}

async function preparePublication(
  operationId: string, planDigest: string, plan: AccountMemoryCleanupPlan, ports: AccountMemoryCleanupFilesPort, now: number,
): Promise<AccountMemoryCleanupPublication> {
  const observed = Object.fromEntries(await Promise.all(files.map(async name => [name, await ports.read(name)] as const))) as Record<File, Uint8Array | null>
  const source = readAccountMemoryCleanupSource(observed, now)
  const patch = prepareAccountMemoryCleanupChanges(source, plan, now)
  const changes: AccountMemoryCleanupPublication['changes'] = {}
  if (patch.patterns) {
    changes['pattern.json'] = JSON.stringify(patch.patterns, null, 2)
    if (observed['pattern_vec.json']) changes['pattern_vec.json'] = pruneVectors(observed['pattern_vec.json'], patch.patterns.map(row => row.id))
  }
  if (patch.profile) changes['profile.json'] = JSON.stringify(patch.profile, null, 2)
  if (patch.memory !== undefined) {
    changes['memory.md'] = patch.memory
    if (observed['memory_vec.json'])
      changes['memory_vec.json'] = pruneVectors(observed['memory_vec.json'], splitUserMemoryVectorChunks(patch.memory).map(userMemoryVectorChunkKey))
  }
  if (patch.daily !== undefined) changes['daily.md'] = patch.daily
  const stillPresent = new Set(source.patterns.map(row => row.id))
  return {
    operationId, planDigest,
    before: Object.fromEntries(files.map(name => [name, digest(observed[name])])) as Record<File, string>,
    changes,
    result: {
      touched: Object.keys(changes).length > 0,
      removed: plan.removed_ids.filter(id => stillPresent.has(id)).length,
      moved: plan.moved_texts.length, profileEvents: plan.profile_event_migrated, daily: plan.daily_migrated,
    },
  }
}

/** 在 owner 写锁内暂存批准的改写。成功索引失效后，调用方才应发布正文。 */
export async function stageAccountMemoryCleanup(
  operationId: string, plan: AccountMemoryCleanupPlan, ports: AccountMemoryCleanupFilesPort, now: number,
): Promise<AccountMemoryCleanupPublication> {
  const planDigest = digest(JSON.stringify(plan))
  let publication = await ports.loadPublication()
  if (!publication) {
    publication = await preparePublication(operationId, planDigest, plan, ports, now)
    if (publication.result.touched) await ports.savePublication(publication)
  }
  if (publication.operationId !== operationId || publication.planDigest !== planDigest) throw conflict()
  return publication
}

/** 在调用方的 owner 写锁内执行。事务回执提交前保留发布日志，重试仅补齐尚未发布的文件。 */
export async function publishAccountMemoryCleanup(
  operationId: string, plan: AccountMemoryCleanupPlan, ports: AccountMemoryCleanupFilesPort, now: number,
): Promise<AccountMemoryCleanupResult> {
  const publication = await stageAccountMemoryCleanup(operationId, plan, ports, now)
  if (!publication.result.touched) return publication.result
  const desired = publication.changes
  const present = await Promise.all(files.map(name => ports.read(name)))
  // 在修改任何文件前检查未变更的依赖和全部目标。旧来源也不能在中断期间切换。
  for (const [index, name] of files.entries()) {
    const current = digest(present[index] ?? null)
    const replacement = Object.hasOwn(desired, name) ? desired[name as WritableFile] : undefined
    if (current !== publication.before[name] && (replacement === undefined || current !== digest(replacement))) throw conflict()
  }
  for (const name of writableFiles) {
    const replacement = desired[name]
    if (replacement === undefined) continue
    const current = digest(await ports.read(name))
    if (current === digest(replacement)) continue
    if (current !== publication.before[name]) throw conflict()
    await ports.write(name, replacement)
  }
  return publication.result
}
