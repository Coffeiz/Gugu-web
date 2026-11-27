import { sql, type Kysely, type Transaction } from 'kysely'
import { lstat } from 'node:fs/promises'
import { CoreError, dataContext } from '../../contracts/index.js'
import { serializeSkillDocument, userSkillDirectory } from './bundle.js'
import { createUserSkillBundle, readUserSkillBundle } from './bundle-store.js'
import { migrateMindSkillReferences } from './migrate-mind.js'

export interface LegacySkillForMigration {
  id: string
  name: string
  description_short: string
  description_long: string | null
  category: string
  related_tools: readonly string[]
  body: string
  enabled: boolean
  managed_by: string
}

/** 旧技能编号作为稳定目录名，名称支持中文且不会因同名发生碰撞。 */
export function projectLegacySkillBundle(skill: LegacySkillForMigration) {
  if (!/^U[1-9][0-9]*$/u.test(skill.id))
    throw new CoreError('invalid_request', '旧技能标识无效')
  if (!skill.name.trim() || !skill.description_short.trim())
    throw new CoreError('invalid_request', '旧技能名称或描述为空')
  const frontmatter = {
    name: skill.name,
    description: skill.description_short,
    metadata: {
      gugu: {
        legacy_id: skill.id,
        enabled: skill.enabled,
        description_long: skill.description_long,
        category: skill.category,
        related_tools: [...skill.related_tools],
        managed_by: skill.managed_by,
      },
    },
  }
  return {
    slug: skill.id.toLowerCase(),
    source: serializeSkillDocument(frontmatter, skill.body),
    enabled: skill.enabled,
  }
}

/** 逐项落盘后核对内容；中途失败可重新执行，已有不同内容时保留并报告冲突。 */
export async function migrateLegacySkillBundle(
  dataRoot: string,
  ownerId: string,
  skill: LegacySkillForMigration,
) {
  const bundle = projectLegacySkillBundle(skill)
  try {
    await createUserSkillBundle(dataRoot, ownerId, bundle.slug, bundle.source)
    return { slug: bundle.slug, enabled: bundle.enabled, created: true }
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
  }
  const existing = await readUserSkillBundle(dataRoot, ownerId, bundle.slug)
  if (existing.source !== bundle.source)
    throw new CoreError('conflict', '技能目录已有不同内容，无法迁移')
  return { slug: bundle.slug, enabled: bundle.enabled, created: false }
}

/** 使用调用方提供的用户限定目录迁移全部旧技能，返回可持久化的迁移结果。 */
export async function migrateLegacySkillBundles(
  dataRoot: string,
  ownerId: string,
  list: (ownerId: string) => Promise<readonly LegacySkillForMigration[]>,
) {
  const skills = await list(ownerId)
  const ids = new Set<string>()
  for (const skill of skills) {
    if (ids.has(skill.id)) throw new CoreError('conflict', '旧技能标识重复')
    ids.add(skill.id)
    // 所有记录先完成字段校验，避免数据无效时只迁移一部分。
    projectLegacySkillBundle(skill)
  }
  // 全部目标先检查一遍；任一目录冲突时不提前写入其他技能。
  for (const skill of skills) {
    const bundle = projectLegacySkillBundle(skill)
    const directory = userSkillDirectory(dataRoot, ownerId, bundle.slug)
    const exists = await lstat(directory).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (!exists) continue
    const existing = await readUserSkillBundle(dataRoot, ownerId, bundle.slug).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new CoreError('conflict', '技能目录不完整，无法迁移')
      throw error
    })
    if (existing.source !== bundle.source) throw new CoreError('conflict', '技能目录已有不同内容，无法迁移')
  }
  const results = []
  for (const skill of skills) results.push(await migrateLegacySkillBundle(dataRoot, ownerId, skill))
  return results
}

/** 从现有用户技能表读取迁移输入，用户范围由可信调用方提供。 */
export function createLegacySkillMigrationReader<DB>(db: Kysely<DB>, backend: 'sqlite' | 'postgres') {
  return async (ownerId: string): Promise<LegacySkillForMigration[]> => {
    const normalized = dataContext(ownerId).ownerId
    const owner = backend === 'sqlite' ? normalized.replaceAll('-', '') : normalized
    const result = await sql<{
      skill_id: string; name: string; description_short: string; description_long: string | null
      category: string; related_tools: string | string[]; body: string; enabled: boolean | number; managed_by: string | null
    }>`SELECT skill_id,name,description_short,description_long,category,related_tools,body,enabled,managed_by
      FROM user_skills WHERE owner_id=${owner} AND source='user' ORDER BY skill_id`.execute(db)
    return result.rows.map(row => {
      const tools: unknown = typeof row.related_tools === 'string' ? JSON.parse(row.related_tools) : row.related_tools
      if (!Array.isArray(tools) || !tools.every(item => typeof item === 'string'))
        throw new CoreError('invalid_request', '旧技能关联工具数据无效')
      return {
        id: row.skill_id, name: row.name, description_short: row.description_short,
        description_long: row.description_long, category: row.category, related_tools: tools,
        body: row.body, enabled: Boolean(row.enabled), managed_by: row.managed_by ?? 'user',
      }
    })
  }
}

/** 同事务迁移用户消息和待发送队列中的技能引用，其他对象和额外字段原样保留。 */
async function migrateSkillReferences<DB>(tx: Transaction<DB>, backend: 'sqlite' | 'postgres', owner: string) {
  const rows = await sql<{ id: number | string; skill_id: string }>`
    SELECT id,skill_id FROM user_skills WHERE owner_id=${owner} AND source='user'`.execute(tx)
  if (!rows.rows.length) return
  const ids = new Map<string, string>()
  for (const row of rows.rows) {
    const slug = row.skill_id.toLowerCase()
    ids.set(row.skill_id, slug)
    ids.set(String(row.id), slug)
  }
  const lockNodes = backend === 'postgres' ? sql` FOR UPDATE` : sql``
  const nodes = await sql<{ id: number; content_md: string }>`
    SELECT id,content_md FROM mind_nodes WHERE user_id=${owner} AND content_md LIKE '%[[skill:%'${lockNodes}`.execute(tx)
  for (const node of nodes.rows) {
    const content = migrateMindSkillReferences(node.content_md, ids)
    if (content !== node.content_md)
      await sql`UPDATE mind_nodes SET content_md=${content},version=version+1 WHERE id=${node.id} AND user_id=${owner}`.execute(tx)
  }
  const decode = (value: unknown): unknown => {
    if (typeof value !== 'string') return value
    try { return JSON.parse(value) }
    catch { throw new CoreError('storage_error', '技能引用数据格式无效') }
  }
  const refs = (value: unknown) => {
    if (!Array.isArray(value)) throw new CoreError('storage_error', '技能引用数据格式无效')
    let changed = false
    const result = value.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item
      const ref = item as Record<string, unknown>
      if (ref.type !== 'skill' || (typeof ref.id !== 'string' && typeof ref.id !== 'number')) return item
      const slug = ids.get(String(ref.id))
      if (!slug) return item
      changed = true
      return { ...ref, id: slug }
    })
    return { result, changed }
  }
  const lockMessages = backend === 'postgres' ? sql` FOR UPDATE OF m` : sql``
  const messages = await sql<{ id: number; references_json: unknown }>`
    SELECT m.id,m.references_json FROM conversation_messages m
    JOIN conversation_sessions s ON s.id=m.session_id
    WHERE s.user_id=${owner} AND m.references_json IS NOT NULL${lockMessages}`.execute(tx)
  for (const message of messages.rows) {
    const converted = refs(decode(message.references_json))
    if (!converted.changed) continue
    const data = JSON.stringify(converted.result)
    const json = backend === 'postgres' ? sql`${data}::jsonb` : sql`${data}`
    await sql`UPDATE conversation_messages SET references_json=${json} WHERE id=${message.id}`.execute(tx)
  }
  const lockQueues = backend === 'postgres' ? sql` FOR UPDATE` : sql``
  const queues = await sql<{ queue_id: string; items: unknown }>`
    SELECT queue_id,items FROM conversation_pending_queues WHERE user_id=${owner}${lockQueues}`.execute(tx)
  for (const queue of queues.rows) {
    const items = decode(queue.items)
    if (!Array.isArray(items)) throw new CoreError('storage_error', '待发送队列格式无效')
    let changed = false
    const converted = items.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !('references' in item)) return item
      const current = item as Record<string, unknown>
      const next = refs(current.references)
      if (!next.changed) return item
      changed = true
      return { ...current, references: next.result }
    })
    if (!changed) continue
    const data = JSON.stringify(converted)
    const json = backend === 'postgres' ? sql`${data}::jsonb` : sql`${data}`
    await sql`UPDATE conversation_pending_queues SET items=${json} WHERE user_id=${owner} AND queue_id=${queue.queue_id}`.execute(tx)
  }
}

/**
 * 在数据库事务内冻结旧记录并复制到文件；旧行保留为迁移归档。
 * 调用方必须先停用旧写入入口，并确保同一用户的宿主文件修改已暂停。
 */
export async function cutoverLegacySkillBundles<DB>(options: {
  db: Kysely<DB>
  backend: 'sqlite' | 'postgres'
  dataRoot: string
  ownerId: string
}) {
  const owner = dataContext(options.ownerId).ownerId
  const key = options.backend === 'sqlite' ? owner.replaceAll('-', '') : owner
  return options.db.transaction().execute(async tx => {
    if (options.backend === 'postgres') {
      const account = await sql<{ id: string }>`SELECT id FROM users WHERE id=${key} FOR UPDATE`.execute(tx)
      if (account.rows.length !== 1) throw new CoreError('not_found', '用户不存在')
      await sql`SELECT skill_id FROM user_skills WHERE owner_id=${key} AND source='user' FOR UPDATE`.execute(tx)
    } else {
      // 在读取快照之前申请 SQLite 写锁，避免并发旧写入穿过迁移。
      await sql`UPDATE user_skills SET source=source WHERE owner_id=${key} AND source='user'`.execute(tx)
    }
    const list = createLegacySkillMigrationReader(tx, options.backend)
    const skills = await list(owner)
    if (options.backend === 'postgres') {
      for (const skill of [...skills].sort((a, b) => a.id.localeCompare(b.id))) {
        const { slug } = projectLegacySkillBundle(skill)
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`skill:${owner}:${slug}`}, 0))`.execute(tx)
      }
    }
    const migrated = await migrateLegacySkillBundles(options.dataRoot, owner, async () => skills)
    await migrateSkillReferences(tx, options.backend, key)
    for (const skill of skills) {
      const expected = projectLegacySkillBundle(skill)
      const current = await readUserSkillBundle(options.dataRoot, owner, expected.slug)
      if (current.source !== expected.source) throw new CoreError('conflict', '迁移期间技能文件已变化')
      const result = await sql`UPDATE user_skills SET source='migrated' WHERE owner_id=${key} AND skill_id=${skill.id} AND source='user'`.execute(tx)
      if (Number(result.numAffectedRows) !== 1) throw new CoreError('conflict', '迁移期间旧技能已变化')
    }
    return migrated
  })
}
