import { constants } from 'node:fs'
import { mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { CoreError } from '../../contracts/index.js'
import { createSkillRegistry } from './registry.js'
import type { AgentSkillRuntimePorts } from './runtime.js'
import type { SkillListEntry } from './user-read.js'
import type { BuiltinSkillDefinition } from './builtin.js'
import type { SkillDefinition } from './contracts.js'
import type { RunIdentity } from '../models.js'
import { parseSkillDocument, SKILL_ENTRY_FILE, skillBundleDirectory, userSkillDirectory, type SkillStorageSource } from './bundle.js'
import { ensureSkillDirectory } from './safe-directory.js'

/** 从可信用户目录读取技能文档，并确认目录和文件都没有逃出该用户的技能根。 */
export async function readSkillBundle(dataRoot: string, ownerId: string, storageSource: SkillStorageSource, slug: string) {
  const directory = skillBundleDirectory(dataRoot, ownerId, storageSource, slug)
  const root = skillBundleDirectory(dataRoot, ownerId, storageSource, 'placeholder')
  const skillsRoot = join(root, '..')
  const realBase = await realpath(dataRoot)
  const realRoot = await realpath(skillsRoot)
  const expectedRoot = join(realBase, relative(dataRoot, skillsRoot))
  if (realRoot !== expectedRoot)
    throw new CoreError('invalid_request', '技能根目录无效')
  const realDirectory = await realpath(directory)
  if (realDirectory !== join(realRoot, slug))
    throw new CoreError('invalid_request', '技能目录无效')
  const file = await open(join(realDirectory, SKILL_ENTRY_FILE), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 256 * 1024)
      throw new CoreError('invalid_request', '技能文档无效或超过大小限制')
    const buffer = Buffer.alloc(256 * 1024 + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 256 * 1024) throw new CoreError('invalid_request', '技能文档超过大小限制')
    const source = buffer.subarray(0, bytesRead).toString('utf8')
    const document = parseSkillDocument(source)
    return { ...document, path: realDirectory, storage_source: storageSource, contentDigest: createHash('sha256').update(source).digest('hex') }
  } finally {
    await file.close()
  }
}

export const readUserSkillBundle = (dataRoot: string, ownerId: string, slug: string) => readSkillBundle(dataRoot, ownerId, 'user', slug)
export const readClawHubSkillBundle = (dataRoot: string, ownerId: string, slug: string) => readSkillBundle(dataRoot, ownerId, 'clawhub', slug)

function bundleEnabled(metadata: Record<string, unknown>) {
  const extension = metadata.metadata
  const gugu = extension && typeof extension === 'object' && !Array.isArray(extension)
    ? (extension as Record<string, unknown>).gugu : undefined
  return !(gugu && typeof gugu === 'object' && !Array.isArray(gugu)
    && (gugu as Record<string, unknown>).enabled === false)
}

/** 停用状态保存在技能文档的 Gugu 元数据，缺省为启用。 */
export async function isUserSkillBundleEnabled(dataRoot: string, ownerId: string, slug: string, source: SkillStorageSource = 'user') {
  try {
    const { metadata } = await readSkillBundle(dataRoot, ownerId, source, slug)
    return bundleEnabled(metadata)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** 解析当前用户的技能引用；目录名无效或技能不存在时返回空。 */
export async function readFileSkillReference(dataRoot: string, ownerId: string, slug: string) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(slug)) return null
  for (const source of ['user', 'clawhub'] as const) {
    try {
      const skill = await readSkillBundle(dataRoot, ownerId, source, slug)
      return { id: slug, name: skill.name, description: skill.description, enabled: bundleEnabled(skill.metadata), path: skill.path, storage_source: source }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return null
}

/** 管理页面读取文件技能与保留的 Gugu 元数据，不暴露宿主物理路径。 */
export async function listUserSkillBundles(dataRoot: string, ownerId: string) {
  const [user, clawhub] = await Promise.all([
    discoverSkillBundles(dataRoot, ownerId, 'user'),
    discoverSkillBundles(dataRoot, ownerId, 'clawhub'),
  ])
  const skills = [...user.skills, ...clawhub.skills]
  const invalid = [...user.invalid, ...clawhub.invalid]
  const entries = []
  for (const item of skills) {
    const document = await readSkillBundle(dataRoot, ownerId, item.storage_source, item.slug)
    const extension = document.metadata.metadata
    const gugu = extension && typeof extension === 'object' && !Array.isArray(extension)
      ? (extension as Record<string, unknown>).gugu : undefined
    const fields = gugu && typeof gugu === 'object' && !Array.isArray(gugu) ? gugu as Record<string, unknown> : {}
    entries.push({ id: item.slug, name: document.name, description_short: document.description,
      description_long: typeof fields.description_long === 'string' ? fields.description_long : null,
      category: typeof fields.category === 'string' ? fields.category : 'personal',
      related_tools: Array.isArray(fields.related_tools) ? fields.related_tools.filter((tool): tool is string => typeof tool === 'string') : [],
      body: document.body, source: 'user', storage_source: item.storage_source,
      managed_by: fields.managed_by === 'assistant' ? 'assistant' as const : 'user' as const,
      enabled: bundleEnabled(document.metadata), content_digest: document.contentDigest,
      created_at: null, updated_at: null, storage_kind: 'file' as const })
  }
  return { skills: entries, invalid }
}

/** 创建独立技能目录，已有目标时报告冲突并保留原内容。 */
export async function createUserSkillBundle(dataRoot: string, ownerId: string, slug: string, source: string) {
  parseSkillDocument(source)
  const directory = userSkillDirectory(dataRoot, ownerId, slug)
  const skillsRoot = join(directory, '..')
  await ensureSkillDirectory(dataRoot, skillsRoot)
  await mkdir(directory, { mode: 0o700 })
  let createdFile = false
  try {
    const file = await open(join(directory, SKILL_ENTRY_FILE), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    createdFile = true
    try {
      await file.writeFile(source, 'utf8')
      await file.sync()
    } finally { await file.close() }
  } catch (error) {
    if (createdFile) await unlink(join(directory, SKILL_ENTRY_FILE)).catch(() => {})
    await rmdir(directory).catch(() => {})
    throw error
  }
  return readUserSkillBundle(dataRoot, ownerId, slug)
}

/** 由宿主提供授权判断和目录映射，技能正文始终从当前文件读取。 */
export function createUserSkillBundleReader(options: {
  dataRoot: string
  resolveSlug(ownerId: string, skillId: string): Promise<string | null>
}) {
  return async (ownerId: string, skillId: string) => {
    const slug = await options.resolveSlug(ownerId, skillId)
    if (slug === null) return null
    const bundle = await readUserSkillBundle(options.dataRoot, ownerId, slug)
    return { id: skillId, name: bundle.name, body: bundle.body, contentDigest: bundle.contentDigest }
  }
}

/** 发现单个用户下的技能目录，损坏的技能单独报告，不阻断其他技能。 */
export async function discoverUserSkillBundles(dataRoot: string, ownerId: string) {
  return discoverSkillBundles(dataRoot, ownerId, 'user')
}

export async function discoverSkillBundles(dataRoot: string, ownerId: string, source: SkillStorageSource) {
  const root = join(skillBundleDirectory(dataRoot, ownerId, source, 'placeholder'), '..')
  let names: string[]
  try { names = await readdir(root) }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { skills: [], invalid: [] }
    throw error
  }
  const skills: Array<{ slug: string; name: string; description: string; path: string; contentDigest: string; storage_source: SkillStorageSource }> = []
  const invalid: string[] = []
  for (const slug of names.sort()) {
    try {
      const skill = await readSkillBundle(dataRoot, ownerId, source, slug)
      skills.push({ slug, name: skill.name, description: skill.description, path: skill.path, contentDigest: skill.contentDigest, storage_source: source })
    } catch {
      invalid.push(slug)
    }
  }
  return { skills, invalid }
}

/** 将文件技能注册到当前用户的 Agent；运行环境目录由宿主映射。 */
export async function createFileSkillDefinitions(options: {
  dataRoot: string
  ownerId: string
  mapPath(path: string, slug: string, source?: SkillStorageSource): string | undefined
  isEnabled(ownerId: string, slug: string, source?: SkillStorageSource): Promise<boolean>
}) {
  const { skills, invalid } = await Promise.all(['user', 'clawhub'].map(source => discoverSkillBundles(options.dataRoot, options.ownerId, source as SkillStorageSource)))
    .then(groups => ({ skills: groups.flatMap(group => group.skills), invalid: groups.flatMap(group => group.invalid) }))
  const enabled = await Promise.all(skills.map(skill => options.isEnabled(options.ownerId, skill.slug, skill.storage_source)))
  const definitions: SkillDefinition[] = skills.filter((_, index) => enabled[index]).map(skill => ({
    id: skill.slug,
    name: skill.name,
    description: skill.description,
    source: 'user' as const,
    storage_source: skill.storage_source,
    path: options.mapPath(skill.path, skill.slug, skill.storage_source),
    async load(identity: RunIdentity, signal: AbortSignal) {
      signal.throwIfAborted()
      if (identity.ownerId !== options.ownerId) throw new Error('技能不存在或未开放')
      const current = await readSkillBundle(options.dataRoot, options.ownerId, skill.storage_source, skill.slug)
      signal.throwIfAborted()
      return { content: current.body, contentDigest: current.contentDigest }
    },
  }))
  return { definitions, invalid }
}

export async function createFileSkillRegistry(options: {
  dataRoot: string
  ownerId: string
  builtins?: readonly BuiltinSkillDefinition[]
  mapPath(path: string, slug: string, source?: SkillStorageSource): string | undefined
  isEnabled(ownerId: string, slug: string, source?: SkillStorageSource): Promise<boolean>
}) {
  const { definitions, invalid } = await createFileSkillDefinitions(options)
  const builtinIds = new Set((options.builtins ?? []).map(skill => skill.id))
  const registry = createSkillRegistry({
    skills: [...(options.builtins ?? []), ...definitions],
    async authorize(identity, id) {
      if (identity.ownerId !== options.ownerId) return false
      if (builtinIds.has(id)) return true
      const skill = definitions.find(item => item.id === id)
      return !!skill && await options.isEnabled(options.ownerId, id, skill.storage_source)
    },
  })
  return { registry, invalid }
}

/** 为 Agent 工具提供文件技能注册器及用户来源指纹。 */
export async function createFileSkillRuntime(options: {
  dataRoot: string
  ownerId: string
  builtins?: readonly BuiltinSkillDefinition[]
  mapPath(path: string, slug: string, source?: SkillStorageSource): string | undefined
  fingerprint(ownerId: string): string
  isEnabled(ownerId: string, slug: string, source?: SkillStorageSource): Promise<boolean>
}): Promise<AgentSkillRuntimePorts & { invalid: string[] }> {
  const { registry, invalid } = await createFileSkillRegistry(options)
  const ownerFingerprint = options.fingerprint(options.ownerId)
  if (!ownerFingerprint.trim()) throw new CoreError('invalid_request', '技能来源无效')
  return {
    skills: registry,
    invalid,
    async origin(identity, id, signal) {
      signal.throwIfAborted()
      if (identity.ownerId !== options.ownerId || !(await registry.catalog(identity)).some(skill => skill.id === id))
        throw new CoreError('not_found', '技能不存在或未开放')
      signal.throwIfAborted()
      if (options.builtins?.some(skill => skill.id === id)) return { source: 'builtin' }
      return { source: 'user', ownerFingerprint }
    },
  }
}

/** 文件技能加入管理目录；停用项可见，正文及内容摘要不进入模型目录。 */
export function withFileSkillMetadata(options: {
  dataRoot: string
  list(ownerId: string, signal: AbortSignal): Promise<{ count: number; skills: readonly SkillListEntry[] }>
  mapPath(path: string, slug: string, source?: SkillStorageSource): string | undefined
}) {
  return async (ownerId: string, signal: AbortSignal) => {
    const [existing, bundles] = await Promise.all([options.list(ownerId, signal), listUserSkillBundles(options.dataRoot, ownerId)])
    signal.throwIfAborted()
    const files: SkillListEntry[] = bundles.skills.map(skill => {
      const path = options.mapPath(skillBundleDirectory(options.dataRoot, ownerId, skill.storage_source, skill.id), skill.id, skill.storage_source)
      return { id: skill.id, name: skill.name, description_short: skill.description_short, category: skill.category,
        related_tools: skill.related_tools, enabled: skill.enabled, source: 'user', storage_source: skill.storage_source, managed_by: skill.managed_by,
        ...(path === undefined ? {} : { path }),
      }
    })
    const skills = [...existing.skills, ...files]
    return { count: skills.length, skills }
  }
}
