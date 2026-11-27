import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import type { RunIdentity, Json, CanonicalRunPreparationPorts } from '@gugu/core/agent'
import { createBuiltinSkillDefinitions, createFileSkillDefinitions, isUserSkillBundleEnabled, createSkillRegistry } from '@gugu/core/skills'
import { createBundledSkillDocuments } from '@gugu/core/skills/bundled'
import type { ImActor } from '@gugu/core/im/access'
import { imAllowsBuiltinSkill, imCanUseTool, imSkillToolsAvailable } from '@gugu/core/agent/scenes/im'
import { createAgentToolBrief } from '@gugu/core/agent/tool-brief'

const same = (a: RunIdentity, b: RunIdentity) => a.ownerId === b.ownerId && a.sessionId === b.sessionId && a.runId === b.runId
const failure = () => new Error('IM 技能资源不可用')
/** 目录只读真实元数据；正文按需读取并在发布前重新核对启用状态和当前权限。 */
export async function createImProductionSkills(options: {
  pool: Pick<Pool, 'query'>; identity: RunIdentity; actor: ImActor; loadOwnerContext: boolean; storageRoot?: string
  authorize(): Promise<boolean>
  availableTools?(): Promise<ReadonlySet<string>>
}) {
  const identity = { ...options.identity }, actor = structuredClone(options.actor)
  const builtins = (await createBuiltinSkillDefinitions(createBundledSkillDocuments(), new AbortController().signal))
    .filter(skill => imAllowsBuiltinSkill(skill.key))
  const canRead = async (candidate: RunIdentity) => same(candidate, identity) && imCanUseTool(actor, 'use_skill') && await options.authorize()
  if (!await options.authorize()) throw failure()
  const fileSkills = options.storageRoot && actor.chatType !== 'group' && actor.role === 'owner' && options.loadOwnerContext
    ? (await createFileSkillDefinitions({ dataRoot: options.storageRoot, ownerId: identity.ownerId,
      mapPath: (_path, slug, source = 'user') => `/skills/${source}/${slug}`,
      isEnabled: (owner, slug, source) => isUserSkillBundleEnabled(options.storageRoot!, owner, slug, source),
    })).definitions : []
  const fileIds = new Set(fileSkills.map(skill => skill.id))
  const registry = createSkillRegistry({ skills: [...builtins, ...fileSkills], async authorize(candidate, id) {
    if (!await canRead(candidate)) return false
    if (id.startsWith('S')) {
      if (!options.availableTools) return true
      const available = await options.availableTools()
      const skill = builtins.find(item => item.id === id)
      return available.has('use_skill') && !!skill && imSkillToolsAvailable(skill, available)
    }
    if (fileIds.has(id)) return !!options.storageRoot && await isUserSkillBundleEnabled(options.storageRoot, identity.ownerId, id,
      fileSkills.find(skill => skill.id === id)?.storage_source ?? 'user')
    return false
  } })
  const tools = { skills: registry, async origin(candidate: RunIdentity, id: string, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!await canRead(candidate) || !(await registry.catalog(candidate)).some(meta => meta.id === id)) throw failure()
    return id.startsWith('S') ? { source: 'builtin' as const } : { source: 'user' as const,
      ownerFingerprint: createHash('sha256').update(identity.ownerId).digest('hex') }
  } }
  const catalog: CanonicalRunPreparationPorts['capabilities']['catalog'] = async (names, subject, tools, signal, context) => {
    signal?.throwIfAborted()
    if (subject.ownerId !== identity.ownerId || subject.subject.kind !== 'session' || subject.subject.id !== identity.sessionId
      || !await options.authorize()) throw failure()
    const [metadata, preferences] = await Promise.all([
      registry.catalog(identity),
      options.pool.query('SELECT data_json FROM user_preferences WHERE user_id=$1', [identity.ownerId]),
    ])
    signal?.throwIfAborted()
    if (!await options.authorize()) throw failure()
    const allowed = new Set(names)
    const currentUsers = metadata.filter(meta => meta.source === 'user').map(meta => JSON.parse(JSON.stringify(meta)) as Json)
    return createAgentToolBrief(preferences.rows[0]?.data_json,
      (tools ?? []).filter(tool => allowed.has(tool.name) && imCanUseTool(actor, tool.name)),
      context?.userSkillSnapshot ?? currentUsers)
  }
  return { registry, tools, catalog }
}
