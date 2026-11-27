import { isMap, parseDocument, stringify } from 'yaml'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { normalizeUserSkill, type UserSkillInput } from './user-validation.js'
import { CoreError, dataContext } from '../../contracts/index.js'
import type { SkillMetadata } from './contracts.js'

export type SkillStorageSource = 'user' | 'clawhub'

/** 用户 UUID 来自可信运行身份，来源和技能 slug 都是固定单段目录名。 */
export function skillBundleDirectory(dataRoot: string, ownerId: string, source: SkillStorageSource, slug: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(slug))
    throw new CoreError('invalid_request', '技能目录名无效')
  return join(dataRoot, dataContext(ownerId).ownerId, '.agent', 'skills', source, slug)
}

export function userSkillDirectory(dataRoot: string, ownerId: string, slug: string): string {
  return skillBundleDirectory(dataRoot, ownerId, 'user', slug)
}

export function clawHubSkillDirectory(dataRoot: string, ownerId: string, slug: string): string {
  return skillBundleDirectory(dataRoot, ownerId, 'clawhub', slug)
}

export function projectSkillDirectoryEntry(item: SkillMetadata) {
  return {
    id: item.id,
    name: item.name,
    description: item.description_short || item.description,
    ...(item.path === undefined ? {} : { path: item.path }),
  }
}

export const SKILL_ENTRY_FILE = 'SKILL.md'
const maxSkillBytes = 256 * 1024
const frontmatterPattern = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u

export function parseSkillDocument(source: string) {
  if (Buffer.byteLength(source) > maxSkillBytes)
    throw new CoreError('invalid_request', '技能文档超过大小限制')
  const header = frontmatterPattern.exec(source)
  if (!header) throw new CoreError('invalid_request', '技能文档缺少 YAML frontmatter')
  const document = parseDocument(header[1]!, { uniqueKeys: true })
  if (document.errors.length || document.warnings.length)
    throw new CoreError('invalid_request', '技能 YAML 元数据无效')
  let fields: unknown
  try { fields = document.toJS({ maxAliasCount: 0 }) }
  catch { throw new CoreError('invalid_request', '技能 YAML 元数据无效') }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)
    || !('name' in fields) || typeof fields.name !== 'string' || !fields.name.trim()
    || !('description' in fields) || typeof fields.description !== 'string' || !fields.description.trim())
    throw new CoreError('invalid_request', '技能需提供名称和描述')
  return {
    name: fields.name.trim(), description: fields.description.trim(),
    frontmatter: header[1]!, metadata: fields as Record<string, unknown>,
    body: source.slice(header[0].length), source,
  }
}

export function serializeSkillDocument(frontmatter: Record<string, unknown>, body: string) {
  const source = `---\n${stringify(frontmatter)}---\n${body}`
  parseSkillDocument(source)
  return source
}

export interface SkillDocumentPatch {
  name?: string
  description?: string
  body?: string
  enabled?: boolean
  descriptionLong?: string | null
  category?: string
  relatedTools?: readonly string[]
}

/** 只更新指定字段，保留未识别的 YAML 元数据、注释与完整正文。 */
export function patchSkillDocument(source: string, patch: SkillDocumentPatch) {
  const original = parseSkillDocument(source)
  const doc = parseDocument(original.frontmatter, { uniqueKeys: true })
  if (!isMap(doc.contents)) throw new CoreError('invalid_request', '技能元数据无效')
  const textField = (value: string, limit: number) => {
    if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > limit)
      throw new CoreError('invalid_request', '技能字段长度无效')
    return value.trim()
  }
  if (patch.name !== undefined) doc.set('name', textField(patch.name, 120))
  if (patch.description !== undefined) doc.set('description', textField(patch.description, 100))
  if (patch.body !== undefined && (typeof patch.body !== 'string' || !patch.body.trim()))
    throw new CoreError('invalid_request', '技能正文不能为空')
  const hasExtension = patch.enabled !== undefined || patch.descriptionLong !== undefined
    || patch.category !== undefined || patch.relatedTools !== undefined
  if (hasExtension) {
    if (doc.has('metadata') && !isMap(doc.get('metadata', true)))
      throw new CoreError('conflict', '技能 metadata 不是对象，无法更新')
    if (!doc.has('metadata')) doc.set('metadata', doc.createNode({}))
    const metadata = doc.get('metadata', true)
    if (!isMap(metadata)) throw new CoreError('conflict', '技能 metadata 不是对象，无法更新')
    if (metadata.has('gugu') && !isMap(metadata.get('gugu', true)))
      throw new CoreError('conflict', '技能 Gugu 元数据不是对象，无法更新')
    if (!metadata.has('gugu')) metadata.set('gugu', doc.createNode({}))
    const gugu = metadata.get('gugu', true)
    if (!isMap(gugu)) throw new CoreError('conflict', '技能 Gugu 元数据不是对象，无法更新')
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new CoreError('invalid_request', '技能启用状态无效')
      gugu.set('enabled', patch.enabled)
    }
    if (patch.descriptionLong !== undefined) {
      if (patch.descriptionLong !== null && (typeof patch.descriptionLong !== 'string' || [...patch.descriptionLong].length > 500))
        throw new CoreError('invalid_request', '技能描述过长')
      gugu.set('description_long', patch.descriptionLong)
    }
    if (patch.category !== undefined) gugu.set('category', textField(patch.category, 32))
    if (patch.relatedTools !== undefined) {
      if (!Array.isArray(patch.relatedTools) || patch.relatedTools.length > 32
        || patch.relatedTools.some(tool => typeof tool !== 'string' || !tool.trim() || tool.length > 128))
        throw new CoreError('invalid_request', '技能关联工具无效')
      gugu.set('related_tools', [...new Set(patch.relatedTools.map(tool => tool.trim()))])
    }
  }
  const updated = `---\n${String(doc)}---\n${patch.body ?? original.body}`
  parseSkillDocument(updated)
  return updated
}

/** 根据共享规则生成可移植的用户技能文档。 */
export function createUserSkillDocument(input: UserSkillInput & { enabled?: boolean; managed_by?: 'user' | 'assistant' }, knownTools: ReadonlySet<string>) {
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean')
    throw new CoreError('invalid_request', '技能启用状态无效')
  if (input.managed_by !== undefined && input.managed_by !== 'user' && input.managed_by !== 'assistant')
    throw new CoreError('invalid_request', '技能管理者无效')
  const skill = normalizeUserSkill(input, knownTools, body => createHash('sha256').update(body).digest('hex'))
  return serializeSkillDocument({ name: skill.name, description: skill.description_short, metadata: { gugu: {
    enabled: input.enabled ?? true, description_long: skill.description_long, category: skill.category,
    related_tools: skill.related_tools, managed_by: input.managed_by ?? 'user',
  } } }, skill.body)
}
