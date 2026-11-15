import type { SkillDefinition } from './contracts.js'
import { strip } from '../../shared/values.js'

/** 资源位置及读取权限由 Host 决定；Core 不枚举目录或解释模型提供的路径。 */
export interface BuiltinSkillDocument {
  readonly name: string
  read(signal: AbortSignal): Promise<string>
}

export interface BuiltinSkillDefinition extends SkillDefinition {
  readonly description_short: string
  readonly description_long: string
  readonly emoji: string
  readonly category: string
  readonly source: 'builtin' | 'user'
  readonly related_tools: readonly string[]
}

function clean(value = ''): string {
  return strip(value).replace(/^"+|"+$/gu, '').replace(/^'+|'+$/gu, '')
}

/** 沿用 Python 扁平 key:value frontmatter，不将此格式扩展为 YAML。 */
function parse(document: string): { metadata: Omit<BuiltinSkillDefinition, 'load'>; body: string } | null {
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
  const id = clean(fields.get('id'))
  if (!/^S[0-9]+$/u.test(id)) return null
  const description_short = clean(fields.get('description_short'))
  const description_long = clean(fields.get('description_long'))
  const related_tools = clean(fields.get('related_tools')).replace(/^\[+|\]+$/gu, '').split(',').map(strip).filter(Boolean)
  const source = clean(fields.get('source') ?? 'builtin') || 'builtin'
  if (source !== 'builtin' && source !== 'user') throw new Error('技能来源无效')
  return { metadata: {
    id, name: clean(fields.get('name') ?? id), description: description_short,
    description_short, description_long, related_tools: Object.freeze(related_tools),
    category: clean(fields.get('category')), source, emoji: clean(fields.get('emoji')),
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
  const ids = new Set<string>()
  for (const document of documents) {
    if (document.name.toUpperCase() === 'README.MD') continue
    const parsed = await read(document, signal)
    if (!parsed) continue
    if (ids.has(parsed.metadata.id)) throw new Error('内置技能ID重复')
    ids.add(parsed.metadata.id)
    const metadata = Object.freeze(parsed.metadata)
    definitions.push(Object.freeze({ ...metadata, async load(_identity, loadSignal) {
      const current = await read(document, loadSignal)
      if (!current || current.metadata.id !== metadata.id) throw new Error('内置技能ID已变化')
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(current.body))
      loadSignal.throwIfAborted()
      return { content: current.body, contentDigest: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16) }
    } } satisfies BuiltinSkillDefinition))
  }
  return definitions
}
