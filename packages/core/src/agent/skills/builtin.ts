import type { SkillDefinition } from './contracts.js'
import { strip } from '../../shared/values.js'

/** 资源位置及读取权限由 Host 决定；Core 不枚举目录或解释模型提供的路径。 */
export interface BuiltinSkillDocument {
  readonly name: string
  read(signal: AbortSignal): Promise<string>
}

export interface BuiltinSkillDefinition extends SkillDefinition {
  readonly key: string
  readonly emoji: string
  readonly category: string
  readonly source: 'builtin'
  readonly related_tools: readonly string[]
}

// 此映射冻结在编号改为动态分配之前，只用于读取旧配置和已保存的回执。
const legacySkillKeys = new Map([
  ['S1', 'canvas'], ['S2', 'email'], ['S3', 'file-ops'], ['S4', 'im-bind'],
  ['S5', 'image-analysis'], ['S6', 'knowledge-writing'], ['S7', 'chart-and-math'],
  ['S8', 'note-writing'], ['S9', 'project-planning'], ['S12', 'weather'],
  ['S13', 'web-search'], ['S14', 'skill-management'],
])

export function legacyBuiltinSkillKey(id: string): string | undefined {
  return legacySkillKeys.get(id)
}

export const builtinSkillKeyPattern = /^[a-z0-9][a-z0-9._-]*$/u

function clean(value = ''): string {
  return strip(value).replace(/^"+|"+$/gu, '').replace(/^'+|'+$/gu, '')
}

/** 沿用 Python 扁平 key:value frontmatter，不将此格式扩展为 YAML。 */
function parse(document: string): { metadata: Omit<BuiltinSkillDefinition, 'load' | 'id' | 'key'>; body: string } | null {
  const text = document.replace(/\r\n?/gu, '\n')
  const fields = new Map<string, string>()
  let body = text
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3)
    if (end !== -1) {
      body = text.slice(end + 4).replace(/^\n+/u, '')
      for (const line of text.slice(3, end).split(/[\n\v\f\x1c-\x1e\x85\u2028\u2029]/u)) {
        const colon = line.indexOf(':')
        if (colon !== -1) fields.set(strip(line.slice(0, colon)), strip(line.slice(colon + 1)))
      }
    }
  }
  const name = clean(fields.get('name'))
  const description = clean(fields.get('description'))
  if (!name || !description || fields.has('id') || fields.has('description_short') || fields.has('description_long')) return null
  const related_tools = clean(fields.get('related_tools')).replace(/^\[+|\]+$/gu, '').split(',').map(strip).filter(Boolean)
  if (clean(fields.get('source') ?? 'builtin') !== 'builtin') throw new Error('技能来源无效')
  return { metadata: {
    name, description, related_tools: Object.freeze(related_tools),
    category: clean(fields.get('category')), source: 'builtin', emoji: clean(fields.get('emoji')),
  }, body: strip(body) }
}

async function read(document: BuiltinSkillDocument, signal: AbortSignal) {
  signal.throwIfAborted()
  try {
    const text = await document.read(signal)
    signal.throwIfAborted()
    if (typeof text !== 'string') throw new Error('技能资源格式无效')
    return parse(text)
  } catch {
    signal.throwIfAborted()
    throw new Error('内置技能资源读取失败')
  }
}

/** 初次读取冻结目录元数据，后续正文每次重读；不负责资源打包或 use_skill Host 装配。 */
export async function createBuiltinSkillDefinitions(documents: readonly BuiltinSkillDocument[], signal: AbortSignal): Promise<BuiltinSkillDefinition[]> {
  const definitions: BuiltinSkillDefinition[] = []
  const keys = new Set<string>()
  const ordered = documents.filter(document => document.name.toUpperCase() !== 'README.MD')
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  for (const document of ordered) {
    const key = document.name.slice(0, -3)
    if (!document.name.endsWith('.md') || !builtinSkillKeyPattern.test(key) || keys.has(key))
      throw new Error('内置技能文件名无效或重复')
    keys.add(key)
    const parsed = await read(document, signal)
    if (!parsed) continue
    const metadata = Object.freeze({ ...parsed.metadata, key, id: `S${definitions.length + 1}` })
    definitions.push(Object.freeze({ ...metadata, async load(_identity, loadSignal) {
      const current = await read(document, loadSignal)
      if (!current) throw new Error('内置技能文档无效')
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(current.body))
      loadSignal.throwIfAborted()
      return { content: current.body, contentDigest: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16) }
    } } satisfies BuiltinSkillDefinition))
  }
  return definitions
}

export function formatBuiltinSkillIndex(builtinSkillDefinitions: readonly BuiltinSkillDefinition[]): string {
  return builtinSkillDefinitions.length ? [
    '## 可用技能',
    '下列技能是带触发条件的做法剧本。命中场景时，第一工具调用必须是 `use_skill` 拉取对应正文；正文加载前禁止直接调用该技能负责的业务工具。',
    'Skill ID（S/U 编号）仅用于内部调用；对用户提及技能时使用技能名称，不展示内部 ID，除非用户明确询问。',
    '列出当前账号的完整技能目录时调用 `list_skills`；目录包含停用项但不包含正文。',
    ...builtinSkillDefinitions.map(skill => `- ${skill.emoji ? `${skill.emoji} ` : ''}**${skill.name}**（Skill ID：\`${skill.id}\`）${skill.description ? ` — ${skill.description}` : ''}`),
  ].join('\n') : ''
}
