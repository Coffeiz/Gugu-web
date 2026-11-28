import { createDiskTrash } from '../../../../src/modules/files/trash/disk.js'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as reservePort } from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { parseAgentKnowledgeEntry, serializeAgentKnowledgeEntry, type AgentKnowledgeEntry } from '@gugu/core/agent/knowledge/entry'
import { listUserSkillBundles, readUserSkillBundle } from '@gugu/core/skills'
import { startServer } from '../../../../src/main.js'
import { applyAgentBaseMigration, checkAgentBaseMigration } from '@gugu/database/postgres/migrations/0001_initialize'
import { applyAgentRunMigration, checkAgentRunMigration } from '@gugu/database/postgres/migrations/0003_agent_run'
import { providerCredentials } from '@gugu/database/postgres/migrations/0016_provider_credentials'
import { byokBindings } from '@gugu/database/postgres/migrations/0021_byok_bindings'
import { webReflection } from '@gugu/database/postgres/migrations/0025_web_reflection'
import { scheduledTaskMode } from '@gugu/database/postgres/migrations/0022_scheduled_task_mode'
import { applyWebDomainMigration } from '@gugu/database/postgres/migrations/0002_web_domain'
import { applyRagIndexMigration } from '@gugu/database/postgres/migrations/0011_rag_index'
import { applyTrashPurgeMigration } from '@gugu/database/postgres/migrations/0009_trash_purge'
import { applyInteractionActionsMigration } from '@gugu/database/postgres/migrations/0008_interaction_actions'
import { createRedisValueReader } from '../../../../src/adapters/cache/redis-events.js'
import { signedUserToken } from '../../../helpers/auth.js'
import { applyFilesystemAuthorizationMigration, checkFilesystemAuthorizationMigration } from '@gugu/database/postgres/migrations/0005_filesystem_authorization'

import { subagentDeliveries } from '@gugu/database/postgres/migrations/0028_subagent_deliveries'
import { subagentSessions } from '@gugu/database/postgres/migrations/0029_subagent_sessions'
import { subagentLaunches } from '@gugu/database/postgres/migrations/0030_subagent_launches'
import { subagentWaits } from '@gugu/database/postgres/migrations/0031_subagent_waits'
import { subagentContinuations } from '@gugu/database/postgres/migrations/0034_subagent_continuations'
import { subagentExecutions } from '@gugu/database/postgres/migrations/0035_subagent_executions'
import { subagentConversations } from '@gugu/database/postgres/migrations/0033_subagent_conversations'
import { agentInbox } from '@gugu/database/postgres/migrations/0032_agent_inbox'

const pgUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL

function officeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function officeZipStored(entries: Record<string, string>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name), data = Buffer.from(value), crc = officeCrc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4)
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    local.push(header, nameBytes, data)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6)
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24)
    record.writeUInt16LE(nameBytes.length, 28); record.writeUInt32LE(offset, 42)
    central.push(record, nameBytes)
    offset += header.length + nameBytes.length + data.length
  }
  const centralBytes = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBytes, end])
}

function syntheticDocx(text: string): Buffer {
  return officeZipStored({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  })
}

async function waitFor(condition: () => Promise<boolean>, signal: AbortSignal, describe: () => string) {
  try {
    while (!await condition()) await delay(50, undefined, { signal })
  } catch (error) {
    if (signal.aborted) throw new Error(describe(), { cause: error })
    throw error
  }
}

async function stopChild(child: ChildProcess | undefined, signal: NodeJS.Signals) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill(signal)
  await exited
}

test('生产 Web Agent 经真实 HTTP/SSE 执行 Node 工具并持久续轮', {
  skip: !(pgUrl && redisUrl) && '需要隔离 PostgreSQL 和 Redis', timeout: 90_000,
}, async () => {
  const schema = `agent_chat_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: pgUrl })
  const url = new URL(pgUrl!)
  url.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: url.toString() })
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-chat-main-'))
  const requests: string[] = []
  let ordinaryNoteId: number | undefined
  let agentCreatedClientId: number | undefined
  let scheduledTaskId: number | undefined
  let userSkillId: string | undefined
  let foreignOwnerId: string | undefined
  let agentCreatedEventId: number | undefined
  const ragKnowledgeId = 'node-rag-agent-proof'
  const foreignRagKnowledgeId = 'foreign-node-rag-proof'
  const ragKnowledgeKeyword = '星辰检索合成词'
  const scheduledTaskStartAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const eventCreateDate = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const eventCreateTitle = 'Node生产创建的合成日程'
  const eventUpdatedTitle = 'Node更新后的合成日程'
  let resumeAfterReconnect!: () => void
  const continueAfterReconnect = new Promise<void>(resolve => { resumeAfterReconnect = resolve })
  let cancelledProviderClosed = false
  const crashPrompt = '强制退出用例，查找我之前的合成报告。'
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString('utf8')
    const { messages = [], stream } = JSON.parse(body) as { messages?: Array<{ role: string; content: unknown }>; stream?: boolean }
    if (stream) requests.push(body)
    // 合成模型只执行当前用户回合的指令，历史消息仍保留在 requests 供断言。
    const turnStart = messages.findLastIndex(message => message.role === 'user'
      && !JSON.stringify(message.content).includes('[system-reminder]'))
    const input = JSON.stringify(messages.slice(Math.max(0, turnStart)))
    const afterCancellation = input.includes('取消后继续的合成输入')
    if (input.includes('等待取消的合成输入') && !afterCancellation) {
      response.once('close', () => { cancelledProviderClosed = true })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '取消前的合成片段' } }] })}\n\n`)
      return
    }
    const needsSearch = !afterCancellation && input.includes('查找我之前的合成报告') && !input.includes('synthetic-history')
    const needsGlobalSearch = !afterCancellation && input.includes('跨类型搜索合成日程') && !input.includes('synthetic-global-search')
    const needsCreateEvent = !afterCancellation && input.includes('创建合成日历事件') && !input.includes('synthetic-create-event')
    const needsUpdateEvent = !afterCancellation && input.includes('更新合成日历事件') && !input.includes('synthetic-update-event')
    const needsDeleteEvent = !afterCancellation && input.includes('删除合成日历事件') && !input.includes('synthetic-delete-event')
    const needsKnowledgeSearch = !afterCancellation && input.includes('检索Node知识库合成条目') && !input.includes('synthetic-read-knowledge')
    const needsKnowledgeExactRead = !afterCancellation && input.includes('精确读取Node RAG知识') && !input.includes('synthetic-read-knowledge-id')
    const needsForeignKnowledgeRead = !afterCancellation && input.includes('尝试读取异主RAG条目') && !input.includes('synthetic-read-foreign-knowledge')
    const needsKnowledgeSave = !afterCancellation && input.includes('保存Node知识回归') && !input.includes('synthetic-save-knowledge')
    const needsKnowledgeUpdate = !afterCancellation && input.includes('更新Node知识回归') && !input.includes('synthetic-update-knowledge')
    const needsAskUser = !afterCancellation && input.includes('需要一个合成选项') && !input.includes('synthetic-ask-user')
    const needsRead = !afterCancellation && !input.includes('强制退出用例')
      && input.includes('synthetic-history') && !input.includes('synthetic-read')
    const needsTime = !afterCancellation && input.includes('读取合成当前时间') && !input.includes('synthetic-time')
    const needsUpcoming = !afterCancellation && input.includes('读取合成最近安排') && !input.includes('synthetic-upcoming')
    const needsListEvents = !afterCancellation && input.includes('列出合成日历事件') && !input.includes('synthetic-list-events')
    const needsListClients = !afterCancellation && input.includes('列出合成联系人') && !input.includes('synthetic-list-clients')
    const needsListProjects = !afterCancellation && input.includes('列出合成项目') && !input.includes('synthetic-list-projects')
    const needsListWorkspaces = !afterCancellation && input.includes('列出合成工作区') && !input.includes('synthetic-list-workspaces')
    const needsGetWorkspace = !afterCancellation && input.includes('读取合成工作区详情') && !input.includes('synthetic-get-workspace')
    const needsUpdateWorkspace = !afterCancellation && input.includes('更新合成工作区显示名称') && !input.includes('synthetic-update-workspace')
    const needsListScheduledTasks = !afterCancellation && input.includes('列出合成独立定时任务') && !input.includes('synthetic-list-scheduled-tasks')
    const needsCreateScheduledTask = !afterCancellation && input.includes('创建合成独立定时任务') && !input.includes('synthetic-create-scheduled-task')
    const needsUpdateScheduledTask = !afterCancellation && input.includes('更新合成独立定时任务') && !input.includes('synthetic-update-scheduled-task')
    const needsDeleteScheduledTask = !afterCancellation && input.includes('删除合成独立定时任务') && !input.includes('synthetic-delete-scheduled-task')
    const needsListTrash = !afterCancellation && input.includes('列出合成回收站') && !input.includes('synthetic-list-trash')
    const needsRestoreFile = !afterCancellation && input.includes('恢复合成回收站文件') && !input.includes('synthetic-restore-file')
    const needsRestoreFolder = !afterCancellation && input.includes('恢复合成回收站目录') && !input.includes('synthetic-restore-folder')
    const needsCreateClient = !afterCancellation && input.includes('创建合成联系人') && !input.includes('synthetic-create-client')
    const needsUpdateClient = !afterCancellation && input.includes('更新合成联系人') && !input.includes('synthetic-update-client')
    const needsDeleteClient = !afterCancellation && input.includes('删除合成联系人') && !input.includes('synthetic-delete-client')
    const needsCreateProject = !afterCancellation && input.includes('创建合成项目') && !input.includes('synthetic-create-project')
    const needsGetProject = !afterCancellation && input.includes('读取合成项目详情') && !input.includes('synthetic-get-project')
    const needsGetForeignProject = !afterCancellation && input.includes('读取异主合成项目详情') && !input.includes('synthetic-get-foreign-project')
    const needsToolSchema = !afterCancellation && input.includes('读取合成工具Schema') && !input.includes('synthetic-tool-schema')
    const needsCanvasList = !afterCancellation && input.includes('列出合成画布') && !input.includes('synthetic-canvas-list')
    const needsCanvasCreate = !afterCancellation && input.includes('创建合成画布') && !input.includes('synthetic-canvas-create')
    const needsCanvasCreateNote = !afterCancellation && input.includes('创建画布合成便签') && !input.includes('synthetic-canvas-create-note')
    const needsCanvasUpdateNode = !afterCancellation && input.includes('更新合成画布节点位置') && !input.includes('synthetic-canvas-update-node')
    const needsCanvasUpdateNote = !afterCancellation && input.includes('更新合成画布便签') && !input.includes('synthetic-canvas-update-note')
    const needsCanvasAddNode = !afterCancellation && input.includes('放置合成项目到画布') && !input.includes('synthetic-canvas-add-node')
    const needsCanvasConnect = !afterCancellation && input.includes('连接合成画布节点') && !input.includes('synthetic-canvas-connect')
    const needsCanvasUpdateAnchor = !afterCancellation && input.includes('修改合成画布关系端点') && !input.includes('synthetic-canvas-anchor')
    const needsCanvasRemoveNode = !afterCancellation && input.includes('从合成画布移除合成便签') && !input.includes('synthetic-canvas-remove-node')
    const needsCanvasGet = !afterCancellation && input.includes('读取合成画布详情') && !input.includes('synthetic-canvas-get')
    const needsCanvasSearch = !afterCancellation && input.includes('搜索合成画布') && !input.includes('synthetic-canvas-search')
    const needsCanvasFocus = !afterCancellation && input.includes('定位合成画布节点') && !input.includes('synthetic-canvas-focus')
    const needsCanvasPlaceable = !afterCancellation && input.includes('搜索可放入画布的合成项目') && !input.includes('synthetic-canvas-placeable')
    const needsForeignCanvasGet = !afterCancellation && input.includes('读取异主合成画布详情') && !input.includes('synthetic-foreign-canvas-get')
    const needsNoteSearch = !afterCancellation && input.includes('搜索合成笔记') && !input.includes('synthetic-note-search')
    const needsNoteGet = !afterCancellation && input.includes('读取合成笔记') && !input.includes('synthetic-note-get')
    const needsForeignNoteGet = !afterCancellation && input.includes('读取异主合成笔记') && !input.includes('synthetic-foreign-note-get')
    const needsOrdinaryNoteCreate = !afterCancellation && input.includes('创建普通合成笔记') && !input.includes('synthetic-note-create')
    const needsOrdinaryNoteUpdate = !afterCancellation && input.includes('追加普通合成笔记') && !input.includes('synthetic-note-update')
    const needsNoteDelete = !afterCancellation && input.includes('软删合成笔记') && !input.includes('synthetic-note-delete')
    const needsNoteRestore = !afterCancellation && input.includes('恢复合成笔记') && !input.includes('synthetic-note-restore')
    const needsNoteUndo = !afterCancellation && input.includes('撤销最近咕咕合成笔记') && !input.includes('synthetic-note-undo')
    const needsListSkills = !afterCancellation && input.includes('合成技能目录') && !input.includes('synthetic-list-skills')
    const needsUseSkill = !afterCancellation && input.includes('加载合成内置技能') && !input.includes('synthetic-use-skill')
    const needsCreateSkill = !afterCancellation && input.includes('创建合成用户技能') && !input.includes('synthetic-create-skill')
    const needsUpdateSkill = !afterCancellation && input.includes('更新合成用户技能') && !input.includes('synthetic-update-skill')
    const needsUseUserSkill = !afterCancellation && input.includes('加载更新后的合成用户技能') && !input.includes('synthetic-use-user-skill')
    const needsDeleteSkill = !afterCancellation && input.includes('删除合成用户技能') && !input.includes('synthetic-delete-user-skill')
    const needsUpdateProject = !afterCancellation && input.includes('修改合成项目') && !input.includes('synthetic-update-project')
    const needsSetProjectColor = !afterCancellation && input.includes('设置合成项目颜色') && !input.includes('synthetic-set-project-color')
    const needsArchiveProject = !afterCancellation && input.includes('归档合成项目') && !input.includes('synthetic-archive-project')
    const needsAddStage = !afterCancellation && input.includes('添加合成阶段') && !input.includes('synthetic-add-stage')
    const needsRenameStage = !afterCancellation && input.includes('重命名合成阶段') && !input.includes('synthetic-rename-stage')
    const needsUpdateStage = !afterCancellation && input.includes('添加合成待办') && !input.includes('synthetic-update-stage')
    const needsSetStages = !afterCancellation && input.includes('重设合成阶段') && !input.includes('synthetic-set-stages')
    const needsRemoveStage = !afterCancellation && input.includes('删除合成阶段') && !input.includes('synthetic-remove-stage')
    if (needsSearch && input.includes('强制退出用例'))
      await pool.query(`INSERT INTO synthetic_crash_gate(session_id)
        SELECT session_id FROM conversation_messages WHERE role='user' AND content=$1
        ON CONFLICT DO NOTHING`, [crashPrompt])
    if (!needsSearch && input.includes('强制退出用例')) await continueAfterReconnect
    const choice = needsCanvasList
      ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-canvas-list', type: 'function', function: {
        name: 'call_tool', arguments: '{"tool_name":"canvas_list","arguments":{}}',
      } }] }, finish_reason: 'tool_calls' }
      : needsCanvasCreate
        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-canvas-create', type: 'function', function: {
          name: 'call_tool', arguments: '{"tool_name":"canvas_create","arguments":{"title":"Agent创建的合成画布"}}',
        } }] }, finish_reason: 'tool_calls' }
      : needsCanvasCreateNote
        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-canvas-create-note', type: 'function', function: {
          name: 'call_tool', arguments: JSON.stringify({ tool_name: 'canvas_create_note', arguments: { canvas_id: ownerCanvasId, title: 'Agent合成便签', content: '便签初始内容' } }),
        } }] }, finish_reason: 'tool_calls' }
      : needsCanvasUpdateNode
        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-canvas-update-node', type: 'function', function: {
          name: 'call_tool', arguments: JSON.stringify({ tool_name: 'canvas_update_node', arguments: { canvas_id: ownerCanvasId, item_id: ownerCanvasItemId, x: 44, y: 66 } }),
        } }] }, finish_reason: 'tool_calls' }
      : needsCanvasUpdateNote
        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-canvas-update-note', type: 'function', function: {
          name: 'call_tool', arguments: JSON.stringify({ tool_name: 'canvas_update_note', arguments: { node_id: ownerCanvasNewNodeId, title: 'Agent更新的合成便签', content: '便签更新内容' } }),
        } }] }, finish_reason: 'tool_calls' }
      : needsCanvasAddNode
        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-canvas-add-node', type: 'function', function: {
          name: 'call_tool', arguments: JSON.stringify({ tool_name: 'canvas_add_node', arguments: { canvas_id: ownerCanvasId, ref_type: 'project', ref_id: ownerProjectId } }),
        } }] }, finish_reason: 'tool_calls' }
      : needsCanvasConnect
        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-canvas-connect', type: 'function', function: {
          name: 'call_tool', arguments: JSON.stringify({ tool_name: 'canvas_connect', arguments: { canvas_id: ownerCanvasId, source_node_id: ownerCanvasNewNodeId, target_node_id: ownerProjectCanvasNodeId } }),
        } }] }, finish_reason: 'tool_calls' }
      : needsCanvasUpdateAnchor
        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-canvas-anchor', type: 'function', function: {
          name: 'call_tool', arguments: JSON.stringify({ tool_name: 'canvas_update_anchor', arguments: { canvas_id: ownerCanvasId, relation_id: ownerCanvasRelationId, source_side: 'right', target_side: 'left' } }),
        } }] }, finish_reason: 'tool_calls' }
      : needsCanvasRemoveNode
        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-canvas-remove-node', type: 'function', function: {
          name: 'call_tool', arguments: JSON.stringify({ tool_name: 'canvas_remove_node', arguments: { canvas_id: ownerCanvasId, item_id: ownerCanvasItemId } }),
        } }] }, finish_reason: 'tool_calls' }
      : needsCanvasGet
        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-canvas-get', type: 'function', function: {
          name: 'call_tool', arguments: JSON.stringify({ tool_name: 'canvas_get', arguments: { canvas_id: ownerCanvasId, include_content: true } }),
        } }] }, finish_reason: 'tool_calls' }
        : needsCanvasSearch
          ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-canvas-search', type: 'function', function: {
            name: 'call_tool', arguments: JSON.stringify({ tool_name: 'canvas_search', arguments: { canvas_id: ownerCanvasId, query: '月球画布节点', include_content: true } }),
          } }] }, finish_reason: 'tool_calls' }
          : needsCanvasPlaceable
            ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-canvas-placeable', type: 'function', function: {
              name: 'call_tool', arguments: '{"tool_name":"canvas_search_placeable","arguments":{"query":"项目","types":["project"]}}',
            } }] }, finish_reason: 'tool_calls' }
            : needsCanvasFocus
            ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-canvas-focus', type: 'function', function: {
              name: 'call_tool', arguments: JSON.stringify({ tool_name: 'canvas_focus_node', arguments: { canvas_id: ownerCanvasId, item_id: ownerCanvasItemId } }),
            } }] }, finish_reason: 'tool_calls' }
            : needsForeignCanvasGet
              ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-foreign-canvas-get', type: 'function', function: {
                name: 'call_tool', arguments: JSON.stringify({ tool_name: 'canvas_get', arguments: { canvas_id: foreignCanvasId } }),
              } }] }, finish_reason: 'tool_calls' }
              : needsNoteSearch
      ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-note-search', type: 'function', function: {
        name: 'call_tool', arguments: '{"tool_name":"note_search","arguments":{"query":"月球笔记","include_content":true}}',
      } }] }, finish_reason: 'tool_calls' }
      : needsNoteGet
        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-note-get', type: 'function', function: {
          name: 'call_tool', arguments: JSON.stringify({ tool_name: 'note_get', arguments: { node_id: ownerNoteId } }),
        } }] }, finish_reason: 'tool_calls' }
        : needsForeignNoteGet
          ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-foreign-note-get', type: 'function', function: {
            name: 'call_tool', arguments: JSON.stringify({ tool_name: 'note_get', arguments: { node_id: foreignNoteId } }),
          } }] }, finish_reason: 'tool_calls' }
          : needsOrdinaryNoteCreate
            ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-note-create', type: 'function', function: {
              name: 'call_tool', arguments: JSON.stringify({ tool_name: 'note_create', arguments: {
                title: 'Agent普通合成笔记', markdown: '# Agent普通合成笔记\n\n初始正文',
              } }),
            } }] }, finish_reason: 'tool_calls' }
            : needsOrdinaryNoteUpdate
              ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-note-update', type: 'function', function: {
                name: 'call_tool', arguments: JSON.stringify({ tool_name: 'note_update', arguments: {
                  node_id: ordinaryNoteId, append_markdown: '追加正文',
                } }),
              } }] }, finish_reason: 'tool_calls' }
              : needsNoteDelete
                ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-note-delete', type: 'function', function: {
                  name: 'call_tool', arguments: JSON.stringify({ tool_name: 'note_delete', arguments: { node_id: ownerNoteId } }),
                } }] }, finish_reason: 'tool_calls' }
                : needsNoteRestore
                  ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-note-restore', type: 'function', function: {
                    name: 'call_tool', arguments: JSON.stringify({ tool_name: 'note_restore', arguments: { node_id: ownerNoteId } }),
                  } }] }, finish_reason: 'tool_calls' }
                  : needsNoteUndo
                    ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-note-undo', type: 'function', function: {
                      name: 'call_tool', arguments: '{"tool_name":"note_undo","arguments":{}}',
                    } }] }, finish_reason: 'tool_calls' }
          : needsAddStage
      ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-add-stage', type: 'function', function: {
        name: 'call_tool', arguments: '{"tool_name":"add_stage","arguments":{"project":"工具创建项目","label":"新阶段"}}',
      } }] }, finish_reason: 'tool_calls' }
      : needsRenameStage
        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-rename-stage', type: 'function', function: {
          name: 'call_tool', arguments: '{"tool_name":"rename_stage","arguments":{"project":"工具创建项目","stage":"新阶段","new_label":"待办阶段"}}',
        } }] }, finish_reason: 'tool_calls' }
        : needsUpdateStage
          ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-update-stage', type: 'function', function: {
            name: 'call_tool', arguments: '{"tool_name":"update_stage","arguments":{"project":"工具创建项目","stage":"待办阶段","add":["合成待办"]}}',
          } }] }, finish_reason: 'tool_calls' }
          : needsSetStages
            ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-set-stages', type: 'function', function: {
              name: 'call_tool', arguments: '{"tool_name":"set_stages","arguments":{"project":"工具创建项目","stages":[{"key":"s3","label":"待办阶段"},"尾声"]}}',
            } }] }, finish_reason: 'tool_calls' }
            : needsRemoveStage
              ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-remove-stage', type: 'function', function: {
                name: 'call_tool', arguments: '{"tool_name":"remove_stage","arguments":{"project":"工具创建项目","stage":"尾声"}}',
              } }] }, finish_reason: 'tool_calls' }
              : needsToolSchema
                ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-tool-schema', type: 'function', function: {
                  name: 'search_tools', arguments: '{"names":["list_events"]}',
                } }] }, finish_reason: 'tool_calls' }
                  : needsCreateEvent
                    ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-create-event', type: 'function', function: {
                      name: 'call_tool', arguments: JSON.stringify({ tool_name: 'create_event', arguments: {
                          title: eventCreateTitle, date: eventCreateDate, all_day: true,
                          reminders: [
                            { lead_minutes: 30, channels: ['web'], delivery_mode: 'owner_private' },
                            { lead_minutes: 60, channels: ['web'], delivery_mode: 'owner_private', enabled: false },
                          ],
                      } }),
                    } }] }, finish_reason: 'tool_calls' }
                    : needsUpdateEvent
                      ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-update-event', type: 'function', function: {
                        name: 'call_tool', arguments: JSON.stringify({ tool_name: 'update_event', arguments: {
                          event_id: agentCreatedEventId, title: eventUpdatedTitle, time: '12:00',
                        } }),
                      } }] }, finish_reason: 'tool_calls' }
                      : needsDeleteEvent
                        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-delete-event', type: 'function', function: {
                          name: 'call_tool', arguments: JSON.stringify({ tool_name: 'delete_event', arguments: { event_id: agentCreatedEventId } }),
                        } }] }, finish_reason: 'tool_calls' }
                  : needsGlobalSearch
                    ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-global-search', type: 'function', function: {
                      name: 'call_tool', arguments: JSON.stringify({ tool_name: 'global_search', arguments: {
                        query: eventUpdatedTitle, types: ['event'], owner_id: foreignOwnerId,
                      } }),
                    } }] }, finish_reason: 'tool_calls' }
                    : needsKnowledgeSearch
                      ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-read-knowledge', type: 'function', function: {
                        name: 'call_tool', arguments: JSON.stringify({ tool_name: 'read_knowledge', arguments: {
                          keyword: ragKnowledgeKeyword, limit: 5,
                        } }),
                      } }] }, finish_reason: 'tool_calls' }
                      : needsKnowledgeExactRead
                        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-read-knowledge-id', type: 'function', function: {
                          name: 'call_tool', arguments: JSON.stringify({ tool_name: 'read_knowledge', arguments: {
                            knowledge_id: ragKnowledgeId,
                          } }),
                        } }] }, finish_reason: 'tool_calls' }
                        : needsForeignKnowledgeRead
                          ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-read-foreign-knowledge', type: 'function', function: {
                            name: 'call_tool', arguments: JSON.stringify({ tool_name: 'read_knowledge', arguments: {
                              knowledge_id: foreignRagKnowledgeId,
                            } }),
                          } }] }, finish_reason: 'tool_calls' }
                          : needsKnowledgeSave
                            ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-save-knowledge', type: 'function', function: {
                              name: 'call_tool', arguments: JSON.stringify({ tool_name: 'save_knowledge', arguments: {
                                title: 'Node生产RAG合成知识已保存', content: 'Node保存工具写入的第一版知识正文。',
                                topic: 'Node RAG 检索验收', keywords: [ragKnowledgeKeyword],
                                description: '生产 Run 写入回归。',
                              } }),
                            } }] }, finish_reason: 'tool_calls' }
                            : needsKnowledgeUpdate
                              ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-update-knowledge', type: 'function', function: {
                                name: 'call_tool', arguments: JSON.stringify({ tool_name: 'update_knowledge', arguments: {
                                  knowledge_id: ragKnowledgeId, title: 'Node生产RAG合成知识已更新',
                                  content: 'Node更新工具写入并重建索引的最终知识正文。',
                                  keywords: [ragKnowledgeKeyword, 'Node更新回归词'],
                                } }),
                              } }] }, finish_reason: 'tool_calls' }
                              : needsAskUser
                                ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-ask-user', type: 'function', function: {
                                  name: 'call_tool', arguments: JSON.stringify({ tool_name: 'ask_user', arguments: {
                                    kind: 'choice', title: 'Node合成澄清', body: '请选择用于续轮的合成选项。',
                                    options: [{ id: 'left', label: '左侧选项' }, { id: 'right', label: '右侧选项' }],
                                  } }),
                                } }] }, finish_reason: 'tool_calls' }
                : needsListSkills
                  ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-list-skills', type: 'function', function: {
                    name: 'call_tool', arguments: '{"tool_name":"list_skills","arguments":{}}',
                  } }] }, finish_reason: 'tool_calls' }
                  : needsUseSkill
                    ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-use-skill', type: 'function', function: {
                      name: 'call_tool', arguments: '{"tool_name":"use_skill","arguments":{"id":"S2"}}',
                    } }] }, finish_reason: 'tool_calls' }
                    : needsCreateSkill
                      ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-create-skill', type: 'function', function: {
                        name: 'call_tool', arguments: JSON.stringify({ tool_name: 'create_skill', arguments: {
                          skill_name: 'Agent合成用户技能', description_short: '隔离验证用的用户技能',
                          body: '# Agent合成用户技能\n\n初始技能正文。', related_tools: [], managed_by: 'assistant',
                        } }),
                      } }] }, finish_reason: 'tool_calls' }
                      : needsUpdateSkill
                        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-update-skill', type: 'function', function: {
                          name: 'call_tool', arguments: JSON.stringify({ tool_name: 'update_skill', arguments: {
                            id: userSkillId, skill_name: 'Agent合成用户技能已更新', body: '# Agent合成用户技能\n\n更新后的用户技能正文。',
                          } }),
                        } }] }, finish_reason: 'tool_calls' }
                        : needsUseUserSkill
                          ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-use-user-skill', type: 'function', function: {
                            name: 'call_tool', arguments: JSON.stringify({ tool_name: 'use_skill', arguments: { id: userSkillId } }),
                          } }] }, finish_reason: 'tool_calls' }
                          : needsDeleteSkill
                            ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-delete-user-skill', type: 'function', function: {
                              name: 'call_tool', arguments: JSON.stringify({ tool_name: 'delete_skill', arguments: { id: userSkillId } }),
                            } }] }, finish_reason: 'tool_calls' }
                : needsGetForeignProject
                ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-get-foreign-project', type: 'function', function: {
                  name: 'call_tool', arguments: JSON.stringify({ tool_name: 'get_project', arguments: { project_id: foreignProjectId } }),
                } }] }, finish_reason: 'tool_calls' }
                : needsGetProject
                ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-get-project', type: 'function', function: {
                  name: 'call_tool', arguments: JSON.stringify({ tool_name: 'get_project', arguments: { project_id: ownerProjectId } }),
                } }] }, finish_reason: 'tool_calls' }
                : needsUpdateProject
      ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-update-project', type: 'function', function: {
        name: 'call_tool', arguments: '{"tool_name":"update_project","arguments":{"project":"工具创建项目","summary":"通过正式 Agent 更新"}}',
      } }] }, finish_reason: 'tool_calls' }
      : needsSetProjectColor
        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-set-project-color', type: 'function', function: {
          name: 'call_tool', arguments: '{"tool_name":"set_color","arguments":{"project":"工具创建项目","color":"teal"}}',
        } }] }, finish_reason: 'tool_calls' }
        : needsArchiveProject
          ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-archive-project', type: 'function', function: {
            name: 'call_tool', arguments: '{"tool_name":"archive_project","arguments":{"project":"工具创建项目","archived":true}}',
          } }] }, finish_reason: 'tool_calls' }
          : needsCreateProject
      ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-create-project', type: 'function', function: {
        name: 'call_tool', arguments: '{"tool_name":"create_project","arguments":{"project_name":"工具创建项目","start_date":"2026-11-18","deadline":"2026-12-01","priority":"high"}}',
      } }] }, finish_reason: 'tool_calls' }
      : needsCreateClient
      ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-create-client', type: 'function', function: {
        name: 'call_tool', arguments: '{"tool_name":"create_contact","arguments":{"name":"工具创建联系人","email":"tool-created@example.test"}}',
      } }] }, finish_reason: 'tool_calls' }
      : needsUpdateClient
        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-update-client', type: 'function', function: {
          name: 'call_tool', arguments: '{"tool_name":"update_contact","arguments":{"contact_query":"工具创建联系人","notes":"已更新合成备注"}}',
        } }] }, finish_reason: 'tool_calls' }
        : needsDeleteClient
          ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-delete-client', type: 'function', function: {
            name: 'call_tool', arguments: JSON.stringify({ tool_name: 'delete_contact', arguments: { contact_id: agentCreatedClientId } }),
          } }] }, finish_reason: 'tool_calls' }
      : needsListWorkspaces
        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-list-workspaces', type: 'function', function: {
          name: 'call_tool', arguments: '{"tool_name":"list_workspaces","arguments":{}}',
        } }] }, finish_reason: 'tool_calls' }
        : needsGetWorkspace
          ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-get-workspace', type: 'function', function: {
            name: 'call_tool', arguments: JSON.stringify({ tool_name: 'get_workspace', arguments: { workspace_id: defaultWorkspaceId } }),
          } }] }, finish_reason: 'tool_calls' }
          : needsUpdateWorkspace
            ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-update-workspace', type: 'function', function: {
              name: 'call_tool', arguments: JSON.stringify({ tool_name: 'update_workspace', arguments: {
                workspace_id: mutableWorkspaceId, workspace_name: 'Agent更新的合成工作区',
              } }),
            } }] }, finish_reason: 'tool_calls' }
            : needsListScheduledTasks
              ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-list-scheduled-tasks', type: 'function', function: {
                name: 'call_tool', arguments: '{"tool_name":"list_scheduled_tasks","arguments":{}}',
              } }] }, finish_reason: 'tool_calls' }
              : needsCreateScheduledTask
                ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-create-scheduled-task', type: 'function', function: {
                  name: 'call_tool', arguments: JSON.stringify({ tool_name: 'create_scheduled_task', arguments: {
                    schedule_name: 'Agent合成独立任务', instruction: '只用于隔离测试，不执行外部操作。', schedule_kind: 'once',
                    start_at: scheduledTaskStartAt, channels: ['web'], enabled: false,
                  } }),
                } }] }, finish_reason: 'tool_calls' }
                : needsUpdateScheduledTask
                  ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-update-scheduled-task', type: 'function', function: {
                    name: 'call_tool', arguments: JSON.stringify({ tool_name: 'update_scheduled_task', arguments: {
                      task_id: scheduledTaskId, schedule_name: 'Agent合成独立任务已更新', instruction: '更新后的隔离指令。',
                    } }),
                  } }] }, finish_reason: 'tool_calls' }
                  : needsDeleteScheduledTask
                    ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-delete-scheduled-task', type: 'function', function: {
                      name: 'call_tool', arguments: JSON.stringify({ tool_name: 'delete_scheduled_task', arguments: { task_id: scheduledTaskId } }),
                    } }] }, finish_reason: 'tool_calls' }
              : needsListTrash
                ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-list-trash', type: 'function', function: {
                  name: 'call_tool', arguments: '{"tool_name":"list_trash","arguments":{}}',
                } }] }, finish_reason: 'tool_calls' }
                : needsRestoreFile
                  ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-restore-file', type: 'function', function: {
                    name: 'call_tool', arguments: JSON.stringify({ tool_name: 'restore_file', arguments: { path: restoreFilePath } }),
                  } }] }, finish_reason: 'tool_calls' }
                  : needsRestoreFolder
                    ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-restore-folder', type: 'function', function: {
                      name: 'call_tool', arguments: JSON.stringify({ tool_name: 'restore_folder', arguments: { path: restoreFolderPath } }),
                    } }] }, finish_reason: 'tool_calls' }
          : needsListClients
      ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-list-clients', type: 'function', function: {
        name: 'call_tool', arguments: '{"tool_name":"list_contacts","arguments":{}}',
      } }] }, finish_reason: 'tool_calls' }
      : needsListProjects
        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-list-projects', type: 'function', function: {
          name: 'call_tool', arguments: '{"tool_name":"list_projects","arguments":{}}',
        } }] }, finish_reason: 'tool_calls' }
        : needsSearch
      ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-history', type: 'function', function: {
        name: 'call_tool', arguments: '{"tool_name":"search_conversations","arguments":{"query":"月球校验"}}',
      } }] }, finish_reason: 'tool_calls' }
      : needsRead
        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-read', type: 'function', function: {
          name: 'call_tool', arguments: '{"tool_name":"read_conversation","arguments":{"session_id":1}}',
        } }] }, finish_reason: 'tool_calls' }
        : needsTime
          ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-time', type: 'function', function: {
            name: 'call_tool', arguments: '{"tool_name":"get_current_time","arguments":{"timezone":"UTC"}}',
          } }] }, finish_reason: 'tool_calls' }
          : needsUpcoming
            ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-upcoming', type: 'function', function: {
              name: 'call_tool', arguments: '{"tool_name":"get_upcoming","arguments":{"days":7}}',
            } }] }, finish_reason: 'tool_calls' }
            : needsListEvents
              ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-list-events', type: 'function', function: {
                name: 'call_tool', arguments: '{"tool_name":"list_events","arguments":{}}',
              } }] }, finish_reason: 'tool_calls' }
        : { delta: { content: input.includes('synthetic-read') ? '已读取合成会话正文。' : '找到了合成会话。' }, finish_reason: 'stop' }
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(
      `data: ${JSON.stringify({ choices: [choice], usage: { prompt_tokens: 6, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
  })
  let host: Awaited<ReturnType<typeof startServer>> | undefined
  let child: ChildProcess | undefined
  let gate: PoolClient | undefined
  let defaultWorkspaceId: number | undefined
  let mutableWorkspaceId: number | undefined
  let restoreFilePath: string | undefined
  let restoreFolderPath: string | undefined
  let ownerProjectId: number | undefined
  let foreignProjectId: number | undefined
  let ownerNoteId: number | undefined
  let foreignNoteId: number | undefined
  let ownerCanvasId: number | undefined
  let foreignCanvasId: number | undefined
  let ownerCanvasNodeId: number | undefined
  let ownerCanvasItemId: number | undefined
  let ownerCanvasNewNodeId: number | undefined
  let ownerProjectCanvasNodeId: number | undefined
  let ownerCanvasRelationId: number | undefined
  try {
    provider.listen(0, '127.0.0.1')
    await once(provider, 'listening')
    const endpoint = provider.address()
    assert.ok(endpoint && typeof endpoint !== 'string')
    await admin.query(`CREATE SCHEMA "${schema}"`)
    assert.equal(await checkAgentBaseMigration(pool), 'pending')
    assert.equal(await applyAgentBaseMigration(pool), 'applied')
    assert.equal(await checkFilesystemAuthorizationMigration(pool), 'pending')
    assert.deepEqual((await Promise.all([applyFilesystemAuthorizationMigration(pool), applyFilesystemAuthorizationMigration(pool)])).sort(),
      ['applied', 'unchanged'])
    assert.equal(await checkFilesystemAuthorizationMigration(pool), 'applied')
    assert.equal(await applyWebDomainMigration(pool), 'applied')
    assert.equal(await scheduledTaskMode.apply(pool), 'applied')
    assert.equal(await providerCredentials.apply(pool), 'applied')
    assert.equal(await byokBindings.apply(pool), 'applied')
    assert.equal(await checkAgentRunMigration(pool), 'pending')
    assert.equal(await applyAgentRunMigration(pool), 'applied')
    for (const migration of [subagentDeliveries, subagentSessions, subagentLaunches, subagentWaits, agentInbox, subagentConversations, subagentContinuations, subagentExecutions])
      assert.equal(await migration.apply(pool), 'applied')
    assert.equal(await webReflection.apply(pool), 'applied')
    assert.equal(await applyTrashPurgeMigration(pool), 'applied')
    assert.equal(await checkAgentBaseMigration(pool), 'applied')
    // 认证写门复用数据替换任务表；此集成只验证 Agent/RAG，不运行数据替换迁移。
    await pool.query('CREATE TABLE data_import_jobs (id uuid PRIMARY KEY, user_id uuid NOT NULL, status text NOT NULL)')
    const secret = 'synthetic-web-agent-secret'
    const config = join(root, 'config.test.json')
    await writeFile(config, JSON.stringify({ agent: {
      memory_enabled: process.platform === 'linux',
    } }))
    const probe = reservePort().listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const listen = probe.address()
    assert.ok(listen && typeof listen !== 'string')
    await new Promise<void>(resolve => probe.close(() => resolve()))
    const env = {
      GUGU_WEBUI_DATABASE_URL: url.toString(), GUGU_WEBUI_SECRET_KEY: secret, GUGU_WEBUI_REDIS_URL: redisUrl,
      CREDENTIALS_MASTER_KEY: 'synthetic-agent-confirmation-master-key',
      GUGU_WEBUI_HOST: '127.0.0.1', GUGU_WEBUI_PORT: String(listen.port), GUGU_CONFIG_OVERRIDE_FILE: config,
      STORAGE__LOCAL_PATH: join(root, 'storage'), AI__PROVIDER: 'local', AI__API_FORMAT: 'openai',
      AI__MODEL: 'synthetic-agent', AI__BASE_URL: `http://127.0.0.1:${endpoint.port}/v1`,
      AI__API_KEY: 'synthetic-key', AI__CONTEXT_TOKENS: '65536', BYOK__ENABLED: 'false', MCP__ENABLED: 'false', SMTP__ENABLED: 'false',
      ADMIN_USERNAME: 'synthetic-admin', ADMIN_PASSWORD: 'synthetic-password',
      GUGU_WEBUI_ONCE_TASK_WORKER_ENABLED: 'true',
    }
    const base = `http://127.0.0.1:${listen.port}`
    host = await startServer(env)
    const readiness = await fetch(base + '/health/ready', { signal: AbortSignal.timeout(4000) })
    assert.equal(readiness.status, 200, await readiness.clone().text())
    assert.deepEqual(await readiness.json(), { status: 'ok' })
    const registration = await fetch(base + '/api/v1/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-device-id': 'synthetic-agent-first-account' },
      body: JSON.stringify({ username: 'north-sample', email: 'north@example.test', password: 'Synthetic123!', locale: 'zh-CN' }),
      signal: AbortSignal.timeout(8000),
    })
    const responseText = await registration.text()
    assert.equal(registration.status, 201, responseText)
    const registered = JSON.parse(responseText) as { access_token: string; user: { id: string } }
    assert.ok(registered.access_token)
    const owner = registered.user.id
    await pool.query("UPDATE users SET timezone='Asia/Tokyo' WHERE id=$1", [owner])
    const auth = { authorization: `Bearer ${registered.access_token}` }
    const workspace = await pool.query(`SELECT d.directory_name,d.is_default,d.is_system
      FROM workspace_directories d JOIN workspaces w ON w.directory_id=d.id AND w.user_id=d.user_id
      WHERE d.user_id=$1 AND d.deleted_at IS NULL AND w.enabled`, [owner])
    assert.deepEqual(workspace.rows, [{ directory_name: 'default', is_default: true, is_system: true }])
    assert.ok((await stat(join(root, 'storage', owner, 'workspace', 'default'))).isDirectory())
    const defaultWorkspace = await pool.query<{ id: number }>(
      `SELECT id FROM workspaces WHERE user_id=$1 AND enabled=true ORDER BY id LIMIT 1`, [owner],
    )
    assert.ok(defaultWorkspace.rows[0])
    defaultWorkspaceId = defaultWorkspace.rows[0]!.id
    const mutableDirectory = await pool.query<{ id: number }>(`INSERT INTO workspace_directories(
      user_id,name,directory_name,is_default,is_system,created_at,updated_at)
      VALUES($1,'合成可编辑目录','synthetic-workspace',false,false,now(),now()) RETURNING id`, [owner])
    const mutableWorkspace = await pool.query<{ id: number }>(`INSERT INTO workspaces(
      user_id,name,kind,directory_id,enabled,is_default,created_at,updated_at)
      VALUES($1,'合成可编辑目录','directory',$2,true,false,now(),now()) RETURNING id`, [owner, mutableDirectory.rows[0]!.id])
    mutableWorkspaceId = mutableWorkspace.rows[0]!.id
    const seed = await pool.query(`SELECT counts.file_count::integer AS project_files,
        onboarding.state->'seed'->>'seeded' AS seeded,
        (SELECT sum(size_bytes) FROM files WHERE user_id=$1) AS file_bytes,
        (SELECT count(*)::integer FROM calendar_events WHERE user_id=$1) AS events
      FROM onboarding_state onboarding
      JOIN project_file_counts counts ON counts.project_id=(onboarding.state->'seed'->>'project_id')::integer
      WHERE onboarding.user_id=$1`, [owner])
    assert.equal(seed.rows[0]?.seeded, 'true', '首个账号应完成引导播种')
    assert.equal(seed.rows[0]?.project_files, 2)
    assert.equal(seed.rows[0]?.events, 1)
    assert.ok(Number(seed.rows[0]?.file_bytes) > 0)
    assert.deepEqual((await pool.query(
      'SELECT source_type,status FROM rag_index_jobs WHERE user_id=$1 ORDER BY source_type', [owner],
    )).rows, [{ source_type: 'calendar', status: 'queued' }, { source_type: 'project', status: 'queued' }])
    const firstFile = await pool.query<{ storage_key: string }>(
      "SELECT storage_key FROM files WHERE user_id=$1 AND space='project' ORDER BY id LIMIT 1", [owner])
    assert.match(await readFile(join(root, 'storage', firstFile.rows[0]!.storage_key), 'utf8'), /^# (给未来的自己|第一份记录)\n/u)

    const foreign = randomUUID()
    foreignOwnerId = foreign
    await pool.query("INSERT INTO users(id,username,email,hashed_password) VALUES ($1,'小南','south@example.test','synthetic')", [foreign])
    await pool.query(`INSERT INTO clients(user_id,name,contact,email,phone,notes,created_at)
      VALUES ($1,'合成联系人','合成联系人本人','north-client@example.test','', '',now()),
        ($2,'异主联系人','异主联系人本人','south-client@example.test','', '',now())`, [owner, foreign])
    const ownerProject = await pool.query<{ id: number; name: string }>(
      'SELECT id,name FROM projects WHERE user_id=$1 AND deleted_at IS NULL AND archived=false ORDER BY id LIMIT 1', [owner],
    )
    assert.ok(ownerProject.rows[0], '首个账号引导应播种一个可列出的项目')
    ownerProjectId = ownerProject.rows[0]!.id
    const foreignProject = await pool.query<{ id: number }>(`INSERT INTO projects(user_id,name,status,color,progress,stages_json,version,archived,created_at,updated_at)
      VALUES ($1,'异主合成项目','active','blue',0,'[]',1,false,now(),now()) RETURNING id`, [foreign])
    foreignProjectId = foreignProject.rows[0]!.id
    const storageRoot = join(root, 'storage')
    const personalRoot = (user: string) => `${user}/个人文件`
    const diskTrash = createDiskTrash(storageRoot, async user => personalRoot(user))
    const fixtureTime = Date.now()
    const deletedAt = (minutesAgo: number) => new Date(fixtureTime - minutesAgo * 60_000).toISOString()
    for (const [user, name, minutesAgo] of [
      [owner, '回收站合成文件.txt', 60],
      [foreign, '异主回收站文件.txt', 30],
      [owner, '单文件恢复样本.txt', 90],
    ] as const) {
      const key = `${personalRoot(user)}/${name}`
      await mkdir(join(storageRoot, personalRoot(user)), { recursive: true })
      await writeFile(join(storageRoot, key), '单文件恢复正文')
      const entry = await diskTrash.store(user, 'personal', name, key, deletedAt(minutesAgo))
      assert.ok(entry)
      if (name === '单文件恢复样本.txt') restoreFilePath = `/trash/${entry.id}`
    }
    const folderKey = `${personalRoot(owner)}/合成资料目录`
    await mkdir(join(storageRoot, folderKey), { recursive: true })
    await writeFile(join(storageRoot, folderKey, '合成子文件.txt'), '合成文件恢复正文')
    const directoryEntry = await diskTrash.store(owner, 'personal', '合成资料目录', folderKey, deletedAt(120))
    assert.ok(directoryEntry)
    restoreFolderPath = `/trash/${directoryEntry.id}`
    const notes = await pool.query<{ id: number; user_id: string }>(`INSERT INTO mind_nodes(
        user_id,kind,title,content_md,content_plain,color,origin,version,captured_at,created_at,updated_at,deleted_at)
      VALUES ($1,'note','合成笔记','月球笔记：己方合成内容。\n第二行','月球笔记：己方合成内容。\n第二行',NULL,'user',1,now(),now(),now(),NULL),
        ($2,'note','异主笔记','月球笔记：异主思维秘密','月球笔记：异主思维秘密',NULL,'user',1,now(),now(),now(),NULL) RETURNING id,user_id`, [owner, foreign])
    ownerNoteId = notes.rows.find(row => row.user_id === owner)?.id
    foreignNoteId = notes.rows.find(row => row.user_id === foreign)?.id
    assert.ok(ownerNoteId && foreignNoteId)
    const canvases = await pool.query<{ id: number; user_id: string }>(`INSERT INTO mind_maps(user_id,title,project_id,data_json,created_at,updated_at,deleted_at)
      VALUES ($1,'己方合成画布',NULL,'{"x":12,"y":24,"scale":1,"viewport":{"width":800,"height":600}}',now(),now(),NULL),
        ($2,'异主画布秘密',NULL,'{}',now(),now(),NULL) RETURNING id,user_id`, [owner, foreign])
    ownerCanvasId = canvases.rows.find(row => row.user_id === owner)?.id
    foreignCanvasId = canvases.rows.find(row => row.user_id === foreign)?.id
    assert.ok(ownerCanvasId && foreignCanvasId)
    const canvasNote = await pool.query<{ id: number }>(`INSERT INTO mind_nodes(
        user_id,kind,title,content_md,content_plain,color,origin,version,captured_at,created_at,updated_at,deleted_at)
      VALUES ($1,'canvas_note','月球画布节点','月球画布节点：己方内容。','月球画布节点：己方内容。',NULL,'user',1,now(),now(),now(),NULL) RETURNING id`, [owner])
    ownerCanvasNodeId = canvasNote.rows[0]?.id
    assert.ok(ownerCanvasNodeId)
    const canvasItem = await pool.query<{ id: number }>(`INSERT INTO mind_canvas_items(
        user_id,canvas_id,node_id,x,y,w,h,z,collapsed,data_json,created_at,updated_at,deleted_at)
      VALUES ($1,$2,$3,10,20,240,120,1,false,'{}',now(),now(),NULL) RETURNING id`, [owner, ownerCanvasId, ownerCanvasNodeId])
    ownerCanvasItemId = canvasItem.rows[0]?.id
    assert.ok(ownerCanvasItemId)
    const localDate = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date()).map(part => [part.type, part.value]))
    const upcomingStart = new Date(`${localDate.year}-${localDate.month}-${localDate.day}T00:00:00Z`)
    upcomingStart.setUTCDate(upcomingStart.getUTCDate() + 1)
    const upcomingDate = upcomingStart.toISOString().slice(0, 10)
    await pool.query(`INSERT INTO calendar_events(user_id,title,date,type,version,created_at)
      VALUES ($1,'合成近期安排',$3,'event',1,now()),($2,'异主近期安排',$3,'event',1,now())`, [owner, foreign, upcomingDate])
    const ownEvent = await pool.query<{ id: number }>(
      "SELECT id FROM calendar_events WHERE user_id=$1 AND title='合成近期安排'", [owner],
    )
    await pool.query(`INSERT INTO scheduled_tasks(user_id,event_id,reminder_lead_minutes,name,payload,cron,schedule_kind,
        start_at,channels,enabled,delivery_targets,created_at,updated_at)
      VALUES ($1,$3,42,'合成提醒','不可见提醒正文','@once:synthetic-owner','once',now(),'web,qq',false,
        '{"qq":{"chat_type":"group"}}'::json,now(),now()),
        ($2,$3,99,'异主提醒','不可见异主正文','@once:synthetic-foreign','once',now(),'web',false,NULL,now(),now())`,
    [owner, foreign, ownEvent.rows[0]!.id])
    await pool.query(`INSERT INTO scheduled_tasks(user_id,event_id,reminder_lead_minutes,name,payload,cron,schedule_kind,
        start_at,channels,enabled,delivery_targets,created_at,updated_at)
      VALUES ($1,NULL,NULL,'合成独立任务','独立任务合成指令','0 9 * * *','cron',NULL,'web',true,NULL,now(),now()),
        ($2,NULL,NULL,'异主独立任务','异主合成指令','0 10 * * *','cron',NULL,'web',true,NULL,now(),now())`, [owner, foreign])
    await pool.query("INSERT INTO conversation_sessions(user_id,source,title,last_message_seq) VALUES ($1,'web','月球校验报告',1),($2,'web','月球校验报告',1)", [owner, foreign])
    await pool.query(`INSERT INTO conversation_messages(session_id,role,content,conversation_seq,created_at)
      VALUES(1,'user','月球校验：己方合成报告状态已完成。',1,now()),(2,'user','月球校验：异主机密标记。',1,now())`)
    const chat = (message: string, sessionId?: number, attachments?: string[]) => fetch(base + '/api/v1/agent/chat', {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ message, locale: 'zh-CN', session_id: sessionId, attachments }), signal: AbortSignal.timeout(12_000),
    })
    const beforeIndex = await chat('无索引普通对话')
    const beforeSse = await beforeIndex.text()
    assert.equal(beforeIndex.status, 200, beforeSse)
    assert.match(beforeSse, /"type":"done"/u)
    assert.doesNotMatch(beforeSse, /"type":"error"/u)
    assert.equal(requests.length, 1, beforeSse)
    assert.deepEqual((await pool.query(
      "SELECT status FROM rag_index_jobs WHERE user_id=$1 AND source_type='conversation'", [owner],
    )).rows, [{ status: 'queued' }])
    const officeAttachmentId = `office-${randomUUID()}`
    const actualOfficeBytes = syntheticDocx('Agent Chat 生产 Office 附件正文')
    const officeStorageKey = `${owner}/chat/agent-office-attachment.docx`
    await mkdir(join(root, 'storage', owner, 'chat'), { recursive: true })
    await writeFile(join(root, 'storage', officeStorageKey), actualOfficeBytes)
    await pool.query(`INSERT INTO chat_attachments(user_id,attach_id,name,ext,mime,size,storage_key,kind,state)
      VALUES ($1,$2,'agent-office-attachment.docx','docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',$3,$4,'text','draft')`,
    [owner, officeAttachmentId, actualOfficeBytes.byteLength, officeStorageKey])
    const officeResponse = await chat('请阅读当前工作表附件并总结', undefined, [officeAttachmentId])
    const officeSse = await officeResponse.text()
    assert.equal(officeResponse.status, 200, officeSse)
    assert.match(officeSse, /"type":"done"/u)
    assert.doesNotMatch(officeSse, /"type":"error"/u)
    assert.ok(requests.at(-1)?.includes('Agent Chat 生产 Office 附件正文'), '已解析的 Office 正文必须进入真实 Provider 请求')
    const claimedOfficeAttachment = await pool.query<{ state: string; message_id: number }>(
      'SELECT state,message_id FROM chat_attachments WHERE user_id=$1 AND attach_id=$2', [owner, officeAttachmentId],
    )
    assert.equal(claimedOfficeAttachment.rows[0]?.state, 'attached')
    assert.ok(Number(claimedOfficeAttachment.rows[0]?.message_id) > 0)
    const knowledgeNow = Date.now() / 1000
    const ragKnowledge: AgentKnowledgeEntry = {
      id: ragKnowledgeId, title: 'Node生产RAG合成知识', content: '星辰检索合成词对应的隔离 owner 知识正文。',
      topic: 'Node RAG 检索验收', keywords: [ragKnowledgeKeyword], description: '用于生产工具调用边界回归。',
      scope: { type: 'owner', owner_user_id: owner, platform: '', bot_id: '', group_id: '', scope_id: '', project_id: '' },
      source: { type: 'user', ref: '', label: '合成验收条目', checked_at: null }, confidence: 'confirmed',
      version: 1, parent_id: null, created_at: knowledgeNow, updated_at: knowledgeNow, active: true, history: [],
    }
    const foreignRagKnowledge: AgentKnowledgeEntry = {
      ...ragKnowledge, id: foreignRagKnowledgeId, title: '异主RAG机密条目',
      content: '星辰检索合成词对应的异主机密正文。',
      scope: { ...ragKnowledge.scope, owner_user_id: foreignOwnerId! },
    }
    for (const [knowledgeOwner, entry] of [[owner, ragKnowledge], [foreignOwnerId!, foreignRagKnowledge]] as const) {
      const knowledgeDirectory = join(root, 'storage', knowledgeOwner, '.agent', 'knowledge')
      await mkdir(join(knowledgeDirectory, 'entries'), { recursive: true })
      await writeFile(join(knowledgeDirectory, '.timestamps-iso-v1'), 'synthetic test marker')
      await writeFile(join(knowledgeDirectory, 'entries', `${entry.id}.md`), serializeAgentKnowledgeEntry(entry))
    }
    await host.close()
    host = undefined
    assert.equal(await applyInteractionActionsMigration(pool), 'applied')
    assert.equal(await applyRagIndexMigration(pool), 'applied')
    requests.length = 0
    host = await startServer(env)
    await waitFor(async () => (await pool.query(`SELECT DISTINCT source_type FROM knowledge_index_entries
      WHERE owner_user_id=$1 AND source_type IN ('calendar','project') AND deleted_at IS NULL`, [owner])).rowCount === 2,
    AbortSignal.timeout(8000), () => 'Node Worker 未从首个账号的引导数据建立项目与日历索引')
    await waitFor(async () => (await pool.query(`SELECT owner_user_id,source_id FROM knowledge_index_entries
      WHERE source_type='knowledge' AND source_id=ANY($1::text[]) AND deleted_at IS NULL`, [[ragKnowledgeId, foreignRagKnowledgeId]])).rowCount === 2,
    AbortSignal.timeout(8000), () => 'Node Worker 未从 owner 与异主 Markdown 文件建立知识索引')
    const denied = await fetch(base + '/api/v1/agent/sessions/2/stream', { headers: auth, signal: AbortSignal.timeout(4000) })
    assert.equal(denied.status, 404)
    await denied.body?.cancel()
    const stateLabelUrl = '/api/v1/admin/agent/state-labels'
    assert.equal((await host.app.inject({ url: stateLabelUrl, headers: auth })).statusCode, 403)
    const login = await host.app.inject({ method: 'POST', url: '/api/v1/admin/auth/login',
      payload: { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD } })
    assert.equal(login.statusCode, 200)
    const adminHeaders = { authorization: `Bearer ${login.json().access_token}` }
    const catalog = await host.app.inject({ url: stateLabelUrl, headers: adminHeaders })
    assert.equal(catalog.statusCode, 200)
    const toolRows = catalog.json().tools
    assert.deepEqual(toolRows.find((row: { key: string }) => row.key === 'search_conversations'),
      { key: 'search_conversations', default: '搜历史对话', custom: '', label: '搜历史对话' })
    assert.deepEqual(toolRows.find((row: { key: string }) => row.key === 'list_projects'),
      { key: 'list_projects', default: '查询项目列表', custom: '', label: '查询项目列表' })
    const setLabel = await host.app.inject({ method: 'PUT', url: stateLabelUrl, headers: adminHeaders, payload: {
      overrides: { search_conversations: ' 查找既有报告 | 查找旧会话 ', list_projects: '查询项目列表' },
    } })
    assert.equal(setLabel.statusCode, 200)
    assert.deepEqual(setLabel.json(), { ok: true, count: 1 })
    const savedLabels = await host.app.inject({ url: stateLabelUrl, headers: adminHeaders })
    assert.equal(savedLabels.statusCode, 200)
    assert.deepEqual(savedLabels.json().tools.find((row: { key: string }) => row.key === 'search_conversations'),
      { key: 'search_conversations', default: '搜历史对话', custom: '查找既有报告 | 查找旧会话', label: '查找既有报告 | 查找旧会话' })
    const searchRequestStart = requests.length
    const response = await chat('查找我之前的合成报告。')
    const sse = await response.text()
    assert.equal(response.status, 200, sse)
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/)
    assert.match(sse, /"type":"done"/u)
    assert.match(sse, /"type":"tool_done"/u)
    const searchRequests = requests.slice(searchRequestStart)
    const sessionEvent = sse.split('\n').find(line => line.startsWith('data: ') && line.includes('"type":"session_id"'))
    assert.ok(sessionEvent, sse)
    const responseSessionId = (JSON.parse(sessionEvent.slice('data: '.length)) as { session_id: number }).session_id
    const toolEvents = sse.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
      .filter(event => event.type === 'display_event' && event.item.toolName === 'search_conversations')
    assert.ok(toolEvents.length >= 2)
    const readEvents = sse.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
      .filter(event => event.type === 'display_event' && event.item.toolName === 'read_conversation')
    assert.ok(readEvents.length >= 2, '历史搜索结果应可继续驱动真实历史正文读取工具')
    const label = toolEvents[0].item.toolLabelOverride
    assert.ok(['查找既有报告', '查找旧会话'].includes(label))
    assert.ok(toolEvents.every(event => event.item.toolLabelOverride === label))
    const history = await host.app.inject({ url: `/api/v1/agent/sessions/${responseSessionId}/messages`, headers: auth })
    assert.equal(history.statusCode, 200, history.body)
    assert.partialDeepStrictEqual(history.json().session, { filesystemAuthorizationEnabled: true, filesystemAuthorized: false })
    const historyBody = history.json()
    assert.ok(Array.isArray(historyBody.timelineEvents), `历史消息响应缺少时间线：${JSON.stringify(historyBody)}`)
    assert.ok(historyBody.timelineEvents.some((item: { toolName?: string; toolLabelOverride?: string }) =>
      item.toolName === 'search_conversations' && item.toolLabelOverride === label),
    `历史时间线缺少工具标签 ${String(label)}：${JSON.stringify(historyBody.timelineEvents)}`)
    assert.doesNotMatch(sse, /"type":"error"|异主机密标记/u)
    assert.equal(searchRequests.length, 3, sse)
    const continuation = JSON.parse(searchRequests[1]!) as { messages: Array<{ role: string; content: unknown }> }
    assert.match(JSON.stringify(continuation.messages.filter(row => row.role === 'tool')), /己方合成报告状态已完成/u)
    const readContinuation = JSON.parse(searchRequests[2]!) as { messages: Array<{ role: string; content: unknown }> }
    const historyContent = readContinuation.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(historyContent))
    const historyText = (historyContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof historyText, 'string')
    const historyResult = JSON.parse(historyText as string) as { messages: Array<{ role: string; content: string }> }
    assert.deepEqual(historyResult.messages, [{ role: '你', content: '月球校验：己方合成报告状态已完成。' }])
    assert.ok(searchRequests.every(body => !body.includes('异主机密标记')))
    assert.deepEqual((await pool.query("SELECT status FROM agent_run_checkpoints WHERE user_id=$1 ORDER BY session_id", [owner])).rows,
      [{ status: 'completed' }, { status: 'completed' }, { status: 'completed' }])
    assert.deepEqual((await pool.query("SELECT content FROM conversation_messages WHERE session_id=4 AND role='assistant' AND canonical_batch_id IS NULL")).rows,
      [{ content: '找到了合成会话。' }])
    const timeResponse = await chat('读取合成当前时间。', 4)
    const timeSse = await timeResponse.text()
    assert.equal(timeResponse.status, 200, timeSse)
    assert.match(timeSse, /"type":"done"/u)
    assert.match(timeSse, /"type":"tool_done"/u)
    const timeToolEvents = timeSse.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
      .filter(event => event.type === 'display_event' && event.item.toolName === 'get_current_time')
    assert.ok(timeToolEvents.length >= 2, '当前时间必须经过生产注册器及工具分派')
    const timeRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const timeContent = timeRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(timeContent))
    const timeText = (timeContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof timeText, 'string')
    const timeValue = JSON.parse(timeText as string) as { date: string; weekday: string; time: string; datetime: string; timezone: string }
    assert.match(timeValue.date, /^\d{4}-\d{2}-\d{2}$/u)
    assert.match(timeValue.time, /^\d{2}:\d{2}:\d{2}$/u)
    assert.equal(timeValue.datetime, `${timeValue.date} ${timeValue.time}`)
    assert.match(timeValue.weekday, /^星期[一二三四五六日]$/u)
    assert.equal(timeValue.timezone, 'Asia/Tokyo', '模型提供的 UTC 不能覆盖数据库中的可信 owner 时区')
    const upcomingResponse = await chat('读取合成最近安排。', 4)
    const upcomingSse = await upcomingResponse.text()
    assert.equal(upcomingResponse.status, 200, upcomingSse)
    assert.match(upcomingSse, /"type":"done"/u)
    const upcomingEvents = upcomingSse.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
      .filter(event => event.type === 'display_event' && event.item.toolName === 'get_upcoming')
    assert.ok(upcomingEvents.length >= 2, '近期安排必须经过生产注册器及共享领域读服务')
    const upcomingRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const upcomingContent = upcomingRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(upcomingContent))
    const upcomingText = (upcomingContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof upcomingText, 'string')
    const upcoming = JSON.parse(upcomingText as string) as { from: string; to: string; count: number; items: unknown[] }
    assert.match(upcoming.from, /^\d{4}-\d{2}-\d{2}$/u)
    assert.match(upcoming.to, /^\d{4}-\d{2}-\d{2}$/u)
    assert.equal(upcoming.count, upcoming.items.length)
    assert.match(JSON.stringify(upcoming.items), /合成近期安排/u)
    assert.doesNotMatch(JSON.stringify(upcoming.items), /异主近期安排/u)
    const eventsResponse = await chat('列出合成日历事件。', 4)
    const eventsSse = await eventsResponse.text()
    assert.equal(eventsResponse.status, 200, eventsSse)
    assert.match(eventsSse, /"type":"done"/u)
    const eventsToolEvents = eventsSse.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
      .filter(event => event.type === 'display_event' && event.item.toolName === 'list_events')
    assert.ok(eventsToolEvents.length >= 2, '日历列表必须经过生产注册器及共享日历 reader')
    const eventsRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const eventsContent = eventsRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(eventsContent))
    const eventsText = (eventsContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof eventsText, 'string')
    const eventsValue = JSON.parse(eventsText as string) as unknown[]
    assert.match(JSON.stringify(eventsValue), /合成近期安排/u)
    assert.doesNotMatch(JSON.stringify(eventsValue), /异主近期安排/u)
    const listedOwnerEvent = eventsValue.find(value => typeof value === 'object' && value !== null
      && 'title' in value && value.title === '合成近期安排') as { reminders?: unknown[] } | undefined
    assert.deepEqual(listedOwnerEvent?.reminders, [
      { lead_minutes: 42, channels: ['web', 'qq'], enabled: false, delivery_mode: 'current_group' },
    ])
    assert.doesNotMatch(JSON.stringify(eventsValue), /异主提醒|不可见提醒正文/u)
    const clientsRequestStart = requests.length
    const clientsResponse = await chat('列出合成联系人。', 4)
    const clientsSse = await clientsResponse.text()
    assert.equal(clientsResponse.status, 200, clientsSse)
    assert.match(clientsSse, /"type":"done"/u)
    const clientsToolEvents = clientsSse.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
      .filter(event => event.type === 'display_event' && event.item.toolName === 'list_contacts')
    assert.ok(clientsToolEvents.length >= 2, '联系人列表必须经过生产注册器及 Core owner-scoped client service')
    const clientsRequest = requests.slice(clientsRequestStart).map(body => JSON.parse(body) as {
      messages: Array<{ role: string; tool_call_id?: string; content: unknown }>
    })
      .findLast(request => JSON.stringify(request.messages.filter(row => row.role === 'tool')).includes('合成联系人'))
    assert.ok(clientsRequest, '联系人工具结果必须进入本轮 Provider 续轮')
    const clientsContent = clientsRequest.messages.find(row => row.role === 'tool'
      && row.tool_call_id === 'synthetic-list-clients')?.content
    const clientsText = typeof clientsContent === 'string' ? clientsContent
      : Array.isArray(clientsContent)
        ? (clientsContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
        : undefined
    assert.equal(typeof clientsText, 'string')
    assert.match(clientsText as string, /合成联系人/u)
    assert.doesNotMatch(clientsText as string, /异主联系人/u)
    const projectsResponse = await chat('列出合成项目。', 4)
    const projectsSse = await projectsResponse.text()
    assert.equal(projectsResponse.status, 200, projectsSse)
    assert.match(projectsSse, /"type":"done"/u)
    const projectsToolEvents = projectsSse.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
      .filter(event => event.type === 'display_event' && event.item.toolName === 'list_projects')
    assert.ok(projectsToolEvents.length >= 2, '项目列表必须经过生产注册器及 Core owner-scoped project service')
    const projectsRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const projectsContent = projectsRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(projectsContent))
    const projectsText = (projectsContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof projectsText, 'string')
    assert.match(projectsText as string, new RegExp(ownerProject.rows[0]!.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
    assert.doesNotMatch(projectsText as string, /异主合成项目/u)
    const workspacesResponse = await chat('列出合成工作区。', 4)
    const workspacesSse = await workspacesResponse.text()
    assert.equal(workspacesResponse.status, 200, workspacesSse)
    assert.match(workspacesSse, /"type":"done"/u)
    assert.ok(workspacesSse.includes('list_workspaces'))
    const workspacesRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const workspacesContent = workspacesRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(workspacesContent))
    const workspacesText = (workspacesContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof workspacesText, 'string')
    assert.match(workspacesText as string, /default/u)
    const workspaceDetailResponse = await chat('读取合成工作区详情。', 4)
    const workspaceDetailSse = await workspaceDetailResponse.text()
    assert.equal(workspaceDetailResponse.status, 200, workspaceDetailSse)
    assert.match(workspaceDetailSse, /"type":"done"/u)
    assert.ok(workspaceDetailSse.includes('get_workspace'))
    const workspaceDetailRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const workspaceDetailContent = workspaceDetailRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(workspaceDetailContent))
    const workspaceDetailText = (workspaceDetailContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof workspaceDetailText, 'string')
    assert.match(workspaceDetailText as string, /default/u)
    const updateWorkspaceResponse = await chat('更新合成工作区显示名称。', 4)
    const updateWorkspaceSse = await updateWorkspaceResponse.text()
    assert.equal(updateWorkspaceResponse.status, 200, updateWorkspaceSse)
    assert.match(updateWorkspaceSse, /"type":"done"/u)
    assert.ok(updateWorkspaceSse.includes('update_workspace'))
    assert.deepEqual((await pool.query<{ name: string; directory_display_name: string; directory_name: string }>(`SELECT
      w.name,d.name AS directory_display_name,d.directory_name
      FROM workspaces w JOIN workspace_directories d ON d.id=w.directory_id AND d.user_id=w.user_id
      WHERE w.user_id=$1 AND w.id=$2`, [owner, mutableWorkspaceId])).rows, [
      { name: 'Agent更新的合成工作区', directory_display_name: 'Agent更新的合成工作区', directory_name: 'synthetic-workspace' },
    ])
    assert.deepEqual((await pool.query<{ directory_name: string }>(`SELECT directory_name FROM workspace_directories
      WHERE user_id=$1`, [foreign])).rows, [])
    const listedTasksResponse = await chat('列出合成独立定时任务。', 4)
    const listedTasksSse = await listedTasksResponse.text()
    assert.equal(listedTasksResponse.status, 200, listedTasksSse)
    assert.match(listedTasksSse, /"type":"done"/u)
    assert.ok(listedTasksSse.includes('list_scheduled_tasks'))
    const listedTasksRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const listedTasksContent = listedTasksRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(listedTasksContent))
    const listedTasksText = (listedTasksContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof listedTasksText, 'string')
    const listedTasks = JSON.parse(listedTasksText as string) as Array<{ id: number; name: string; instruction: string; workspace_id: number | null }>
    assert.equal(listedTasks.length, 1, '只返回 owner 的独立任务，不返回日历提醒或异主任务')
    assert.equal(listedTasks[0]?.name, '合成独立任务')
    assert.equal(listedTasks[0]?.instruction, '独立任务合成指令')
    assert.equal(listedTasks[0]?.workspace_id, null)
    const createScheduledTaskResponse = await chat('创建合成独立定时任务。', 4)
    const createScheduledTaskSse = await createScheduledTaskResponse.text()
    assert.equal(createScheduledTaskResponse.status, 200, createScheduledTaskSse)
    assert.match(createScheduledTaskSse, /"type":"done"/u)
    assert.ok(createScheduledTaskSse.includes('create_scheduled_task'), `${createScheduledTaskSse}\n${requests.at(-1)}`)
    const createdScheduledTask = await pool.query<{ id: number; user_id: string; name: string; payload: string; schedule_kind: string; start_at: Date; enabled: boolean; channels: string }>(
      "SELECT id,user_id,name,payload,schedule_kind,start_at,enabled,channels FROM scheduled_tasks WHERE user_id=$1 AND name='Agent合成独立任务' AND event_id IS NULL", [owner],
    )
    assert.equal(createdScheduledTask.rowCount, 1)
    assert.deepEqual(createdScheduledTask.rows[0], {
      id: createdScheduledTask.rows[0]!.id, user_id: owner, name: 'Agent合成独立任务',
      payload: '只用于隔离测试，不执行外部操作。', schedule_kind: 'once', start_at: new Date(scheduledTaskStartAt),
      enabled: false, channels: 'web',
    })
    scheduledTaskId = createdScheduledTask.rows[0]!.id
    const updateScheduledTaskResponse = await chat('更新合成独立定时任务。', 4)
    const updateScheduledTaskSse = await updateScheduledTaskResponse.text()
    assert.equal(updateScheduledTaskResponse.status, 200, updateScheduledTaskSse)
    assert.match(updateScheduledTaskSse, /"type":"done"/u)
    assert.ok(updateScheduledTaskSse.includes('update_scheduled_task'))
    assert.deepEqual((await pool.query<{ user_id: string; name: string; payload: string; enabled: boolean; channels: string }>(
      'SELECT user_id,name,payload,enabled,channels FROM scheduled_tasks WHERE id=$1 AND user_id=$2 AND event_id IS NULL', [scheduledTaskId, owner],
    )).rows, [{ user_id: owner, name: 'Agent合成独立任务已更新', payload: '更新后的隔离指令。', enabled: false, channels: 'web' }])
    const scheduledTaskRevisionKey = `live-revision:${owner}:scheduled_tasks`
    const readRedisValue = createRedisValueReader(redisUrl!)
    const revisionBeforeTaskDelete = Number(await readRedisValue(scheduledTaskRevisionKey) ?? 0)
    const deleteScheduledTaskResponse = await chat('删除合成独立定时任务。', 4)
    const deleteScheduledTaskSse = await deleteScheduledTaskResponse.text()
    assert.equal(deleteScheduledTaskResponse.status, 200, deleteScheduledTaskSse)
    const deleteScheduledTaskInteractionLine = deleteScheduledTaskSse.split('\n').find(line =>
      line.startsWith('data: ') && line.includes('"type":"interaction_required"'))
    assert.ok(deleteScheduledTaskInteractionLine, deleteScheduledTaskSse)
    const deleteScheduledTaskInteraction = JSON.parse(deleteScheduledTaskInteractionLine.slice('data: '.length)) as {
      prompt_id: number; session_id: number; options: Array<{ id: string; token: string }>
    }
    assert.deepEqual((await pool.query<{ kind: string; status: string }>(
      'SELECT kind,status FROM interaction_prompts WHERE id=$1 AND user_id=$2 AND session_id=$3',
      [deleteScheduledTaskInteraction.prompt_id, owner, deleteScheduledTaskInteraction.session_id],
    )).rows, [{ kind: 'confirm', status: 'active' }])
    assert.equal((await pool.query('SELECT id FROM scheduled_tasks WHERE id=$1 AND user_id=$2 AND event_id IS NULL', [scheduledTaskId, owner])).rowCount, 1,
      '用户确认之前，定时任务删除不能产生副作用')
    const deleteScheduledTaskRun = await pool.query<{ run_id: string }>(
      'SELECT run_id FROM agent_interaction_bindings WHERE prompt_id=$1 AND user_id=$2 AND session_id=$3',
      [deleteScheduledTaskInteraction.prompt_id, owner, deleteScheduledTaskInteraction.session_id],
    )
    assert.equal(deleteScheduledTaskRun.rowCount, 1)
    const confirmScheduledTaskDelete = deleteScheduledTaskInteraction.options.find(option => option.id === 'confirm')
    assert.ok(confirmScheduledTaskDelete?.token)
    const deleteTaskProviderCalls = requests.length
    const confirmScheduledTaskDeleteResponse = await fetch(base + `/api/v1/agent/interactions/${deleteScheduledTaskInteraction.prompt_id}/resume`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ token: confirmScheduledTaskDelete.token }), signal: AbortSignal.timeout(4000),
    })
    assert.equal(confirmScheduledTaskDeleteResponse.status, 200)
    assert.equal((await confirmScheduledTaskDeleteResponse.json() as { status: string }).status, 'confirmed')
    await waitFor(async () => {
      const checkpoint = await pool.query<{ status: string }>(
        'SELECT status FROM agent_run_checkpoints WHERE user_id=$1 AND session_id=$2 AND run_id=$3',
        [owner, deleteScheduledTaskInteraction.session_id, deleteScheduledTaskRun.rows[0]!.run_id],
      )
      const task = await pool.query('SELECT id FROM scheduled_tasks WHERE id=$1 AND user_id=$2 AND event_id IS NULL', [scheduledTaskId, owner])
      const revision = Number(await readRedisValue(scheduledTaskRevisionKey) ?? 0)
      return checkpoint.rows[0]?.status === 'completed' && task.rowCount === 0 && revision > revisionBeforeTaskDelete
        && requests.length > deleteTaskProviderCalls && requests.slice(deleteTaskProviderCalls).some(input => input.includes('synthetic-delete-scheduled-task'))
    }, AbortSignal.timeout(8000), () => '定时任务确认后，删除/Redis 通知/Run 恢复没有闭合')
    const trashResponse = await chat('列出合成回收站。', 4)
    const trashSse = await trashResponse.text()
    assert.equal(trashResponse.status, 200, trashSse)
    assert.match(trashSse, /"type":"done"/u)
    assert.ok(trashSse.includes('list_trash'))
    const trashRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const trashContent = trashRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(trashContent))
    const trashText = (trashContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof trashText, 'string')
    const { items: trash } = JSON.parse(trashText as string) as { items: Array<{ name: string; kind: string; deleted_at: string }> }
    assert.deepEqual(trash.map(({ name, kind }) => ({ name, kind })), [
      { name: '回收站合成文件.txt', kind: 'file' }, { name: '单文件恢复样本.txt', kind: 'file' },
      { name: '合成资料目录', kind: 'directory' },
    ])
    assert.equal(trash[0]!.deleted_at, deletedAt(60))
    for (const [tool, prompt, path, contents] of [
      ['restore_file', '恢复合成回收站文件。', '单文件恢复样本.txt', '单文件恢复正文'],
      ['restore_folder', '恢复合成回收站目录。', '合成资料目录/合成子文件.txt', '合成文件恢复正文'],
    ] as const) {
      const restoredFile = join(storageRoot, personalRoot(owner), path)
      const response = await chat(prompt, 4)
      const sse = await response.text()
      assert.equal(response.status, 200, sse)
      assert.match(sse, /"type":"done"/u)
      assert.ok(sse.includes(tool))
      const line = sse.split('\n').find(line => line.startsWith('data: ') && line.includes('"type":"interaction_required"'))
      assert.ok(line, sse)
      const { prompt_id, options } = JSON.parse(line.slice(6)) as { prompt_id: number; options: Array<{ id: string; token: string }> }
      const token = options.find(option => option.id === 'confirm')?.token
      assert.ok(token)
      await assert.rejects(readFile(restoredFile), { code: 'ENOENT' })
      const confirmation = await fetch(base + `/api/v1/agent/interactions/${prompt_id}/resume`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ token }), signal: AbortSignal.timeout(4000),
      })
      assert.equal(confirmation.status, 200, await confirmation.clone().text())
      await waitFor(async () => await readFile(restoredFile, 'utf8').catch(() => null) === contents,
        AbortSignal.timeout(8000), () => `${tool} 尚未恢复文件`)
    }
    const createClientResponse = await chat('创建合成联系人。', 4)
    const createClientSse = await createClientResponse.text()
    assert.equal(createClientResponse.status, 200, createClientSse)
    assert.match(createClientSse, /"type":"done"/u)
    assert.ok(createClientSse.includes('create_contact'))
    const createdClient = await pool.query<{ id: number; user_id: string; email: string }>(
      "SELECT id,user_id,email FROM clients WHERE name='工具创建联系人'",
    )
    assert.equal(createdClient.rows.length, 1)
    assert.ok(Number.isSafeInteger(createdClient.rows[0]?.id))
    assert.equal(createdClient.rows[0]?.user_id, owner)
    assert.equal(createdClient.rows[0]?.email, 'tool-created@example.test')
    agentCreatedClientId = createdClient.rows[0]!.id
    const updateClientResponse = await chat('更新合成联系人。', 4)
    const updateClientSse = await updateClientResponse.text()
    assert.equal(updateClientResponse.status, 200, updateClientSse)
    assert.match(updateClientSse, /"type":"done"/u)
    assert.ok(updateClientSse.includes('update_contact'))
    assert.deepEqual((await pool.query<{ user_id: string; notes: string }>(
      "SELECT user_id,notes FROM clients WHERE name='工具创建联系人'",
    )).rows, [{ user_id: owner, notes: '已更新合成备注' }])
    const deleteClientResponse = await chat('删除合成联系人。', 4)
    const deleteClientSse = await deleteClientResponse.text()
    assert.equal(deleteClientResponse.status, 200, deleteClientSse)
    assert.match(deleteClientSse, /"type":"done"/u)
    const deleteClientInteractionLine = deleteClientSse.split('\n').find(line =>
      line.startsWith('data: ') && line.includes('"type":"interaction_required"'))
    assert.ok(deleteClientInteractionLine, deleteClientSse)
    const deleteClientInteraction = JSON.parse(deleteClientInteractionLine.slice('data: '.length)) as {
      prompt_id: number; session_id: number; options: Array<{ id: string; token: string }>
    }
    assert.deepEqual((await pool.query<{ kind: string; status: string }>(
      'SELECT kind,status FROM interaction_prompts WHERE id=$1 AND user_id=$2 AND session_id=$3',
      [deleteClientInteraction.prompt_id, owner, deleteClientInteraction.session_id],
    )).rows, [{ kind: 'confirm', status: 'active' }])
    assert.equal((await pool.query('SELECT id FROM clients WHERE id=$1 AND user_id=$2', [agentCreatedClientId, owner])).rowCount, 1,
      '用户确认之前，删除工具不能产生副作用')
    const deleteClientRun = await pool.query<{ run_id: string }>(
      'SELECT run_id FROM agent_interaction_bindings WHERE prompt_id=$1 AND user_id=$2 AND session_id=$3',
      [deleteClientInteraction.prompt_id, owner, deleteClientInteraction.session_id],
    )
    assert.equal(deleteClientRun.rowCount, 1)
    const confirmDelete = deleteClientInteraction.options.find(option => option.id === 'confirm')
    assert.ok(confirmDelete?.token)
    const deleteProviderCalls = requests.length
    const confirmDeleteResponse = await fetch(base + `/api/v1/agent/interactions/${deleteClientInteraction.prompt_id}/resume`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ token: confirmDelete.token }), signal: AbortSignal.timeout(4000),
    })
    assert.equal(confirmDeleteResponse.status, 200)
    assert.equal((await confirmDeleteResponse.json() as { status: string }).status, 'confirmed')
    await waitFor(async () => {
      const checkpoint = await pool.query<{ status: string }>(
        'SELECT status FROM agent_run_checkpoints WHERE user_id=$1 AND session_id=$2 AND run_id=$3',
        [owner, deleteClientInteraction.session_id, deleteClientRun.rows[0]!.run_id],
      )
      const client = await pool.query('SELECT id FROM clients WHERE id=$1 AND user_id=$2', [agentCreatedClientId, owner])
      return checkpoint.rows[0]?.status === 'completed' && client.rowCount === 0
        && requests.length > deleteProviderCalls && requests.slice(deleteProviderCalls).some(input => input.includes('synthetic-delete-client'))
    }, AbortSignal.timeout(8000), () => '联系人确认后，持久 Run 未完成删除并恢复 Provider')
    assert.equal((await pool.query('SELECT id FROM clients WHERE id=$1 AND user_id=$2', [agentCreatedClientId, owner])).rowCount, 0)
    const createProjectResponse = await chat('创建合成项目。', 4)
    const createProjectSse = await createProjectResponse.text()
    assert.equal(createProjectResponse.status, 200, createProjectSse)
    assert.match(createProjectSse, /"type":"done"/u)
    assert.ok(createProjectSse.includes('create_project'))
    const createdProject = await pool.query<{ id: number; status: string; priority: string | null; stages_json: string }>(
      "SELECT id,status,priority,stages_json FROM projects WHERE user_id=$1 AND name='工具创建项目' AND deleted_at IS NULL", [owner],
    )
    assert.equal(createdProject.rows.length, 1)
    assert.equal(createdProject.rows[0]?.status, 'pending')
    assert.equal(createdProject.rows[0]?.priority, 'high')
    const storedStages = JSON.parse(createdProject.rows[0]!.stages_json) as Array<{ label: string; todos: unknown[] }>
    assert.deepEqual(storedStages.map(stage => stage.label), ['计划', '执行', '交付'])
    assert.ok(storedStages.every(stage => stage.todos.length === 0))
    const updateProjectResponse = await chat('修改合成项目。', 4)
    const updateProjectSse = await updateProjectResponse.text()
    assert.equal(updateProjectResponse.status, 200, updateProjectSse)
    assert.match(updateProjectSse, /"type":"done"/u)
    assert.ok(updateProjectSse.includes('update_project'))
    assert.deepEqual((await pool.query<{ user_id: string; summary: string | null }>(
      "SELECT user_id,summary FROM projects WHERE user_id=$1 AND name='工具创建项目' AND deleted_at IS NULL", [owner],
    )).rows, [{ user_id: owner, summary: '通过正式 Agent 更新' }])
    const colorResponse = await chat('设置合成项目颜色。', 4)
    const colorSse = await colorResponse.text()
    assert.equal(colorResponse.status, 200, colorSse)
    assert.match(colorSse, /"type":"done"/u)
    assert.ok(colorSse.includes('set_color'))
    assert.deepEqual((await pool.query<{ user_id: string; color: string }>(
      "SELECT user_id,color FROM projects WHERE user_id=$1 AND name='工具创建项目' AND deleted_at IS NULL", [owner],
    )).rows, [{ user_id: owner, color: 'linear-gradient(135deg,#7ab8a8,#7ab8c8)' }])
    for (const [prompt, toolName] of [
      ['添加合成阶段。', 'add_stage'], ['重命名合成阶段。', 'rename_stage'], ['添加合成待办。', 'update_stage'],
      ['重设合成阶段。', 'set_stages'], ['删除合成阶段。', 'remove_stage'],
    ] as const) {
      const stageResponse = await chat(prompt, 4)
      const stageSse = await stageResponse.text()
      assert.equal(stageResponse.status, 200, stageSse)
      assert.match(stageSse, /"type":"done"/u)
      assert.ok(stageSse.includes(toolName), `${toolName} 必须经过生产 ToolRegistry dispatch`)
    }
    const finalProjectStages = await pool.query<{ current_stage: string | null; stages_json: string }>(
      "SELECT current_stage,stages_json FROM projects WHERE user_id=$1 AND name='工具创建项目' AND deleted_at IS NULL", [owner],
    )
    const finalStages = JSON.parse(finalProjectStages.rows[0]!.stages_json) as Array<{ key: string; label: string; todos: Array<{ id: unknown; text: string; done: boolean }> }>
    assert.deepEqual(finalStages.map(stage => stage.label), ['待办阶段'])
    assert.ok(finalStages[0]?.todos[0]?.id)
    assert.deepEqual(finalStages[0]?.todos.map(({ text, done }) => ({ text, done })), [{ text: '合成待办', done: false }])
    assert.equal(finalProjectStages.rows[0]?.current_stage, 's3')
    const projectDetailResponse = await chat('读取合成项目详情。', 4)
    const projectDetailSse = await projectDetailResponse.text()
    assert.equal(projectDetailResponse.status, 200, projectDetailSse)
    assert.match(projectDetailSse, /"type":"done"/u)
    assert.ok(projectDetailSse.includes('get_project'))
    const projectDetailRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const projectDetailContent = projectDetailRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(projectDetailContent))
    const projectDetailText = (projectDetailContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof projectDetailText, 'string')
    assert.ok((projectDetailText as string).includes(ownerProject.rows[0]!.name))
    assert.match(projectDetailText as string, /【文件总数】[1-9]\d*/u)
    assert.doesNotMatch(projectDetailText as string, /异主合成项目/u)
    const foreignProjectResponse = await chat('读取异主合成项目详情。', 4)
    const foreignProjectSse = await foreignProjectResponse.text()
    assert.equal(foreignProjectResponse.status, 200, foreignProjectSse)
    assert.match(foreignProjectSse, /"type":"done"/u)
    const foreignProjectRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const foreignProjectContent = foreignProjectRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(foreignProjectContent))
    const foreignProjectText = (foreignProjectContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof foreignProjectText, 'string')
    assert.match(foreignProjectText as string, /不存在/u)
    assert.doesNotMatch(foreignProjectText as string, /异主合成项目/u)
    const schemaResponse = await chat('读取合成工具Schema。', 4)
    const schemaSse = await schemaResponse.text()
    assert.equal(schemaResponse.status, 200, schemaSse)
    assert.match(schemaSse, /"type":"done"/u)
    assert.ok(schemaSse.includes('search_tools'))
    const schemaEvents = schemaSse.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
      .filter(event => event.type === 'display_event' && event.item.toolName === 'search_tools')
    assert.ok(schemaEvents.length >= 2, 'Schema discovery 必须经过生产 registry 并实际投影到 Run 事件')
    assert.match(schemaSse, /list_events/u, '实际工具结果应包含当前授权的目标 schema 名称')
    const createEventResponse = await chat('创建合成日历事件。', 4)
    const createEventSse = await createEventResponse.text()
    assert.equal(createEventResponse.status, 200, createEventSse)
    assert.match(createEventSse, /"type":"done"/u)
    assert.ok(createEventSse.includes('create_event'))
    const createdEvent = await pool.query<{ id: number; title: string; date: string; type: string }>(
      'SELECT id,title,date,type FROM calendar_events WHERE user_id=$1 AND title=$2 AND deleted_at IS NULL', [owner, eventCreateTitle],
    )
    assert.equal(createdEvent.rowCount, 1, createEventSse)
    assert.deepEqual(createdEvent.rows[0], { id: createdEvent.rows[0]?.id, title: eventCreateTitle, date: eventCreateDate, type: 'event' })
    agentCreatedEventId = createdEvent.rows[0]?.id
    assert.ok(agentCreatedEventId)
    const remindersBeforeUpdate = await pool.query<{ id: number; reminder_lead_minutes: number; cron: string; enabled: boolean }>(
      'SELECT id,reminder_lead_minutes,cron,enabled FROM scheduled_tasks WHERE user_id=$1 AND event_id=$2 ORDER BY reminder_lead_minutes',
      [owner, agentCreatedEventId],
    )
    assert.equal(remindersBeforeUpdate.rowCount, 2)
    const updateEventResponse = await chat('更新合成日历事件。', 4)
    const updateEventSse = await updateEventResponse.text()
    assert.equal(updateEventResponse.status, 200, updateEventSse)
    assert.match(updateEventSse, /"type":"done"/u)
    assert.ok(updateEventSse.includes('update_event'))
    const updatedCalendarEvent = await pool.query<{ id: number; title: string; date: string; time: string; user_id: string }>(
      'SELECT id,title,date,time,user_id FROM calendar_events WHERE id=$1 AND deleted_at IS NULL', [agentCreatedEventId],
    )
    assert.deepEqual(updatedCalendarEvent.rows[0], {
      id: agentCreatedEventId, title: eventUpdatedTitle, date: eventCreateDate, time: '12:00', user_id: owner,
    })
    const updatedEventReminders = await pool.query<{ reminder_lead_minutes: number; channels: string; enabled: boolean; event_id: number }>(
      'SELECT reminder_lead_minutes,channels,enabled,event_id FROM scheduled_tasks WHERE user_id=$1 AND event_id=$2 ORDER BY reminder_lead_minutes',
      [owner, agentCreatedEventId],
    )
    assert.deepEqual(updatedEventReminders.rows, [
      { reminder_lead_minutes: 30, channels: 'web', enabled: true, event_id: agentCreatedEventId },
      { reminder_lead_minutes: 60, channels: 'web', enabled: false, event_id: agentCreatedEventId },
    ], 'update_event 未显式传提醒时必须保留提醒 ID、提前量、渠道和停用状态')
    const reminderSchedulesAfter = await pool.query<{ id: number; cron: string; name: string; payload: string }>(
      'SELECT id,cron,name,payload FROM scheduled_tasks WHERE user_id=$1 AND event_id=$2 ORDER BY reminder_lead_minutes',
      [owner, agentCreatedEventId],
    )
    assert.deepEqual(reminderSchedulesAfter.rows.map(row => row.id), remindersBeforeUpdate.rows.map(row => row.id),
      '更新活动时间必须保留提醒任务身份')
    assert.notEqual(reminderSchedulesAfter.rows[0]?.cron, remindersBeforeUpdate.rows[0]?.cron,
      '启用提醒必须按活动新时间重排')
    assert.equal(reminderSchedulesAfter.rows[1]?.cron, remindersBeforeUpdate.rows[1]?.cron,
      '停用提醒的触发计划必须保留')
    assert.ok(reminderSchedulesAfter.rows.every(row => row.name === `${eventUpdatedTitle} 提醒` && row.payload.includes(eventUpdatedTitle)),
      '更新活动标题后提醒元数据必须一起更新')
    const globalSearchResponse = await chat('跨类型搜索合成日程。', 4)
    const globalSearchSse = await globalSearchResponse.text()
    assert.equal(globalSearchResponse.status, 200, globalSearchSse)
    assert.match(globalSearchSse, /"type":"done"/u)
    assert.ok(globalSearchSse.includes('global_search'))
    const globalSearchRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const globalSearchContent = globalSearchRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(globalSearchContent))
    const globalSearchText = (globalSearchContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof globalSearchText, 'string')
    assert.match(globalSearchText as string, /【摘要】命中 1 项/u)
    assert.match(globalSearchText as string, /【来源类型】event/u)
    assert.ok((globalSearchText as string).includes(eventUpdatedTitle))
    assert.doesNotMatch(globalSearchText as string, /异主近期安排|异主提醒|异主机密标记/u,
      'global_search 必须以可信 lease owner 查询，忽略 Provider 传入的 owner_id')
    const calendarRevisionKey = `live-revision:${owner}:calendar`
    const calendarRevisionBeforeDelete = Number(await readRedisValue(calendarRevisionKey) ?? 0)
    const remindersBeforeDelete = await pool.query<{ id: number; enabled: boolean }>(
      'SELECT id,enabled FROM scheduled_tasks WHERE user_id=$1 AND event_id=$2 ORDER BY reminder_lead_minutes', [owner, agentCreatedEventId],
    )
    assert.deepEqual(remindersBeforeDelete.rows.map(row => row.enabled), [true, false])
    const deleteEventResponse = await chat('删除合成日历事件。', 4)
    const deleteEventSse = await deleteEventResponse.text()
    assert.equal(deleteEventResponse.status, 200, deleteEventSse)
    const deleteEventInteractionLine = deleteEventSse.split('\n').find(line =>
      line.startsWith('data: ') && line.includes('"type":"interaction_required"'))
    assert.ok(deleteEventInteractionLine, deleteEventSse)
    const deleteEventInteraction = JSON.parse(deleteEventInteractionLine.slice('data: '.length)) as {
      prompt_id: number; session_id: number; options: Array<{ id: string; token: string }>
    }
    assert.deepEqual((await pool.query<{ kind: string; status: string }>(
      'SELECT kind,status FROM interaction_prompts WHERE id=$1 AND user_id=$2 AND session_id=$3',
      [deleteEventInteraction.prompt_id, owner, deleteEventInteraction.session_id],
    )).rows, [{ kind: 'confirm', status: 'active' }])
    assert.equal((await pool.query('SELECT id FROM calendar_events WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [agentCreatedEventId, owner])).rowCount, 1,
      '用户确认之前，日历事件不能被删除')
    const deleteEventRun = await pool.query<{ run_id: string }>(
      'SELECT run_id FROM agent_interaction_bindings WHERE prompt_id=$1 AND user_id=$2 AND session_id=$3',
      [deleteEventInteraction.prompt_id, owner, deleteEventInteraction.session_id],
    )
    assert.equal(deleteEventRun.rowCount, 1)
    const confirmEventDelete = deleteEventInteraction.options.find(option => option.id === 'confirm')
    assert.ok(confirmEventDelete?.token)
    const deleteEventProviderCalls = requests.length
    const confirmEventDeleteResponse = await fetch(base + `/api/v1/agent/interactions/${deleteEventInteraction.prompt_id}/resume`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ token: confirmEventDelete.token }), signal: AbortSignal.timeout(4000),
    })
    assert.equal(confirmEventDeleteResponse.status, 200)
    assert.equal((await confirmEventDeleteResponse.json() as { status: string }).status, 'confirmed')
    await waitFor(async () => {
      const checkpoint = await pool.query<{ status: string }>(
        'SELECT status FROM agent_run_checkpoints WHERE user_id=$1 AND session_id=$2 AND run_id=$3',
        [owner, deleteEventInteraction.session_id, deleteEventRun.rows[0]!.run_id],
      )
      const event = await pool.query('SELECT id FROM calendar_events WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [agentCreatedEventId, owner])
      const reminders = await pool.query<{ enabled: boolean }>(
        'SELECT enabled FROM scheduled_tasks WHERE user_id=$1 AND event_id=$2 ORDER BY reminder_lead_minutes', [owner, agentCreatedEventId],
      )
      const revision = Number(await readRedisValue(calendarRevisionKey) ?? 0)
      return checkpoint.rows[0]?.status === 'completed' && event.rowCount === 0
        && reminders.rows.length === 2 && reminders.rows.every(row => !row.enabled)
        && revision > calendarRevisionBeforeDelete && requests.length > deleteEventProviderCalls
        && requests.slice(deleteEventProviderCalls).some(input => input.includes('synthetic-delete-event'))
    }, AbortSignal.timeout(8000), () => '日历确认后，事件软删/提醒停用/Redis 通知/Run 恢复没有闭合')
    const readKnowledgeResponse = await chat('检索Node知识库合成条目。', 4)
    const readKnowledgeSse = await readKnowledgeResponse.text()
    assert.equal(readKnowledgeResponse.status, 200, readKnowledgeSse)
    assert.match(readKnowledgeSse, /"type":"done"/u)
    assert.ok(readKnowledgeSse.includes('read_knowledge'))
    const readKnowledgeRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const readKnowledgeContent = readKnowledgeRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(readKnowledgeContent))
    const readKnowledgeText = (readKnowledgeContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof readKnowledgeText, 'string')
    const readKnowledge = JSON.parse(readKnowledgeText as string) as {
      success: boolean; query: string; strategy: string; returned: number; entries: Array<{
        knowledge_id: string; title: string; content: string; version: string
      }>
    }
    assert.equal(readKnowledge.success, true)
    assert.equal(readKnowledge.query, ragKnowledgeKeyword)
    assert.equal(readKnowledge.strategy, 'bm25')
    assert.equal(readKnowledge.returned, 1)
    assert.equal(readKnowledge.entries.length, 1, 'RAG 搜索结果只能包含当前 owner 的知识记录')
    assert.deepEqual(readKnowledge.entries.map(({ knowledge_id, title, version }) => ({ knowledge_id, title, version })), [{
      knowledge_id: ragKnowledgeId, title: ragKnowledge.title, version: '1',
    }])
    assert.match(readKnowledge.entries[0]!.content, /Node生产RAG合成知识/u)
    assert.match(readKnowledge.entries[0]!.content, /星辰检索合成词/u)
    assert.match(readKnowledge.entries[0]!.content, /隔离 owner 知识正文/u,
      '关键词检索应返回正式索引的共享标题/摘要/正文投影，不直接读取 FS 原文')
    assert.doesNotMatch(readKnowledgeText as string, /异主RAG机密条目|异主机密正文/u)
    const exactKnowledgeResponse = await chat('精确读取Node RAG知识。', 4)
    const exactKnowledgeSse = await exactKnowledgeResponse.text()
    assert.equal(exactKnowledgeResponse.status, 200, exactKnowledgeSse)
    assert.match(exactKnowledgeSse, /"type":"done"/u)
    assert.ok(exactKnowledgeSse.includes('read_knowledge'))
    const exactKnowledgeRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const exactKnowledgeContent = exactKnowledgeRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(exactKnowledgeContent))
    const exactKnowledgeText = (exactKnowledgeContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof exactKnowledgeText, 'string')
    const exactKnowledge = JSON.parse(exactKnowledgeText as string) as {
      success: boolean; entry: { knowledge_id: string; title: string; topic: string; description: string; keywords: string[];
        confidence: string; source_type: string; content: string; scope_type: string; version: number; created_at: string; updated_at: string }
    }
    assert.equal(exactKnowledge.success, true)
    assert.deepEqual(exactKnowledge.entry, {
      knowledge_id: ragKnowledgeId, title: ragKnowledge.title, topic: ragKnowledge.topic,
      description: ragKnowledge.description, keywords: [ragKnowledgeKeyword], confidence: 'confirmed', source_type: 'user',
      scope_type: 'owner', content: ragKnowledge.content, version: 1,
      created_at: exactKnowledge.entry.created_at, updated_at: exactKnowledge.entry.updated_at,
    })
    const foreignKnowledgeResponse = await chat('尝试读取异主RAG条目。', 4)
    const foreignKnowledgeSse = await foreignKnowledgeResponse.text()
    assert.equal(foreignKnowledgeResponse.status, 200, foreignKnowledgeSse)
    assert.match(foreignKnowledgeSse, /"type":"done"/u)
    const foreignKnowledgeRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const foreignKnowledgeContent = foreignKnowledgeRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(foreignKnowledgeContent))
    const foreignKnowledgeText = (foreignKnowledgeContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof foreignKnowledgeText, 'string')
    assert.match(foreignKnowledgeText as string, /知识条目不存在或已停用/u)
    assert.doesNotMatch(foreignKnowledgeText as string, /异主RAG机密条目|异主机密正文/u)
    const saveKnowledgeResponse = await chat('保存Node知识回归。', 4)
    const saveKnowledgeSse = await saveKnowledgeResponse.text()
    assert.equal(saveKnowledgeResponse.status, 200, saveKnowledgeSse)
    assert.match(saveKnowledgeSse, /"type":"done"/u)
    const knowledgeFilePath = join(root, 'storage', owner, '.agent', 'knowledge', 'entries', `${ragKnowledgeId}.md`)
    if (process.platform === 'linux') {
      assert.ok(saveKnowledgeSse.includes('save_knowledge'))
      const saveKnowledgeRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
      const saveKnowledgeContent = saveKnowledgeRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
      assert.ok(Array.isArray(saveKnowledgeContent))
      const saveKnowledgeText = (saveKnowledgeContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
      assert.equal(typeof saveKnowledgeText, 'string')
      const saveKnowledgeResult = JSON.parse(saveKnowledgeText as string) as { success?: boolean; error?: string }
      assert.equal(saveKnowledgeResult.success, true, saveKnowledgeText as string)
      const savedKnowledge = parseAgentKnowledgeEntry(await readFile(knowledgeFilePath))
      assert.deepEqual({ id: savedKnowledge.id, title: savedKnowledge.title, content: savedKnowledge.content, version: savedKnowledge.version }, {
        id: ragKnowledgeId, title: 'Node生产RAG合成知识已保存', content: 'Node保存工具写入的第一版知识正文。', version: 2,
      }, 'save_knowledge 必须复用同 topic owner 条目并持久递增版本')
      await waitFor(async () => {
        const row = await pool.query<{ document_version: string }>(`SELECT document_version FROM knowledge_index_entries
          WHERE owner_user_id=$1 AND source_type='knowledge' AND source_id=$2 AND deleted_at IS NULL LIMIT 1`, [owner, ragKnowledgeId])
        return row.rows[0]?.document_version.startsWith('2:') === true
      }, AbortSignal.timeout(8000), () => 'save_knowledge 后 Node Worker 未刷新正式 RAG 索引')
      const updateKnowledgeResponse = await chat('更新Node知识回归。', 4)
      const updateKnowledgeSse = await updateKnowledgeResponse.text()
      assert.equal(updateKnowledgeResponse.status, 200, updateKnowledgeSse)
      assert.match(updateKnowledgeSse, /"type":"done"/u)
      assert.ok(updateKnowledgeSse.includes('update_knowledge'))
      const updatedKnowledge = parseAgentKnowledgeEntry(await readFile(knowledgeFilePath))
      assert.deepEqual({ id: updatedKnowledge.id, title: updatedKnowledge.title, content: updatedKnowledge.content,
        keywords: updatedKnowledge.keywords, version: updatedKnowledge.version }, {
        id: ragKnowledgeId, title: 'Node生产RAG合成知识已更新',
        content: 'Node更新工具写入并重建索引的最终知识正文。',
        keywords: [ragKnowledgeKeyword, 'Node更新回归词'], version: 3,
      }, 'update_knowledge 必须保留同一 owner ID 并写入新的正文版本')
      assert.equal(updatedKnowledge.history.at(-1)?.content, 'Node保存工具写入的第一版知识正文。')
      await waitFor(async () => {
        const row = await pool.query<{ document_version: string }>(`SELECT document_version FROM knowledge_index_entries
          WHERE owner_user_id=$1 AND source_type='knowledge' AND source_id=$2 AND deleted_at IS NULL LIMIT 1`, [owner, ragKnowledgeId])
        return row.rows[0]?.document_version.startsWith('3:') === true
      }, AbortSignal.timeout(8000), () => 'update_knowledge 后 Node Worker 未刷新正式 RAG 索引')
    } else {
      const request = JSON.parse(requests.at(-1)!) as { tools?: Array<{ function?: { name?: string } }> }
      assert.equal(request.tools?.some(tool => ['save_knowledge', 'update_knowledge'].includes(tool.function?.name ?? '')), false,
        '当前 Host 不具备 Linux 安全原子写入能力时，不得向 Agent 暴露知识写工具')
      const unchangedKnowledge = parseAgentKnowledgeEntry(await readFile(knowledgeFilePath))
      assert.equal(unchangedKnowledge.version, 1, '缺少安全写入后端时必须保持知识主数据不变')
    }
    const listSkillsResponse = await chat('列出合成技能目录。', 4)
    const listSkillsSse = await listSkillsResponse.text()
    assert.equal(listSkillsResponse.status, 200, listSkillsSse)
    assert.match(listSkillsSse, /"type":"done"/u)
    assert.ok(listSkillsSse.includes('list_skills'))
    const listSkillsRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const listSkillsContent = listSkillsRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(listSkillsContent))
    const listSkillsText = (listSkillsContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof listSkillsText, 'string')
    const skillCatalog = JSON.parse(listSkillsText as string) as { count: number; skills: Array<{ id: string; name: string; source: string; enabled: boolean; body?: unknown }> }
    assert.ok(skillCatalog.count > 0)
    const chartSkill = skillCatalog.skills.find(skill => skill.id === 'S2')
    assert.ok(chartSkill)
    assert.deepEqual({ id: chartSkill?.id, name: chartSkill?.name, source: chartSkill?.source, enabled: chartSkill?.enabled }, {
      id: 'S2', name: '图表与数学表达', source: 'builtin', enabled: true,
    })
    assert.equal(Object.hasOwn(chartSkill, 'body'), false, '技能目录只暴露 Markdown head 元数据，不返回正文')
    const useSkillResponse = await chat('加载合成内置技能。', 4)
    const useSkillSse = await useSkillResponse.text()
    assert.equal(useSkillResponse.status, 200, useSkillSse)
    assert.match(useSkillSse, /"type":"done"/u)
    assert.ok(useSkillSse.includes('use_skill'))
    const useSkillContinuation = JSON.parse(requests.at(-1)!) as { messages: unknown[] }
    assert.match(JSON.stringify(useSkillContinuation.messages), /本 Skill 包含两种独立的视觉表达方式/u,
      'use_skill 正文应经生产续轮进入下一次 Provider 请求')
    const createSkillResponse = await chat('创建合成用户技能。', 4)
    const createSkillSse = await createSkillResponse.text()
    assert.equal(createSkillResponse.status, 200, createSkillSse)
    assert.match(createSkillSse, /"type":"done"/u)
    assert.ok(createSkillSse.includes('create_skill'))
    const createdSkill = (await listUserSkillBundles(storageRoot, owner)).skills.find(skill => skill.name === 'Agent合成用户技能')
    assert.ok(createdSkill, 'Agent 创建的技能必须写入用户文件目录')
    userSkillId = createdSkill.id
    assert.equal((await readUserSkillBundle(storageRoot, owner, userSkillId)).body, '# Agent合成用户技能\n\n初始技能正文。')
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM user_skills WHERE owner_id=$1', [owner])).rows[0]?.count, 0,
      '文件技能创建不应回写旧技能表')
    const updateSkillResponse = await chat('更新合成用户技能。', 4)
    const updateSkillSse = await updateSkillResponse.text()
    assert.equal(updateSkillResponse.status, 200, updateSkillSse)
    assert.match(updateSkillSse, /"type":"done"/u)
    assert.ok(updateSkillSse.includes('update_skill'))
    const updatedSkill = await readUserSkillBundle(storageRoot, owner, userSkillId)
    assert.equal(updatedSkill.name, 'Agent合成用户技能已更新')
    assert.equal(updatedSkill.body, '# Agent合成用户技能\n\n更新后的用户技能正文。')
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM user_skills WHERE owner_id=$1', [owner])).rows[0]?.count, 0,
      '文件技能更新不应使用旧技能表')
    const useUserSkillResponse = await chat('加载更新后的合成用户技能。', 4)
    const useUserSkillSse = await useUserSkillResponse.text()
    assert.equal(useUserSkillResponse.status, 200, useUserSkillSse)
    assert.match(useUserSkillSse, /"type":"done"/u)
    assert.ok(useUserSkillSse.includes('use_skill'))
    const useUserSkillContinuation = JSON.parse(requests.at(-1)!) as { messages: unknown[] }
    assert.match(JSON.stringify(useUserSkillContinuation.messages), /更新后的用户技能正文/u,
      '用户技能更新后的正文应经生产续轮进入下一次 Provider 请求')
    const skillRevisionKey = `live-revision:${owner}:skills`
    const skillRevisionBeforeDelete = Number(await readRedisValue(skillRevisionKey) ?? 0)
    const deleteSkillResponse = await chat('删除合成用户技能。', 4)
    const deleteSkillSse = await deleteSkillResponse.text()
    assert.equal(deleteSkillResponse.status, 200, deleteSkillSse)
    const deleteSkillInteractionLine = deleteSkillSse.split('\n').find(line =>
      line.startsWith('data: ') && line.includes('"type":"interaction_required"'))
    assert.ok(deleteSkillInteractionLine, deleteSkillSse)
    const deleteSkillInteraction = JSON.parse(deleteSkillInteractionLine.slice('data: '.length)) as {
      prompt_id: number; session_id: number; options: Array<{ id: string; token: string }>
    }
    assert.deepEqual((await pool.query<{ kind: string; status: string }>(
      'SELECT kind,status FROM interaction_prompts WHERE id=$1 AND user_id=$2 AND session_id=$3',
      [deleteSkillInteraction.prompt_id, owner, deleteSkillInteraction.session_id],
    )).rows, [{ kind: 'confirm', status: 'active' }])
    await assert.doesNotReject(() => readUserSkillBundle(storageRoot, owner, userSkillId),
      '用户确认之前，技能删除不能产生副作用')
    const deleteSkillRun = await pool.query<{ run_id: string }>(
      'SELECT run_id FROM agent_interaction_bindings WHERE prompt_id=$1 AND user_id=$2 AND session_id=$3',
      [deleteSkillInteraction.prompt_id, owner, deleteSkillInteraction.session_id],
    )
    assert.equal(deleteSkillRun.rowCount, 1)
    const confirmSkillDelete = deleteSkillInteraction.options.find(option => option.id === 'confirm')
    assert.ok(confirmSkillDelete?.token)
    const deleteSkillProviderCalls = requests.length
    const confirmSkillDeleteResponse = await fetch(base + `/api/v1/agent/interactions/${deleteSkillInteraction.prompt_id}/resume`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ token: confirmSkillDelete.token }), signal: AbortSignal.timeout(4000),
    })
    assert.equal(confirmSkillDeleteResponse.status, 200)
    assert.equal((await confirmSkillDeleteResponse.json() as { status: string }).status, 'confirmed')
    await waitFor(async () => {
      const checkpoint = await pool.query<{ status: string }>(
        'SELECT status FROM agent_run_checkpoints WHERE user_id=$1 AND session_id=$2 AND run_id=$3',
        [owner, deleteSkillInteraction.session_id, deleteSkillRun.rows[0]!.run_id],
      )
      const skill = await readUserSkillBundle(storageRoot, owner, userSkillId).catch(() => null)
      const revision = Number(await readRedisValue(skillRevisionKey) ?? 0)
      return checkpoint.rows[0]?.status === 'completed' && skill === null && revision > skillRevisionBeforeDelete
        && requests.length > deleteSkillProviderCalls && requests.slice(deleteSkillProviderCalls).some(input => input.includes('synthetic-delete-user-skill'))
    }, AbortSignal.timeout(8000), () => '技能确认后，删除/Redis 通知/Run 恢复没有闭合')
    const noteSearchResponse = await chat('搜索合成笔记。', 4)
    const noteSearchSse = await noteSearchResponse.text()
    assert.equal(noteSearchResponse.status, 200, noteSearchSse)
    assert.match(noteSearchSse, /"type":"done"/u)
    assert.ok(noteSearchSse.includes('note_search'))
    const noteSearchRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const noteSearchContent = noteSearchRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(noteSearchContent))
    const noteSearchText = (noteSearchContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof noteSearchText, 'string')
    assert.match(noteSearchText as string, /己方合成内容/u)
    assert.match(noteSearchText as string, new RegExp(String(ownerNoteId), 'u'))
    assert.doesNotMatch(noteSearchText as string, /异主思维秘密/u)
    const noteGetResponse = await chat('读取合成笔记。', 4)
    const noteGetSse = await noteGetResponse.text()
    assert.equal(noteGetResponse.status, 200, noteGetSse)
    assert.match(noteGetSse, /"type":"done"/u)
    assert.ok(noteGetSse.includes('note_get'))
    const noteGetRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const noteGetContent = noteGetRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(noteGetContent))
    const noteGetText = (noteGetContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof noteGetText, 'string')
    const noteDetail = JSON.parse(noteGetText as string) as { node: { numbered_content: string } }
    assert.equal(noteDetail.node.numbered_content, '1: 月球笔记：己方合成内容。\n2: 第二行')
    const foreignNoteResponse = await chat('读取异主合成笔记。', 4)
    const foreignNoteSse = await foreignNoteResponse.text()
    assert.equal(foreignNoteResponse.status, 200, foreignNoteSse)
    assert.match(foreignNoteSse, /"type":"done"/u)
    const foreignNoteRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const foreignNoteContent = foreignNoteRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(foreignNoteContent))
    const foreignNoteText = (foreignNoteContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof foreignNoteText, 'string')
    assert.match(foreignNoteText as string, /找不到这条思维节点/u)
    assert.doesNotMatch(foreignNoteText as string, /异主思维秘密/u)
    const noteCreateResponse = await chat('创建普通合成笔记。', 4)
    const noteCreateSse = await noteCreateResponse.text()
    assert.equal(noteCreateResponse.status, 200, noteCreateSse)
    assert.match(noteCreateSse, /"type":"done"/u)
    assert.ok(noteCreateSse.includes('note_create'))
    const createdOrdinaryNote = await pool.query<{ id: number; user_id: string; content_md: string; content_plain: string; version: number }>(
      "SELECT id,user_id,content_md,content_plain,version FROM mind_nodes WHERE user_id=$1 AND kind='note' AND title='Agent普通合成笔记' AND deleted_at IS NULL", [owner],
    )
    assert.equal(createdOrdinaryNote.rowCount, 1)
    assert.deepEqual(createdOrdinaryNote.rows[0], {
      id: createdOrdinaryNote.rows[0]!.id, user_id: owner,
      content_md: '# Agent普通合成笔记\n\n初始正文', content_plain: 'Agent普通合成笔记\n初始正文', version: 1,
    })
    ordinaryNoteId = createdOrdinaryNote.rows[0]!.id
    const noteUpdateResponse = await chat('追加普通合成笔记。', 4)
    const noteUpdateSse = await noteUpdateResponse.text()
    assert.equal(noteUpdateResponse.status, 200, noteUpdateSse)
    assert.match(noteUpdateSse, /"type":"done"/u)
    assert.ok(noteUpdateSse.includes('note_update'))
    assert.deepEqual((await pool.query<{ user_id: string; content_md: string; content_plain: string; version: number }>(
      "SELECT user_id,content_md,content_plain,version FROM mind_nodes WHERE id=$1 AND user_id=$2 AND kind='note' AND deleted_at IS NULL", [ordinaryNoteId, owner],
    )).rows, [{ user_id: owner, content_md: '# Agent普通合成笔记\n\n初始正文\n\n追加正文', content_plain: 'Agent普通合成笔记\n初始正文\n追加正文', version: createdOrdinaryNote.rows[0]!.version + 1 }])
    const noteDeleteResponse = await chat('软删合成笔记。', 4)
    const noteDeleteSse = await noteDeleteResponse.text()
    assert.equal(noteDeleteResponse.status, 200, noteDeleteSse)
    assert.match(noteDeleteSse, /"type":"done"/u)
    assert.ok(noteDeleteSse.includes('note_delete'))
    const softDeletedNote = await pool.query<{ deleted_at: Date | null; version: number; content_md: string }>(
      'SELECT deleted_at,version,content_md FROM mind_nodes WHERE id=$1 AND user_id=$2', [ownerNoteId, owner],
    )
    assert.equal(softDeletedNote.rows[0]?.deleted_at instanceof Date, true)
    assert.equal(softDeletedNote.rows[0]?.version, 2)
    assert.equal(softDeletedNote.rows[0]?.content_md, '月球笔记：己方合成内容。\n第二行')
    const noteRestoreResponse = await chat('恢复合成笔记。', 4)
    const noteRestoreSse = await noteRestoreResponse.text()
    assert.equal(noteRestoreResponse.status, 200, noteRestoreSse)
    assert.match(noteRestoreSse, /"type":"done"/u)
    assert.ok(noteRestoreSse.includes('note_restore'))
    assert.deepEqual((await pool.query<{ deleted_at: Date | null; version: number; content_md: string }>(
      'SELECT deleted_at,version,content_md FROM mind_nodes WHERE id=$1 AND user_id=$2', [ownerNoteId, owner],
    )).rows, [{ deleted_at: null, version: 3, content_md: '月球笔记：己方合成内容。\n第二行' }])
    assert.deepEqual((await pool.query<{ deleted_at: Date | null; version: number; content_md: string }>(
      'SELECT deleted_at,version,content_md FROM mind_nodes WHERE id=$1 AND user_id=$2', [foreignNoteId, foreign],
    )).rows, [{ deleted_at: null, version: 1, content_md: '月球笔记：异主思维秘密' }], 'owner 笔记生命周期操作不得改动异主内容')
    const noteUndoResponse = await chat('撤销最近咕咕合成笔记。', 4)
    const noteUndoSse = await noteUndoResponse.text()
    assert.equal(noteUndoResponse.status, 200, noteUndoSse)
    assert.match(noteUndoSse, /"type":"done"/u)
    assert.ok(noteUndoSse.includes('note_undo'))
    const undoneNote = await pool.query<{ deleted_at: Date | null; version: number; content_md: string }>(
      'SELECT deleted_at,version,content_md FROM mind_nodes WHERE id=$1 AND user_id=$2', [ordinaryNoteId, owner],
    )
    assert.ok(undoneNote.rows[0]?.deleted_at instanceof Date, 'note_undo 应撤销当前 owner 最近一条由 Agent 创建的普通笔记')
    assert.equal(undoneNote.rows[0]?.version, createdOrdinaryNote.rows[0]!.version + 2)
    assert.equal(undoneNote.rows[0]?.content_md, '# Agent普通合成笔记\n\n初始正文\n\n追加正文')
    const canvasListResponse = await chat('列出合成画布。', 4)
    const canvasListSse = await canvasListResponse.text()
    assert.equal(canvasListResponse.status, 200, canvasListSse)
    assert.match(canvasListSse, /"type":"done"/u)
    assert.ok(canvasListSse.includes('canvas_list'))
    const canvasListRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const canvasListContent = canvasListRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(canvasListContent))
    const canvasListText = (canvasListContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof canvasListText, 'string')
    const canvasList = JSON.parse(canvasListText as string) as { canvases: Array<{ canvas_id: number; title: string; node_count: number; view: { camera: { x: number } | null } }> }
    assert.deepEqual(canvasList.canvases.map(({ canvas_id, title, node_count, view }) => ({ canvas_id, title, node_count, view: view.camera?.x ?? null })), [
      { canvas_id: ownerCanvasId, title: '己方合成画布', node_count: 1, view: 12 },
    ])
    const canvasCreateResponse = await chat('创建合成画布。', 4)
    const canvasCreateSse = await canvasCreateResponse.text()
    assert.equal(canvasCreateResponse.status, 200, canvasCreateSse)
    assert.match(canvasCreateSse, /"type":"done"/u)
    assert.ok(canvasCreateSse.includes('canvas_create'))
    const canvasCreateRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const canvasCreateContent = canvasCreateRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(canvasCreateContent))
    const canvasCreateText = (canvasCreateContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof canvasCreateText, 'string')
    const canvasCreated = JSON.parse(canvasCreateText as string) as { canvas: { canvas_id: number; title: string; project_id: number | null } }
    const persistedCanvas = await pool.query<{ id: number; user_id: string; title: string; project_id: number | null }>(
      "SELECT id,user_id,title,project_id FROM mind_maps WHERE user_id=$1 AND title='Agent创建的合成画布' AND deleted_at IS NULL", [owner],
    )
    assert.equal(persistedCanvas.rowCount, 1)
    assert.deepEqual(canvasCreated.canvas, {
      canvas_id: persistedCanvas.rows[0]!.id, title: 'Agent创建的合成画布', project_id: null,
    })
    assert.equal(persistedCanvas.rows[0]?.user_id, owner)
    const canvasGetResponse = await chat('读取合成画布详情。', 4)
    const canvasGetSse = await canvasGetResponse.text()
    assert.equal(canvasGetResponse.status, 200, canvasGetSse)
    assert.match(canvasGetSse, /"type":"done"/u)
    assert.ok(canvasGetSse.includes('canvas_get'))
    const canvasGetRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const canvasGetContent = canvasGetRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(canvasGetContent))
    const canvasGetText = (canvasGetContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof canvasGetText, 'string')
    const canvasDetail = JSON.parse(canvasGetText as string) as { canvas: { canvas_id: number }; nodes: Array<{ title: string; content_md: string; content_plain: string }> }
    assert.equal(canvasDetail.canvas.canvas_id, ownerCanvasId)
    assert.deepEqual(canvasDetail.nodes.map(({ title, content_md, content_plain }) => ({ title, content_md, content_plain })), [
      { title: '月球画布节点', content_md: '月球画布节点：己方内容。', content_plain: '月球画布节点：己方内容。' },
    ])
    assert.doesNotMatch(canvasGetText as string, /异主画布秘密/u)
    const canvasSearchResponse = await chat('搜索合成画布。', 4)
    const canvasSearchSse = await canvasSearchResponse.text()
    assert.equal(canvasSearchResponse.status, 200, canvasSearchSse)
    assert.match(canvasSearchSse, /"type":"done"/u)
    assert.ok(canvasSearchSse.includes('canvas_search'))
    const canvasSearchRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const canvasSearchContent = canvasSearchRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(canvasSearchContent))
    const canvasSearchText = (canvasSearchContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof canvasSearchText, 'string')
    const canvasSearch = JSON.parse(canvasSearchText as string) as { count: number; matches: Array<{ title: string; content_md: string; content_plain: string }> }
    assert.equal(canvasSearch.count, 1)
    assert.deepEqual(canvasSearch.matches.map(({ title, content_md, content_plain }) => ({ title, content_md, content_plain })), [
      { title: '月球画布节点', content_md: '月球画布节点：己方内容。', content_plain: '月球画布节点：己方内容。' },
    ])
    const canvasFocusResponse = await chat('定位合成画布节点。', 4)
    const canvasFocusSse = await canvasFocusResponse.text()
    assert.equal(canvasFocusResponse.status, 200, canvasFocusSse)
    assert.match(canvasFocusSse, /"type":"done"/u)
    assert.ok(canvasFocusSse.includes('canvas_focus_node'))
    const canvasFocusRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const canvasFocusContent = canvasFocusRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(canvasFocusContent))
    const canvasFocusText = (canvasFocusContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof canvasFocusText, 'string')
    assert.deepEqual(JSON.parse(canvasFocusText as string), {
      canvas_id: ownerCanvasId, item_id: ownerCanvasItemId, node_id: ownerCanvasNodeId, title: '月球画布节点', focus_link: `gugu://focus-canvas/${ownerCanvasId}/${ownerCanvasNodeId}`,
    })
    const canvasPlaceableResponse = await chat('搜索可放入画布的合成项目。', 4)
    const canvasPlaceableSse = await canvasPlaceableResponse.text()
    assert.equal(canvasPlaceableResponse.status, 200, canvasPlaceableSse)
    assert.match(canvasPlaceableSse, /"type":"done"/u)
    assert.ok(canvasPlaceableSse.includes('canvas_search_placeable'))
    const canvasPlaceableRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const canvasPlaceableContent = canvasPlaceableRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(canvasPlaceableContent))
    const canvasPlaceableText = (canvasPlaceableContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof canvasPlaceableText, 'string')
    const canvasPlaceables = JSON.parse(canvasPlaceableText as string) as { matches: Array<{ title: string; ref_type: string }> }
    assert.ok(canvasPlaceables.matches.some(({ title, ref_type }) => title === '工具创建项目' && ref_type === 'project'))
    assert.ok(canvasPlaceables.matches.every(({ title }) => title !== '异主合成项目'))
    const foreignCanvasResponse = await chat('读取异主合成画布详情。', 4)
    const foreignCanvasSse = await foreignCanvasResponse.text()
    assert.equal(foreignCanvasResponse.status, 200, foreignCanvasSse)
    assert.match(foreignCanvasSse, /"type":"done"/u)
    assert.ok(foreignCanvasSse.includes('canvas_get'))
    const foreignCanvasRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const foreignCanvasContent = foreignCanvasRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(foreignCanvasContent))
    const foreignCanvasText = (foreignCanvasContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof foreignCanvasText, 'string')
    assert.match(foreignCanvasText as string, /画布不存在/u)
    assert.doesNotMatch(foreignCanvasText as string, /异主画布秘密/u)
    const canvasCreateNoteResponse = await chat('创建画布合成便签。', 4)
    const canvasCreateNoteSse = await canvasCreateNoteResponse.text()
    assert.equal(canvasCreateNoteResponse.status, 200, canvasCreateNoteSse)
    assert.match(canvasCreateNoteSse, /"type":"done"/u)
    assert.ok(canvasCreateNoteSse.includes('canvas_create_note'))
    const createdNoteRow = await pool.query<{ id: number; version: number }>(
      "SELECT id,version FROM mind_nodes WHERE user_id=$1 AND kind='canvas_note' AND title='Agent合成便签' AND deleted_at IS NULL", [owner],
    )
    assert.equal(createdNoteRow.rowCount, 1)
    ownerCanvasNewNodeId = createdNoteRow.rows[0]!.id
    const createdNoteItem = await pool.query<{ id: number; x: number; y: number }>(
      'SELECT id,x,y FROM mind_canvas_items WHERE user_id=$1 AND canvas_id=$2 AND node_id=$3 AND deleted_at IS NULL', [owner, ownerCanvasId, ownerCanvasNewNodeId],
    )
    assert.equal(createdNoteItem.rowCount, 1)
    const canvasUpdateNodeResponse = await chat('更新合成画布节点位置。', 4)
    const canvasUpdateNodeSse = await canvasUpdateNodeResponse.text()
    assert.equal(canvasUpdateNodeResponse.status, 200, canvasUpdateNodeSse)
    assert.match(canvasUpdateNodeSse, /"type":"done"/u)
    assert.ok(canvasUpdateNodeSse.includes('canvas_update_node'))
    assert.deepEqual((await pool.query<{ x: number; y: number }>(
      'SELECT x,y FROM mind_canvas_items WHERE id=$1 AND user_id=$2 AND canvas_id=$3 AND deleted_at IS NULL', [ownerCanvasItemId, owner, ownerCanvasId],
    )).rows, [{ x: 44, y: 66 }])
    const canvasUpdateNoteResponse = await chat('更新合成画布便签。', 4)
    const canvasUpdateNoteSse = await canvasUpdateNoteResponse.text()
    assert.equal(canvasUpdateNoteResponse.status, 200, canvasUpdateNoteSse)
    assert.match(canvasUpdateNoteSse, /"type":"done"/u)
    assert.ok(canvasUpdateNoteSse.includes('canvas_update_note'))
    assert.deepEqual((await pool.query<{ title: string; content_md: string; content_plain: string; version: number }>(
      'SELECT title,content_md,content_plain,version FROM mind_nodes WHERE id=$1 AND user_id=$2 AND kind=\'canvas_note\' AND deleted_at IS NULL', [ownerCanvasNewNodeId, owner],
    )).rows, [{ title: 'Agent更新的合成便签', content_md: '便签更新内容', content_plain: '便签更新内容', version: createdNoteRow.rows[0]!.version + 1 }])
    const canvasAddNodeResponse = await chat('放置合成项目到画布。', 4)
    const canvasAddNodeSse = await canvasAddNodeResponse.text()
    assert.equal(canvasAddNodeResponse.status, 200, canvasAddNodeSse)
    assert.match(canvasAddNodeSse, /"type":"done"/u)
    assert.ok(canvasAddNodeSse.includes('canvas_add_node'))
    const placedProject = await pool.query<{ user_id: string; canvas_id: number; node_id: number; ref_type: string; ref_id: number }>(`SELECT i.user_id,i.canvas_id,n.id AS node_id,n.ref_type,n.ref_id
      FROM mind_canvas_items i JOIN mind_nodes n ON n.id=i.node_id AND n.user_id=i.user_id
      WHERE i.user_id=$1 AND i.canvas_id=$2 AND n.user_id=$1 AND n.ref_type='project' AND n.ref_id=$3 AND i.deleted_at IS NULL AND n.deleted_at IS NULL`, [owner, ownerCanvasId, ownerProjectId])
    assert.equal(placedProject.rowCount, 1)
    ownerProjectCanvasNodeId = placedProject.rows[0]!.node_id
    assert.deepEqual(placedProject.rows, [{ user_id: owner, canvas_id: ownerCanvasId, node_id: ownerProjectCanvasNodeId, ref_type: 'project', ref_id: ownerProjectId }])
    const canvasConnectResponse = await chat('连接合成画布节点。', 4)
    const canvasConnectSse = await canvasConnectResponse.text()
    assert.equal(canvasConnectResponse.status, 200, canvasConnectSse)
    assert.match(canvasConnectSse, /"type":"done"/u)
    assert.ok(canvasConnectSse.includes('canvas_connect'))
    const relation = await pool.query<{ id: number; user_id: string; canvas_id: number; src_node_id: number; dst_node_id: number }>(`SELECT id,user_id,canvas_id,src_node_id,dst_node_id FROM mind_relations
      WHERE user_id=$1 AND canvas_id=$2 AND deleted_at IS NULL AND src_node_id IN ($3,$4) AND dst_node_id IN ($3,$4)`, [owner, ownerCanvasId, ownerCanvasNewNodeId, ownerProjectCanvasNodeId])
    assert.equal(relation.rowCount, 1)
    ownerCanvasRelationId = relation.rows[0]!.id
    const canvasUpdateAnchorResponse = await chat('修改合成画布关系端点。', 4)
    const canvasUpdateAnchorSse = await canvasUpdateAnchorResponse.text()
    assert.equal(canvasUpdateAnchorResponse.status, 200, canvasUpdateAnchorSse)
    assert.match(canvasUpdateAnchorSse, /"type":"done"/u)
    assert.ok(canvasUpdateAnchorSse.includes('canvas_update_anchor'))
    const canvasData = await pool.query<{ data_json: string }>('SELECT data_json FROM mind_maps WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [ownerCanvasId, owner])
    const canvasState = JSON.parse(canvasData.rows[0]!.data_json) as { relationAnchors: Record<string, { srcSide: string; dstSide: string }> }
    assert.deepEqual(canvasState.relationAnchors[String(ownerCanvasRelationId)], { srcSide: 'right', dstSide: 'left' })
    const canvasRemoveNodeResponse = await chat('从合成画布移除合成便签。', 4)
    const canvasRemoveNodeSse = await canvasRemoveNodeResponse.text()
    assert.equal(canvasRemoveNodeResponse.status, 200, canvasRemoveNodeSse)
    assert.match(canvasRemoveNodeSse, /"type":"done"/u)
    assert.ok(canvasRemoveNodeSse.includes('canvas_remove_node'))
    assert.equal((await pool.query(
      'SELECT id FROM mind_canvas_items WHERE id=$1 AND user_id=$2 AND canvas_id=$3 AND deleted_at IS NOT NULL', [ownerCanvasItemId, owner, ownerCanvasId],
    )).rowCount, 1)
    assert.equal((await pool.query(
      "SELECT id FROM mind_nodes WHERE id=$1 AND user_id=$2 AND kind='canvas_note' AND deleted_at IS NULL AND content_md='月球画布节点：己方内容。'", [ownerCanvasNodeId, owner],
    )).rowCount, 1, '移除画布视图项必须保留来源便签及正文')
    const archiveResponse = await chat('归档合成项目。', 4)
    const archiveSse = await archiveResponse.text()
    assert.equal(archiveResponse.status, 200, archiveSse)
    assert.match(archiveSse, /"type":"done"/u)
    assert.ok(archiveSse.includes('archive_project'))
    assert.deepEqual((await pool.query<{ user_id: string; archived: boolean }>(
      "SELECT user_id,archived FROM projects WHERE user_id=$1 AND name='工具创建项目' AND deleted_at IS NULL", [owner],
    )).rows, [{ user_id: owner, archived: true }])
    if (process.platform === 'linux') {
      const archiveEvents = archiveSse.split('\n').filter(line => line.startsWith('data: '))
        .map(line => JSON.parse(line.slice(6)))
      const archiveRunId = archiveEvents.find(event => event.type === 'done')?.run_id
      const archiveUserMessageId = archiveEvents.find(event => event.type === 'session_id')?.user_message_id
      assert.ok(archiveRunId && archiveUserMessageId)
      let reflection: Record<string, unknown> | undefined
      await waitFor(async () => {
        const { rows: [row] } = await pool.query<{ item: Record<string, unknown> }>(`
          SELECT item FROM web_reflection_intervals CROSS JOIN LATERAL jsonb_array_elements(pending) AS item
          WHERE user_id=$1 AND session_id=4 AND item->>'runId'=$2
        `, [owner, archiveRunId])
        reflection = row?.item
        return Boolean(reflection)
      }, AbortSignal.timeout(5000), () => '生产 Web Agent Run 未将已提交回合写入反思区间')
      assert.ok(reflection)
      assert.equal(typeof reflection.modelIdentity, 'string')
      assert.ok((reflection.modelIdentity as string).length > 0)
      assert.equal(typeof reflection.userMessageId, 'string')
      assert.equal(typeof reflection.runId, 'string')
      assert.equal(typeof reflection.modelScope, 'string')
      assert.equal('threshold' in reflection, false)
      const anchor = await pool.query<{ content: string }>(
        `SELECT m.content FROM conversation_messages m
         JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=$1
         WHERE s.id=4 AND m.role='user' AND m.run_id=$2 AND m.id=$3`, [owner, reflection.runId, archiveUserMessageId],
      )
      assert.equal(anchor.rows[0]?.content, '归档合成项目。')
      assert.equal(reflection.userMessageId, String(archiveUserMessageId), '队列锚点必须指向本 Run 已提交的 owner 消息')
      assert.equal('userMessage' in reflection, false, '队列只保存已提交消息锚点，不复制聊天正文')
      assert.equal(JSON.stringify(reflection).includes('查找我之前的合成报告'), false)
    }

    await host.close()
    host = undefined
    requests.length = 0
    // 只阻止第二次模型请求前的事务：上一个工具结果必须已真实提交。
    await pool.query(`CREATE TABLE synthetic_crash_gate(session_id int PRIMARY KEY);
      CREATE FUNCTION synthetic_pause_before_provider() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.phase='idle' AND NEW.phase='provider'
          AND EXISTS (SELECT 1 FROM synthetic_crash_gate g WHERE g.session_id=NEW.session_id) THEN
          PERFORM pg_advisory_xact_lock(993221);
          RAISE EXCEPTION 'synthetic connection terminated before provider';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER synthetic_pause BEFORE UPDATE ON agent_run_checkpoints
        FOR EACH ROW EXECUTE FUNCTION synthetic_pause_before_provider()`)
    gate = await pool.connect()
    await gate.query('SELECT pg_advisory_lock(993221)')
    const database = (await pool.query<{ username: string; name: string }>('SELECT current_user AS username,current_database() AS name')).rows[0]!
    const startChild = async (applicationName: string) => {
      const connection = new URL(url)
      connection.searchParams.set('user', database.username)
      connection.searchParams.set('database', database.name)
      connection.searchParams.set('application_name', applicationName)
      const processInstance = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
        cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
        env: { ...env, GUGU_WEBUI_DATABASE_URL: connection.toString(), PGUSER: database.username, PGDATABASE: database.name,
          TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      child = processInstance
      let errors = ''
      processInstance.stderr?.setEncoding('utf8').on('data', chunk => { errors = (errors + chunk).slice(-2000) })
      await once(processInstance, 'spawn')
      const signal = AbortSignal.timeout(10_000)
      await waitFor(async () => {
        assert.equal(processInstance.exitCode, null, errors)
        try {
          const response = await fetch(base + '/health', { signal })
          await response.body?.cancel()
          return response.ok
        } catch { return false }
      }, signal, () => `子进程未通过健康检查：${errors || '无进程诊断'}`)
    }
    const firstApplication = `${schema}_first`
    await startChild(firstApplication)
    const interrupted = await chat(crashPrompt)
    assert.equal(interrupted.status, 200)
    assert.ok(interrupted.body)
    const reader = interrupted.body.getReader()
    const decoder = new TextDecoder()
    let initial = ''
    let crashedRun: string
    let crashSessionId: number
    try {
      while (!initial.includes('"type":"tool_done"')) {
        const piece = await reader.read()
        if (piece.done) assert.fail(initial)
        initial += decoder.decode(piece.value, { stream: true })
      }
      const accepted = initial.split('\n').filter(line => line.startsWith('data: '))
        .map(line => JSON.parse(line.slice(6))).find(event => event.type === 'session_id')
      assert.ok(Number.isSafeInteger(accepted?.session_id), initial)
      crashSessionId = accepted.session_id
      await waitFor(async () => (await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'", [firstApplication],
      )).rowCount === 1, AbortSignal.timeout(5000), () => '第一进程未进入模型续轮的事务锁等待')
      const checkpoint = (await pool.query<{ run_id: string; phase: string }>(
        'SELECT run_id,phase FROM agent_run_checkpoints WHERE user_id=$1 AND session_id=$2', [owner, crashSessionId],
      )).rows[0]
      assert.equal(checkpoint?.phase, 'idle')
      crashedRun = checkpoint!.run_id
      assert.equal(requests.length, 1)
      await stopChild(child, 'SIGKILL')
      assert.equal(child?.signalCode, 'SIGKILL')
    } finally {
      await reader.cancel().catch(() => undefined)
      await gate.query('SELECT pg_advisory_unlock(993221)')
      gate.release()
      gate = undefined
    }
    await pool.query('DROP TRIGGER synthetic_pause ON agent_run_checkpoints')
    // 快进到失效时间，仅操作已经退出的合成 Run。
    await pool.query('UPDATE agent_run_leases SET expires_at=now() WHERE user_id=$1 AND session_id=$2 AND run_id=$3', [owner, crashSessionId, crashedRun])
    await pool.query('UPDATE agent_run_dispatch SET lease_expires_at=now() WHERE user_id=$1 AND session_id=$2 AND run_id=$3', [owner, crashSessionId, crashedRun])
    await pool.query(`UPDATE conversation_sessions
      SET session_context=jsonb_set(session_context,'{snapshot_context}','"重启后不同的快照"') WHERE id=$2 AND user_id=$1`, [owner, crashSessionId])
    await startChild(`${schema}_second`)
    const resumed = await fetch(base + `/api/v1/agent/sessions/${crashSessionId}/stream`, { headers: auth, signal: AbortSignal.timeout(12_000) })
    resumeAfterReconnect()
    const resumedSse = await resumed.text()
    assert.equal(resumed.status, 200, resumedSse)
    assert.match(resumedSse, new RegExp(`"type":"done","run_id":"${crashedRun}"`, 'u'))
    assert.doesNotMatch(resumedSse, /"type":"error"/u)
    assert.equal(resumedSse.match(/"type":"tool_done"/gu)?.length, 1)
    assert.equal(requests.length, 2)
    assert.match(requests[1]!, /己方合成报告状态已完成/u)
    assert.doesNotMatch(requests[1]!, /重启后不同的快照|异主机密标记/u)
    const systemMessages = (body: string) => (JSON.parse(body) as { messages: Array<{ role: string }> })
      .messages.filter(message => message.role === 'system')
    assert.ok(systemMessages(requests[0]!).length > 0)
    assert.deepEqual(systemMessages(requests[1]!), systemMessages(requests[0]!))
    assert.deepEqual((await pool.query(
      'SELECT run_id,status FROM agent_run_checkpoints WHERE user_id=$1 AND session_id=$2', [owner, crashSessionId],
    )).rows, [{ run_id: crashedRun, status: 'completed' }])

    const cancelling = await chat('等待取消的合成输入', crashSessionId)
    assert.equal(cancelling.status, 200)
    assert.ok(cancelling.body)
    const cancelReader = cancelling.body.getReader()
    const cancelDecoder = new TextDecoder()
    let cancellingSse = ''
    try {
      while (!cancellingSse.includes('取消前的合成片段')) {
        const chunk = await cancelReader.read()
        if (chunk.done) assert.fail(cancellingSse)
        cancellingSse += cancelDecoder.decode(chunk.value, { stream: true })
      }
      const cancel = (headers: Record<string, string>) => fetch(base + `/api/v1/agent/sessions/${crashSessionId}/cancel`, {
        method: 'POST', headers, signal: AbortSignal.timeout(4000),
      })
      const foreignCancel = await cancel({ authorization: `Bearer ${signedUserToken(secret, foreign)}` })
      assert.equal(foreignCancel.status, 404)
      await foreignCancel.body?.cancel()
      assert.equal(cancelledProviderClosed, false)
      const requested = await cancel(auth)
      assert.equal(requested.status, 200)
      assert.equal((await requested.json() as { outcome: string }).outcome, 'requested')
      for (;;) {
        const chunk = await cancelReader.read()
        if (chunk.done) break
        cancellingSse += cancelDecoder.decode(chunk.value, { stream: true })
      }
      cancellingSse += cancelDecoder.decode()
      assert.match(cancellingSse, /"type":"done","run_id":"[^"]+","cancelled":true/u)
      await waitFor(async () => cancelledProviderClosed, AbortSignal.timeout(4000), () => '取消后模型连接仍然打开')
    } finally {
      await cancelReader.cancel().catch(() => undefined)
    }
    const cancelled = await pool.query<{ run_id: string; status: string }>(
      "SELECT run_id,status FROM agent_run_checkpoints WHERE user_id=$1 AND session_id=$2 AND status='cancelled'", [owner, crashSessionId],
    )
    assert.equal(cancelled.rowCount, 1)
    assert.notEqual(cancelled.rows[0]!.run_id, crashedRun)
    assert.match((await pool.query(
      "SELECT content FROM conversation_messages WHERE session_id=$2 AND role='assistant' AND run_id=$1 AND canonical_batch_id IS NULL",
      [cancelled.rows[0]!.run_id, crashSessionId],
    )).rows[0]?.content ?? '', /取消前的合成片段[\s\S]*本轮已中止/u)
    const next = await chat('取消后继续的合成输入', crashSessionId)
    const nextSse = await next.text()
    assert.equal(next.status, 200, nextSse)
    assert.match(nextSse, /"type":"done","run_id":"[^"]+","cancelled":false/u)
    assert.doesNotMatch(nextSse, /"type":"error"/u)
    const askUserResponse = await chat('需要一个合成选项。', 4)
    const askUserSse = await askUserResponse.text()
    assert.equal(askUserResponse.status, 200, askUserSse)
    assert.match(askUserSse, /"type":"done"/u)
    const interactionLine = askUserSse.split('\n').find(line => line.startsWith('data: ') && line.includes('"type":"interaction_required"'))
    assert.ok(interactionLine, askUserSse)
    const interaction = JSON.parse(interactionLine.slice('data: '.length)) as {
      prompt_id: number; session_id: number; options: Array<{ id: string; token: string }>
    }
    assert.ok(interaction.prompt_id > 0)
    assert.ok(interaction.options.some(option => option.id === 'left' && option.token))
    assert.deepEqual((await pool.query<{ kind: string; status: string }>(
      'SELECT kind,status FROM interaction_prompts WHERE id=$1 AND user_id=$2 AND session_id=$3',
      [interaction.prompt_id, owner, interaction.session_id],
    )).rows, [{ kind: 'choice', status: 'active' }], 'ask_user 必须将已校验选项持久化到 owner 会话')
    assert.deepEqual((await pool.query<{ option_id: string }>(
      'SELECT option_id FROM interaction_actions WHERE prompt_id=$1 ORDER BY option_id', [interaction.prompt_id],
    )).rows.map(row => row.option_id), ['__custom_reply__', 'left', 'right'],
    '选择项和允许的自定义回复都应由独立的 token 摘要动作持久化')
    const resumeRun = await pool.query<{ run_id: string }>(
      'SELECT run_id FROM agent_interaction_bindings WHERE prompt_id=$1 AND user_id=$2 AND session_id=$3',
      [interaction.prompt_id, owner, interaction.session_id],
    )
    assert.equal(resumeRun.rowCount, 1)
    const resumeProviderCalls = requests.length
    const chosen = interaction.options.find(option => option.id === 'left')!
    const resumeResponse = await fetch(base + `/api/v1/agent/interactions/${interaction.prompt_id}/resume`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ token: chosen.token }), signal: AbortSignal.timeout(4000),
    })
    assert.equal(resumeResponse.status, 200)
    assert.deepEqual(await resumeResponse.json(), { ok: true, session_id: interaction.session_id, status: 'selected', option_id: 'left',
      run_id: resumeRun.rows[0]!.run_id })
    await waitFor(async () => {
      const checkpoint = await pool.query<{ status: string }>(
        'SELECT status FROM agent_run_checkpoints WHERE user_id=$1 AND session_id=$2 AND run_id=$3',
        [owner, interaction.session_id, resumeRun.rows[0]!.run_id],
      )
      return checkpoint.rows[0]?.status === 'completed'
        && requests.length > resumeProviderCalls
        && requests.slice(resumeProviderCalls).some(input => input.includes('synthetic-ask-user'))
    }, AbortSignal.timeout(8000), () => '选择 ask_user 选项后，持久 Run 未恢复到 Provider 并完成')
    assert.ok(requests.slice(resumeProviderCalls).some(input => input.includes('左侧选项') || /option_id.{0,100}left/u.test(input)),
      '恢复后的 Provider 请求必须包含已消费选项的持久结果')
    const resumedAssistant = await pool.query<{ content: string }>(
      "SELECT m.content FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id WHERE s.user_id=$1 AND m.session_id=$2 AND m.role='assistant' AND m.run_id=$3 AND m.canonical_batch_id IS NULL ORDER BY m.id DESC LIMIT 1",
      [owner, interaction.session_id, resumeRun.rows[0]!.run_id],
    )
    assert.ok(resumedAssistant.rows[0]?.content.trim(), '恢复后的 Provider 轮必须持久化助手回复')
  } finally {
    resumeAfterReconnect()
    gate?.release(true)
    await stopChild(child, 'SIGKILL')
    await host?.close()
    provider.closeAllConnections()
    await new Promise<void>(resolve => provider.close(() => resolve()))
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
  }
})
