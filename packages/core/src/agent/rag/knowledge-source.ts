import { createHash } from 'node:crypto'
import { dataContext } from '../../contracts/index.js'
import { utc } from '../../data/codec.js'
import type { AgentKnowledgeReadStore } from '../knowledge/overview.js'
import { buildSourceDocuments } from './index-builder.js'
import type { RagRebuildSource } from './rebuild-worker.js'

type JsonObject = Record<string, unknown>
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/u.test(value)

function jsonField(fields: Record<string, string>, key: string): unknown {
  try { return JSON.parse(fields[key] ?? '') } catch { return undefined }
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d\d(?::?\d\d)?)$/iu.test(value)) throw new Error('时间无效')
  return utc(value).replace(' ', 'T').replace(/\.(\d{1,6})\+00:00$/u, (_match, fraction: string) => `.${fraction.padEnd(6, '0')}+00:00`)
}

export function parseAgentKnowledgeRecord(raw: Uint8Array) {
  const text = new TextDecoder('utf-8').decode(raw)
  if (!text.startsWith('---\n')) throw new Error('知识文件格式无效')
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) throw new Error('知识文件格式无效')
  const fields: Record<string, string> = Object.create(null)
  for (const line of text.slice(4, end).split('\n')) {
    const separator = line.indexOf(':')
    if (separator >= 0) fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replaceAll('\\n', '\n').replaceAll('\\\\', '\\')
  }
  const id = fields.id
  const scope = jsonField(fields, 'scope_json')
  const source = jsonField(fields, 'source_json')
  const keywords = jsonField(fields, 'keywords_json')
  if (!id || !object(scope) || !object(source) || !Array.isArray(keywords)) throw new Error('知识记录无效')
  const version = Number(fields.version ?? '1')
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('知识版本无效')
  const owner = typeof scope.owner_user_id === 'string' ? dataContext(scope.owner_user_id).ownerId : ''
  const scopeType = typeof scope.type === 'string' ? scope.type : 'owner'
  if (!['owner', 'workspace', 'project', 'folder', 'group', 'member', 'system'].includes(scopeType)) throw new Error('知识范围无效')
  if (typeof source.type !== 'string' || !['user', 'file', 'web', 'derived', 'conversation'].includes(source.type)) throw new Error('知识来源无效')
  const createdAt = timestamp(fields.created_at)
  const updatedAt = timestamp(fields.updated_at)
  const content = text.slice(end + '\n---\n'.length).replace(/^\n/u, '').replace(/\n+$/u, '')
  const cleanKeywords = keywords.map(value => typeof value === 'string' ? value.trim() : '').filter(Boolean)
  const keywordText = cleanKeywords.join('、')
  const topic = fields.topic ?? ''
  const description = fields.description ?? ''
  const sourceLabel = typeof source.label === 'string' ? source.label : ''
  let summary = topic || sourceLabel || source.type
  if (keywordText) summary += `；关键词：${keywordText}`
  if (description) summary += `；${description}`
  const revision = createHash('sha256').update(`${keywordText}\n${description}`, 'utf8').digest('hex').slice(0, 12)
  const metadata: Record<string, string | number | boolean | null> = {
    topic,
    keywords: keywordText,
    description,
    confidence: fields.confidence ?? 'confirmed',
    source_type: source.type,
    source_ref: typeof source.ref === 'string' ? source.ref : '',
    source_label: sourceLabel,
    parent_id: fields.parent_id ?? '',
    project_id: typeof scope.project_id === 'string' ? scope.project_id : '',
  }
  return {
    id,
    source_type: 'knowledge',
    source_id: id,
    parent_id: id,
    title: fields.title ?? '',
    summary,
    content,
    document_version: `${version}:k${revision}`,
    created_at: createdAt,
    updated_at: updatedAt,
    scope: {
      scope_type: scopeType,
      scope_id: typeof scope.scope_id === 'string' ? scope.scope_id : '',
      platform: typeof scope.platform === 'string' ? scope.platform : '',
      bot_id: typeof scope.bot_id === 'string' ? scope.bot_id : '',
      group_id: typeof scope.group_id === 'string' ? scope.group_id : '',
    },
    metadata,
    owner,
    active: (fields.active ?? 'true').toLowerCase() === 'true',
  }
}

/** 从 Host 注入的 owner 授权 FS 读取知识 Markdown，DB 只接收可重建索引投影。 */
export function createKnowledgeRagSource(store: AgentKnowledgeReadStore): RagRebuildSource {
  if (!store || typeof store.exists !== 'function' || typeof store.list !== 'function' || typeof store.read !== 'function') throw new TypeError('知识 RAG 存储未装配')
  return async (rawOwner, sourceId, signal) => {
    signal?.throwIfAborted()
    const owner = dataContext(rawOwner).ownerId
    if (sourceId !== null && !safeId(sourceId)) throw new Error('RAG 知识标识无效')
    const base = `${owner}/.agent/knowledge/`, prefix = `${base}entries/`
    const keys: string[] = []
    if (sourceId !== null) {
      const key = `${prefix}${sourceId}.md`
      if (await store.exists(key)) keys.push(key)
    }
    else {
      const seen = new Set<string>()
      let cursor: string | null = null
      do {
        signal?.throwIfAborted()
        const page = await store.list(prefix, cursor, 500)
        if (!page || !Array.isArray(page.keys) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) throw new Error('知识 RAG 列表读取失败')
        for (const key of page.keys) {
          if (typeof key !== 'string' || !key.startsWith(prefix)) throw new Error('知识 RAG 路径无效')
          const name = key.slice(prefix.length)
          if (!name.endsWith('.md')) continue
          if (name.includes('/') || name.includes('\\') || !safeId(name.slice(0, -3))) throw new Error('知识 RAG 路径无效')
          keys.push(key)
        }
        cursor = page.nextCursor
        if (cursor !== null && (!cursor || seen.has(cursor))) throw new Error('知识 RAG 游标无效')
        if (cursor !== null) seen.add(cursor)
      } while (cursor !== null)
    }
    signal?.throwIfAborted()
    if (!keys.length) return []
    if (!await store.exists(`${base}.timestamps-iso-v1`)) throw new Error('知识时间格式尚未迁移')
    const records = []
    for (const key of keys) {
      signal?.throwIfAborted()
      let record
      try { record = parseAgentKnowledgeRecord(await store.read(key)) } catch { continue }
      if (record.owner !== owner || !record.active) continue
      records.push(record)
    }
    records.sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.id.localeCompare(left.id))
    signal?.throwIfAborted()
    return buildSourceDocuments({ knowledge: records })
  }
}
