import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import type { RunIdentity, Json, CanonicalRunPreparationPorts } from '@gugu/core/agent'
import { createBuiltinSkillDefinitions, createSkillRegistry, type SkillDefinition, type SkillMetadata } from '@gugu/core/skills'
import { createBundledSkillDocuments } from '@gugu/core/skills/bundled'
import type { ImActor } from '@gugu/core/im/access'
import { imCanUseTool } from '@gugu/core/im/access'

const same = (a: RunIdentity, b: RunIdentity) => a.ownerId === b.ownerId && a.sessionId === b.sessionId && a.runId === b.runId
const failure = () => new Error('IM 技能资源不可用')
/** 目录只读真实元数据；正文按需读取并在发布前重新核对启用状态和当前权限。 */
export async function createImProductionSkills(options: {
  pool: Pick<Pool, 'query'>; identity: RunIdentity; actor: ImActor; loadOwnerContext: boolean
  authorize(): Promise<boolean>
}) {
  const identity = { ...options.identity }, actor = structuredClone(options.actor)
  const builtins = await createBuiltinSkillDefinitions(createBundledSkillDocuments(), new AbortController().signal)
  const canRead = async (candidate: RunIdentity) => same(candidate, identity) && imCanUseTool(actor, 'use_skill') && await options.authorize()
  async function userMetadata(): Promise<SkillMetadata[]> {
    if (!options.loadOwnerContext || actor.role !== 'owner') return []
    const rows = await options.pool.query(`SELECT skill_id,name,description_short,description_long,category,related_tools
      FROM user_skills WHERE owner_id=$1 AND source='user' AND enabled IS TRUE ORDER BY skill_id`, [identity.ownerId])
    return rows.rows.map(row => {
      const related: unknown = typeof row.related_tools === 'string' ? JSON.parse(row.related_tools) : row.related_tools
      if (!/^U[1-9]\d*$/.test(row.skill_id) || typeof row.name !== 'string' || typeof row.description_short !== 'string'
        || !Array.isArray(related) || related.some(name => typeof name !== 'string')) throw failure()
      return { id: row.skill_id, name: row.name, description: row.description_long || row.description_short,
        description_short: row.description_short, category: row.category, related_tools: related as string[], source: 'user' }
    })
  }
  if (!await options.authorize()) throw failure()
  const users = await userMetadata()
  const definitions: SkillDefinition[] = [...builtins, ...users.map(meta => ({ ...meta, async load(candidate: RunIdentity, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!await canRead(candidate)) throw failure()
    const rows = await options.pool.query(`SELECT body,content_digest FROM user_skills
      WHERE owner_id=$1 AND skill_id=$2 AND source='user' AND enabled IS TRUE`, [identity.ownerId, meta.id])
    if (rows.rows.length !== 1 || typeof rows.rows[0].body !== 'string' || !rows.rows[0].content_digest || !await canRead(candidate)) throw failure()
    return { content: rows.rows[0].body, contentDigest: String(rows.rows[0].content_digest) }
  } }))]
  const registry = createSkillRegistry({ skills: definitions, async authorize(candidate, id) {
    if (!await canRead(candidate)) return false
    if (id.startsWith('S')) return true
    return (await userMetadata()).some(meta => meta.id === id)
  } })
  const tools = { skills: registry, async origin(candidate: RunIdentity, id: string, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!await canRead(candidate) || !(await registry.catalog(candidate)).some(meta => meta.id === id)) throw failure()
    return id.startsWith('S') ? { source: 'builtin' as const } : { source: 'user' as const,
      ownerFingerprint: createHash('sha256').update(identity.ownerId).digest('hex') }
  } }
  const catalog: CanonicalRunPreparationPorts['capabilities']['catalog'] = async (_names, subject, _tools, signal, context) => {
    signal?.throwIfAborted()
    if (subject.ownerId !== identity.ownerId || subject.subject.kind !== 'session' || subject.subject.id !== identity.sessionId
      || !await options.authorize()) throw failure()
    const metadata = await registry.catalog(identity)
    const currentUsers = metadata.filter(meta => meta.source === 'user').map(meta => JSON.parse(JSON.stringify(meta)) as Json)
    // 跨Run冻结由Core负责；已有快照不能被当前目录悄悄替换。
    return { metadataOnly: true, toolCatalog: '',
      // 目录已由来源builder写入真实静态skillIndex，不在动态快照中重复追加。
      skillCatalog: '',
      userSkills: context?.userSkillSnapshot ? [...context.userSkillSnapshot] : currentUsers }
  }
  return { registry, tools, catalog }
}
