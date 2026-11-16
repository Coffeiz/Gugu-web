import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { textVersion, buildDocuments } from '../../../src/agent/rag/adapters/base.js'
import { calendarAdapter } from '../../../src/agent/rag/adapters/calendar.js'
import { canvasAdapter } from '../../../src/agent/rag/adapters/canvas.js'
import { conversationAdapter } from '../../../src/agent/rag/adapters/conversations.js'
import { noteAdapter } from '../../../src/agent/rag/adapters/note.js'
import { scheduledTaskAdapter } from '../../../src/agent/rag/adapters/scheduled-tasks.js'
import { buildSourceDocuments } from '../../../src/agent/rag/index-builder.js'

const projectionFixture = JSON.parse(readFileSync(new URL('../../../../../docs/testing/fixtures/rag-conversation-projection.json', import.meta.url), 'utf8')) as {
  owner: string
  scope: { scope_type: string; scope_id: string }
  records: Array<{
    id: string | number
    kind: 'summary' | 'message'
    session_id: number
    summary?: string
    content?: string
    role?: string
    context_before?: string
    context_after?: string
    title: string
    session_source: string
    session_updated_at: string
    version_parts: Array<string | number>
    updated_at: string
    expected: {
      source_id: string
      parent_document_id: string
      title: string
      summary: string
      content: string
      version: string
      contextual_content?: string
      metadata: Record<string, string>
    }
  }>
}

const ownerScope = { scope_type: 'owner', scope_id: '' }

describe('1.7.7 RAG source adapter projection compatibility', () => {
  it('matches the frozen Python-compatible text version digest', () => {
    expect(textVersion('缓存', '1', '2')).toBe('ad215db968f57716')
    expect(textVersion('', '')).toBe(textVersion('', ''))
  })

  it('note prefers plain text and does not duplicate fallback title into its body', () => {
    const [document] = noteAdapter.toDocuments([{
      id: 3, title: '', content_plain: '纯文本', content_md: '**md**', kind: 'note',
      version_parts: [3, 'v1', 'hash'], scope: ownerScope,
    }])
    expect(document).toMatchObject({ title: '便签', content: '纯文本', text: '便签\n纯文本',
      metadata: { node_id: '3', kind: 'note' } })
  })

  it('calendar keeps all-day fallback and omits an empty description row', () => {
    const [document] = calendarAdapter.toDocuments([{
      id: 9, title: '发布会', date: '2026-09-10', time: '', description: '',
      version_parts: [9, 'v1', '2026-09-10', ''], scope: ownerScope,
    }])
    const body = '活动：发布会\n日期：2026-09-10\n时间：全天'
    expect(document).toMatchObject({ content: body, text: `发布会\n${body}`,
      metadata: { event_id: '9', project_id: '' } })
  })

  it('scheduled task keeps the legacy row order and trims an empty trailing payload', () => {
    const [document] = scheduledTaskAdapter.toDocuments([{
      id: 5, name: '日报', cron: '0 9 * * *', enabled: false,
      version_parts: [5, '2026-09-09T00:00:00', '0 9 * * *', ''], scope: ownerScope,
    }])
    const body = '定时任务：日报\n计划：0 9 * * *\n状态：停用'
    expect(document).toMatchObject({ content: body, text: `日报\n${body}`,
      metadata: { task_id: '5', enabled: false } })
  })

  it('canvas keeps stable item identity and the relation summary prefix', () => {
    const [document] = canvasAdapter.toDocuments([{
      id: 21, canvas_id: 2, canvas_title: '发布规划', node_id: 9, node_title: '接口',
      node_type: 'canvas_note', content: '接口说明', group_path: '后端',
      relation_summary: '接口 → 测试', project_id: 4,
      version_parts: [21, '2026-09-09T00:00:00', 'v2'], updated_at: '2026-09-09T00:00:00',
      scope: ownerScope,
    }])
    const body = '画布：发布规划\n节点：接口\n类型：canvas_note\n分组：后端\n关系：接口 → 测试\n接口说明'
    expect(document).toMatchObject({ id: 'canvas:canvas:21:0', parent_id: 'canvas:21',
      title: '发布规划 · 接口', content: body, text: `发布规划 · 接口\n${body}`,
      metadata: { canvas_id: '2', node_id: '9', node_type: 'canvas_note', group_path: '后端',
        project_id: '4', relation_summary: '接口 → 测试' } })
  })

  it('conversation separates ranking text from display title and preserves adjacent context', () => {
    const documents = conversationAdapter.toDocuments([
      {
        kind: 'summary', id: '1:summary', session_id: 1, summary: '讨论了部署', title: '部署会话',
        session_source: 'qq', session_updated_at: '2026-09-09T01:00:00',
        version_parts: [1, '2026-09-09T01:00:00', '讨论了部署'], updated_at: '2026-09-09T01:00:00',
        scope: ownerScope,
      },
      {
        kind: 'message', id: 12, session_id: 1, role: 'user', content: '怎么部署', title: '部署会话',
        session_source: 'qq', context_before: 'user：之前的部署问题', context_after: 'assistant：可以先检查配置',
        session_updated_at: '2026-09-09T01:00:00', version_parts: [12, '2026-09-09T00:30:00', '怎么部署'],
        updated_at: '2026-09-09T00:30:00', scope: ownerScope,
      },
    ])
    expect(documents).toHaveLength(2)
    expect(documents[0]).toMatchObject({ id: 'conversation:conversation:1:summary:0',
      parent_id: 'conversation:1:summary', content: '会话摘要：讨论了部署',
      text: '部署会话\n会话摘要：讨论了部署', ranking_text: '会话摘要：讨论了部署',
      metadata: { session_id: '1', kind: 'summary', session_source: 'qq' } })
    expect(documents[1]).toMatchObject({ id: 'conversation:conversation:12:0',
      content: 'user：怎么部署', text: '部署会话\nuser：怎么部署', ranking_text: 'user：怎么部署',
      context_text: 'user：之前的部署问题\nuser：怎么部署\nassistant：可以先检查配置',
      metadata: { session_id: '1', kind: 'message', message_id: '12', role: 'user',
        context_current: 'user：怎么部署' } })
  })

  it('matches the shared Python conversation projection fixture field by field', () => {
    const documents = conversationAdapter.toDocuments(projectionFixture.records.map(record => ({
      ...record,
      scope: projectionFixture.scope,
    })))
    expect(documents).toHaveLength(projectionFixture.records.length)
    for (const [index, document] of documents.entries()) {
      const expected = projectionFixture.records[index]!.expected
      expect(document).toMatchObject({
        source_type: 'conversation',
        source_id: expected.source_id,
        parent_id: expected.parent_document_id,
        title: expected.title,
        summary: expected.summary,
        content: expected.content,
        document_version: expected.version,
        metadata: expected.metadata,
      })
      if (expected.contextual_content) expect(document.context_text).toBe(expected.contextual_content)
    }
  })

  it('source composition ignores retired file indexing and keeps shared chunk defaults', () => {
    const documents = buildSourceDocuments({
      files: [{ id: 1, title: '长文.txt', content: '字'.repeat(3000), version_parts: [1], scope: ownerScope }],
      note: [{ id: 2, title: '便签', content_plain: '短文', kind: 'note', version_parts: [2], scope: ownerScope }],
    } as never)
    expect(documents.every((document) => document.source_type !== 'file')).toBe(true)
    expect(documents.filter((document) => document.source_type === 'note')).toHaveLength(1)

    const chunks = buildDocuments({ id: 'knowledge-1', source_type: 'knowledge', title: '知识',
      content: '字'.repeat(1200), document_version: 'v1', scope: ownerScope })
    expect(chunks).toHaveLength(2)
    expect(Array.from(chunks[0]!.content ?? '')).toHaveLength(1000)
    expect(Array.from(chunks[1]!.content ?? '').slice(0, 150).join(''))
      .toBe(Array.from(chunks[0]!.content ?? '').slice(-150).join(''))
  })
})
