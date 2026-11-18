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
import { startServer } from '../../src/main.js'
import { applyAgentBaseMigration, checkAgentBaseMigration } from '../../src/migrations/agent-base-migrate.js'
import { applyAgentRunMigration, checkAgentRunMigration } from '../../src/migrations/agent-run-migrate.js'
import { applyWebDomainMigration } from '../../src/migrations/web-domain-migrate.js'
import { applyRagIndexMigration } from '../../src/migrations/rag-index-migrate.js'
import { createRedisScheduledTaskCommands } from '../../src/adapters/redis-events.js'
import { clearRedisAgentReflectionSession } from '../../src/domains/agent-sessions/persistence/agent-reflection-queue-redis.js'
import { signedUserToken } from '../helpers/auth.js'
import { applyFilesystemAuthorizationMigration, checkFilesystemAuthorizationMigration } from '../../src/migrations/filesystem-authorization-migrate.js'

const pgUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL

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
  skip: !(pgUrl && redisUrl) && '需要隔离 PostgreSQL 和 Redis', timeout: 60_000,
}, async () => {
  const schema = `agent_chat_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: pgUrl })
  const url = new URL(pgUrl!)
  url.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: url.toString() })
  const reflectionCommands = createRedisScheduledTaskCommands(redisUrl!)
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-chat-main-'))
  const requests: string[] = []
  const continueAfterReconnect = Promise.withResolvers<void>()
  let cancelledProviderClosed = false
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const input = Buffer.concat(chunks).toString('utf8')
    requests.push(input)
    const afterCancellation = input.includes('取消后继续的合成输入')
    if (input.includes('等待取消的合成输入') && !afterCancellation) {
      response.once('close', () => { cancelledProviderClosed = true })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '取消前的合成片段' } }] })}\n\n`)
      return
    }
    const needsSearch = !afterCancellation && input.includes('查找我之前的合成报告') && !input.includes('synthetic-history')
    const needsRead = !afterCancellation && !input.includes('强制退出用例')
      && input.includes('synthetic-history') && !input.includes('synthetic-read')
    const needsTime = !afterCancellation && input.includes('读取合成当前时间') && !input.includes('synthetic-time')
    const needsUpcoming = !afterCancellation && input.includes('读取合成最近安排') && !input.includes('synthetic-upcoming')
    const needsListEvents = !afterCancellation && input.includes('列出合成日历事件') && !input.includes('synthetic-list-events')
    const needsListClients = !afterCancellation && input.includes('列出合成联系人') && !input.includes('synthetic-list-clients')
    const needsListProjects = !afterCancellation && input.includes('列出合成项目') && !input.includes('synthetic-list-projects')
    const needsDashboard = !afterCancellation && input.includes('读取合成总览') && !input.includes('synthetic-dashboard')
    const needsListWorkspaces = !afterCancellation && input.includes('列出合成工作区') && !input.includes('synthetic-list-workspaces')
    const needsGetWorkspace = !afterCancellation && input.includes('读取合成工作区详情') && !input.includes('synthetic-get-workspace')
    const needsUpdateWorkspace = !afterCancellation && input.includes('更新合成工作区显示名称') && !input.includes('synthetic-update-workspace')
    const needsListScheduledTasks = !afterCancellation && input.includes('列出合成独立定时任务') && !input.includes('synthetic-list-scheduled-tasks')
    const needsListTrash = !afterCancellation && input.includes('列出合成回收站') && !input.includes('synthetic-list-trash')
    const needsRestoreFile = !afterCancellation && input.includes('恢复合成回收站文件') && !input.includes('synthetic-restore-file')
    const needsRestoreFolder = !afterCancellation && input.includes('恢复合成回收站目录') && !input.includes('synthetic-restore-folder')
    const needsCreateClient = !afterCancellation && input.includes('创建合成联系人') && !input.includes('synthetic-create-client')
    const needsUpdateClient = !afterCancellation && input.includes('更新合成联系人') && !input.includes('synthetic-update-client')
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
    const needsUpdateProject = !afterCancellation && input.includes('修改合成项目') && !input.includes('synthetic-update-project')
    const needsSetProjectColor = !afterCancellation && input.includes('设置合成项目颜色') && !input.includes('synthetic-set-project-color')
    const needsArchiveProject = !afterCancellation && input.includes('归档合成项目') && !input.includes('synthetic-archive-project')
    const needsAddStage = !afterCancellation && input.includes('添加合成阶段') && !input.includes('synthetic-add-stage')
    const needsRenameStage = !afterCancellation && input.includes('重命名合成阶段') && !input.includes('synthetic-rename-stage')
    const needsUpdateStage = !afterCancellation && input.includes('添加合成待办') && !input.includes('synthetic-update-stage')
    const needsSetStages = !afterCancellation && input.includes('重设合成阶段') && !input.includes('synthetic-set-stages')
    const needsRemoveStage = !afterCancellation && input.includes('删除合成阶段') && !input.includes('synthetic-remove-stage')
    if (needsSearch && input.includes('强制退出用例'))
      await pool.query('INSERT INTO synthetic_crash_gate VALUES (5) ON CONFLICT DO NOTHING')
    if (!needsSearch && input.includes('强制退出用例')) await continueAfterReconnect.promise
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
                  name: 'call_tool', arguments: '{"tool_name":"get_tool_schema","arguments":{"tools":["list_events"]}}',
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
        name: 'call_tool', arguments: '{"tool_name":"create_client","arguments":{"client_name":"工具创建联系人","contact":"合成联系人","email":"tool-created@example.test"}}',
      } }] }, finish_reason: 'tool_calls' }
      : needsUpdateClient
        ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-update-client', type: 'function', function: {
          name: 'call_tool', arguments: '{"tool_name":"update_client","arguments":{"client":"工具创建联系人","notes":"已更新合成备注"}}',
        } }] }, finish_reason: 'tool_calls' }
        : needsDashboard
      ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-dashboard', type: 'function', function: {
        name: 'call_tool', arguments: '{"tool_name":"get_dashboard_stats","arguments":{}}',
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
              : needsListTrash
                ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-list-trash', type: 'function', function: {
                  name: 'call_tool', arguments: '{"tool_name":"list_trash","arguments":{}}',
                } }] }, finish_reason: 'tool_calls' }
                : needsRestoreFile
                  ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-restore-file', type: 'function', function: {
                    name: 'call_tool', arguments: JSON.stringify({ tool_name: 'restore_file', arguments: { file_id: restoreFileId } }),
                  } }] }, finish_reason: 'tool_calls' }
                  : needsRestoreFolder
                    ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-restore-folder', type: 'function', function: {
                      name: 'call_tool', arguments: JSON.stringify({ tool_name: 'restore_folder', arguments: { folder_id: restoreFolderId } }),
                    } }] }, finish_reason: 'tool_calls' }
          : needsListClients
      ? { delta: { tool_calls: [{ index: 0, id: 'synthetic-list-clients', type: 'function', function: {
        name: 'call_tool', arguments: '{"tool_name":"list_clients","arguments":{}}',
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
  let ownerId: string | undefined
  let defaultWorkspaceId: number | undefined
  let mutableWorkspaceId: number | undefined
  let restoreFileId: number | undefined
  let restoreFolderId: number | undefined
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
    assert.equal(await checkAgentRunMigration(pool), 'pending')
    assert.equal(await applyAgentRunMigration(pool), 'applied')
    assert.equal(await checkAgentBaseMigration(pool), 'applied')
    const secret = 'synthetic-web-agent-secret'
    const config = join(root, 'config.test.json')
    await writeFile(config, JSON.stringify({ agent: {
      memory_enabled: process.platform === 'linux', web_private_reflection_threshold: 100,
    } }))
    const probe = reservePort().listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const listen = probe.address()
    assert.ok(listen && typeof listen !== 'string')
    await new Promise<void>(resolve => probe.close(() => resolve()))
    const env = {
      GUGU_WEBUI_DATABASE_URL: url.toString(), GUGU_WEBUI_SECRET_KEY: secret, GUGU_WEBUI_REDIS_URL: redisUrl,
      GUGU_WEBUI_HOST: '127.0.0.1', GUGU_WEBUI_PORT: String(listen.port), GUGU_CONFIG_OVERRIDE_FILE: config,
      STORAGE__LOCAL_PATH: join(root, 'storage'), AI__PROVIDER: 'local', AI__API_FORMAT: 'openai',
      AI__MODEL: 'synthetic-agent', AI__BASE_URL: `http://127.0.0.1:${endpoint.port}/v1`,
      AI__API_KEY: 'synthetic-key', AI__CONTEXT_TOKENS: '65536', BYOK__ENABLED: 'false', MCP__ENABLED: 'false', SMTP__ENABLED: 'false',
      ADMIN_USERNAME: 'synthetic-admin', ADMIN_PASSWORD: 'synthetic-password',
    }
    const base = `http://127.0.0.1:${listen.port}`
    host = await startServer(env)
    const readiness = await fetch(base + '/health/ready', { signal: AbortSignal.timeout(4000) })
    assert.equal(readiness.status, 200)
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
    ownerId = owner
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
        onboarding.state->'seed'->>'seeded' AS seeded, ledger.used_bytes,
        (SELECT sum(size_bytes) FROM files WHERE user_id=$1) AS file_bytes,
        (SELECT count(*)::integer FROM calendar_events WHERE user_id=$1) AS events
      FROM onboarding_state onboarding
      JOIN project_file_counts counts ON counts.project_id=(onboarding.state->'seed'->>'project_id')::integer
      JOIN storage_quota_ledgers ledger ON ledger.user_id=onboarding.user_id AND ledger.category='file_library'
      WHERE onboarding.user_id=$1`, [owner])
    assert.equal(seed.rows[0]?.seeded, 'true', '首个账号应完成引导播种')
    assert.equal(seed.rows[0]?.project_files, 2)
    assert.equal(seed.rows[0]?.events, 1)
    assert.equal(seed.rows[0]?.used_bytes, seed.rows[0]?.file_bytes)
    assert.deepEqual((await pool.query(
      'SELECT source_type,status FROM rag_index_jobs WHERE user_id=$1 ORDER BY source_type', [owner],
    )).rows, [{ source_type: 'calendar', status: 'queued' }, { source_type: 'project', status: 'queued' }])
    const firstFile = await pool.query<{ storage_key: string }>(
      "SELECT storage_key FROM files WHERE user_id=$1 AND space='project' ORDER BY id LIMIT 1", [owner])
    assert.match(await readFile(join(root, 'storage', firstFile.rows[0]!.storage_key), 'utf8'), /^# (给未来的自己|第一份记录)\n/u)

    const foreign = randomUUID()
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
    await pool.query(`INSERT INTO files(user_id,display_name,ext,space,storage_key,deleted_at,created_at,updated_at)
      VALUES ($1,'回收站合成文件','txt','personal','trash/synthetic-owner.txt','2026-11-17 10:00:00+00',now(),now()),
        ($2,'异主回收站文件','txt','personal','trash/synthetic-foreign.txt','2026-11-17 11:00:00+00',now(),now())`, [owner, foreign])
    const restoreFolder = await pool.query<{ id: number }>(`INSERT INTO folders(user_id,name,deleted_at)
      VALUES($1,'合成资料目录','2026-11-17 09:00:00+00') RETURNING id`, [owner])
    restoreFolderId = restoreFolder.rows[0]!.id
    await pool.query(`INSERT INTO files(user_id,display_name,ext,space,folder_id,
      storage_key,deleted_at,created_at,updated_at)
      VALUES($1,'合成子文件','txt','personal',$2,$3,'2026-11-17 09:00:00+00',now(),now()) RETURNING id`,
    [owner, restoreFolderId, `${owner}/trash/合成资料目录/合成子文件.txt`])
    const restoreSource = join(root, 'storage', owner, 'trash', '合成资料目录', '合成子文件.txt')
    await mkdir(join(root, 'storage', owner, 'trash', '合成资料目录'), { recursive: true })
    await writeFile(restoreSource, '合成文件恢复正文')
    const standaloneRestoreFile = await pool.query<{ id: number }>(`INSERT INTO files(user_id,display_name,ext,space,
      storage_key,deleted_at,created_at,updated_at)
      VALUES($1,'单文件恢复样本','txt','personal',$2,'2026-11-17 09:30:00+00',now(),now()) RETURNING id`,
    [owner, `${owner}/trash/单文件恢复样本.txt`])
    restoreFileId = standaloneRestoreFile.rows[0]!.id
    await mkdir(join(root, 'storage', owner, 'trash'), { recursive: true })
    await writeFile(join(root, 'storage', owner, 'trash', '单文件恢复样本.txt'), '单文件恢复正文')
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
    const chat = (message: string, sessionId?: number) => fetch(base + '/api/v1/agent/chat', {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ message, locale: 'zh-CN', session_id: sessionId }), signal: AbortSignal.timeout(12_000),
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
    await host.close()
    host = undefined
    assert.equal(await applyRagIndexMigration(pool), 'applied')
    requests.length = 0
    host = await startServer(env)
    await waitFor(async () => (await pool.query(`SELECT DISTINCT source_type FROM knowledge_index_entries
      WHERE owner_user_id=$1 AND source_type IN ('calendar','project') AND deleted_at IS NULL`, [owner])).rowCount === 2,
    AbortSignal.timeout(8000), () => 'Node Worker 未从首个账号的引导数据建立项目与日历索引')
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
    const response = await chat('查找我之前的合成报告。')
    const sse = await response.text()
    assert.equal(response.status, 200, sse)
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/)
    assert.match(sse, /"type":"done"/u)
    assert.match(sse, /"type":"tool_done"/u)
    const toolEvents = sse.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
      .filter(event => event.type === 'display_event' && event.item.toolName === 'search_conversations')
    assert.ok(toolEvents.length >= 2)
    const readEvents = sse.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
      .filter(event => event.type === 'display_event' && event.item.toolName === 'read_conversation')
    assert.ok(readEvents.length >= 2, '历史搜索结果应可继续驱动真实历史正文读取工具')
    const label = toolEvents[0].item.toolLabelOverride
    assert.ok(['查找既有报告', '查找旧会话'].includes(label))
    assert.ok(toolEvents.every(event => event.item.toolLabelOverride === label))
    const history = await host.app.inject({ url: '/api/v1/agent/sessions/4/messages', headers: auth })
    assert.equal(history.statusCode, 200, history.body)
    assert.partialDeepStrictEqual(history.json().session, { filesystemAuthorizationEnabled: true, filesystemAuthorized: false })
    assert.ok(history.json().timelineEvents.some((item: { toolName?: string; toolLabelOverride?: string }) =>
      item.toolName === 'search_conversations' && item.toolLabelOverride === label))
    assert.doesNotMatch(sse, /"type":"error"|异主机密标记/u)
    assert.equal(requests.length, 3, sse)
    const continuation = JSON.parse(requests[1]!) as { messages: Array<{ role: string; content: unknown }> }
    assert.match(JSON.stringify(continuation.messages.filter(row => row.role === 'tool')), /己方合成报告状态已完成/u)
    const readContinuation = JSON.parse(requests[2]!) as { messages: Array<{ role: string; content: unknown }> }
    const historyContent = readContinuation.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(historyContent))
    const historyText = (historyContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof historyText, 'string')
    const historyResult = JSON.parse(historyText as string) as { messages: Array<{ role: string; content: string }> }
    assert.deepEqual(historyResult.messages, [{ role: '你', content: '月球校验：己方合成报告状态已完成。' }])
    assert.ok(requests.every(body => !body.includes('异主机密标记')))
    assert.deepEqual((await pool.query("SELECT status FROM agent_run_checkpoints WHERE user_id=$1 ORDER BY session_id", [owner])).rows,
      [{ status: 'completed' }, { status: 'completed' }])
    assert.deepEqual((await pool.query("SELECT content FROM conversation_messages WHERE session_id=4 AND role='assistant' AND canonical_batch_id IS NULL")).rows,
      [{ content: '已读取合成会话正文。' }])
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
    const clientsResponse = await chat('列出合成联系人。', 4)
    const clientsSse = await clientsResponse.text()
    assert.equal(clientsResponse.status, 200, clientsSse)
    assert.match(clientsSse, /"type":"done"/u)
    const clientsToolEvents = clientsSse.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
      .filter(event => event.type === 'display_event' && event.item.toolName === 'list_clients')
    assert.ok(clientsToolEvents.length >= 2, '联系人列表必须经过生产注册器及 Core owner-scoped client service')
    const clientsRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const clientsContent = clientsRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(clientsContent))
    const clientsText = (clientsContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
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
    const dashboardResponse = await chat('读取合成总览。', 4)
    const dashboardSse = await dashboardResponse.text()
    assert.equal(dashboardResponse.status, 200, dashboardSse)
    assert.match(dashboardSse, /"type":"done"/u)
    assert.ok(dashboardSse.includes('get_dashboard_stats'))
    const dashboardRequest = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const dashboardContent = dashboardRequest.messages.filter(row => row.role === 'tool').at(-1)?.content
    assert.ok(Array.isArray(dashboardContent))
    const dashboardText = (dashboardContent as Array<{ text?: unknown }>).find(block => typeof block.text === 'string')?.text
    assert.equal(typeof dashboardText, 'string')
    const dashboard = JSON.parse(dashboardText as string) as { projects: { total: number }; upcoming_events: number; files: number; clients: number }
    assert.ok(dashboard.projects.total > 0)
    assert.ok(dashboard.upcoming_events >= 1)
    assert.ok(dashboard.files >= 1)
    assert.equal(dashboard.clients, 1, '统计只包含 owner 的联系人')
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
    const trash = JSON.parse(trashText as string) as Array<{ name: string; kind: string; deleted_at: string }>
    assert.deepEqual(trash.map(({ name, kind }) => ({ name, kind })), [
      { name: '回收站合成文件.txt', kind: 'file' }, { name: '单文件恢复样本.txt', kind: 'file' },
      { name: '合成资料目录', kind: 'folder' },
    ])
    assert.match(trash[0]!.deleted_at, /2026-11-17T10:00:00(?:\.000000)?\+00:00/u)
    const restoreFileResponse = await chat('恢复合成回收站文件。', 4)
    const restoreFileSse = await restoreFileResponse.text()
    assert.equal(restoreFileResponse.status, 200, restoreFileSse)
    assert.match(restoreFileSse, /"type":"done"/u)
    assert.ok(restoreFileSse.includes('restore_file'))
    assert.deepEqual((await pool.query<{ deleted_at: Date | null; storage_key: string }>(
      'SELECT deleted_at,storage_key FROM files WHERE id=$1 AND user_id=$2', [restoreFileId, owner],
    )).rows, [{ deleted_at: null, storage_key: `${owner}/个人文件/单文件恢复样本.txt` }])
    assert.equal(await readFile(join(root, 'storage', owner, '个人文件', '单文件恢复样本.txt'), 'utf8'), '单文件恢复正文')
    const restoreFolderResponse = await chat('恢复合成回收站目录。', 4)
    const restoreFolderSse = await restoreFolderResponse.text()
    assert.equal(restoreFolderResponse.status, 200, restoreFolderSse)
    assert.match(restoreFolderSse, /"type":"done"/u)
    assert.ok(restoreFolderSse.includes('restore_folder'))
    assert.deepEqual((await pool.query<{ deleted_at: Date | null; name: string }>(
      'SELECT deleted_at,name FROM folders WHERE id=$1 AND user_id=$2', [restoreFolderId, owner],
    )).rows, [{ deleted_at: null, name: '合成资料目录' }])
    assert.deepEqual((await pool.query<{ deleted_at: Date | null; storage_key: string }>(
      'SELECT deleted_at,storage_key FROM files WHERE folder_id=$1 AND user_id=$2', [restoreFolderId, owner],
    )).rows, [{ deleted_at: null, storage_key: `${owner}/个人文件/合成资料目录/合成子文件.txt` }])
    assert.equal(await readFile(join(root, 'storage', owner, '个人文件', '合成资料目录', '合成子文件.txt'), 'utf8'), '合成文件恢复正文')
    const createClientResponse = await chat('创建合成联系人。', 4)
    const createClientSse = await createClientResponse.text()
    assert.equal(createClientResponse.status, 200, createClientSse)
    assert.match(createClientSse, /"type":"done"/u)
    assert.ok(createClientSse.includes('create_client'))
    const createdClient = await pool.query<{ id: number; user_id: string; contact: string; email: string }>(
      "SELECT id,user_id,contact,email FROM clients WHERE name='工具创建联系人'",
    )
    assert.equal(createdClient.rows.length, 1)
    assert.ok(Number.isSafeInteger(createdClient.rows[0]?.id))
    assert.equal(createdClient.rows[0]?.user_id, owner)
    assert.equal(createdClient.rows[0]?.contact, '合成联系人')
    assert.equal(createdClient.rows[0]?.email, 'tool-created@example.test')
    const updateClientResponse = await chat('更新合成联系人。', 4)
    const updateClientSse = await updateClientResponse.text()
    assert.equal(updateClientResponse.status, 200, updateClientSse)
    assert.match(updateClientSse, /"type":"done"/u)
    assert.ok(updateClientSse.includes('update_client'))
    assert.deepEqual((await pool.query<{ user_id: string; notes: string }>(
      "SELECT user_id,notes FROM clients WHERE name='工具创建联系人'",
    )).rows, [{ user_id: owner, notes: '已更新合成备注' }])
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
    const finalStages = JSON.parse(finalProjectStages.rows[0]!.stages_json) as Array<{ key: string; label: string; todos: Array<{ text: string; done: boolean }> }>
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
    const projectDetail = JSON.parse(projectDetailText as string) as { name: string; files: { total_file_count: number } }
    assert.equal(projectDetail.name, ownerProject.rows[0]!.name)
    assert.ok(projectDetail.files.total_file_count >= 1)
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
    assert.ok(schemaSse.includes('get_tool_schema'))
    const schemaEvents = schemaSse.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
      .filter(event => event.type === 'display_event' && event.item.toolName === 'get_tool_schema')
    assert.ok(schemaEvents.length >= 2, 'Schema discovery 必须经过生产 registry 并实际投影到 Run 事件')
    assert.match(schemaSse, /list_events/u, '实际工具结果应包含当前授权的目标 schema 名称')
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
      const reflectionKey = `agent:reflection:owner:turns:${owner}:4`
      await waitFor(async () => (await reflectionCommands.eval(
        'return redis.call(\'LLEN\',KEYS[1])', 1, reflectionKey,
      )) === '1', AbortSignal.timeout(3000), () => '生产 Web Agent Run 未将成功会话写入 Node 反思队列')
      const reflectionPayload = await reflectionCommands.eval('return redis.call(\'LINDEX\',KEYS[1],0)', 1, reflectionKey)
      assert.ok(reflectionPayload)
      const reflection = JSON.parse(reflectionPayload) as Record<string, unknown>
      assert.equal(typeof reflection.modelIdentity, 'string')
      assert.ok((reflection.modelIdentity as string).length > 0)
      assert.equal(typeof reflection.userMessageId, 'string')
      assert.equal(typeof reflection.runId, 'string')
      assert.equal(typeof reflection.modelScope, 'string')
      assert.equal(reflection.threshold, 100)
      const anchor = await pool.query<{ id: string }>(
        `SELECT m.id FROM conversation_messages m
         JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=$1
         WHERE s.id=4 AND m.role='user' AND m.run_id=$2`, [owner, reflection.runId],
      )
      assert.equal(reflection.userMessageId, anchor.rows[0]?.id, '队列锚点必须指向本 Run 已提交的 owner 消息')
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
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
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
    const interrupted = await chat('强制退出用例，查找我之前的合成报告。')
    assert.equal(interrupted.status, 200)
    assert.ok(interrupted.body)
    const reader = interrupted.body.getReader()
    const decoder = new TextDecoder()
    let initial = ''
    let crashedRun: string
    try {
      while (!initial.includes('"type":"tool_done"')) {
        const piece = await reader.read()
        if (piece.done) assert.fail(initial)
        initial += decoder.decode(piece.value, { stream: true })
      }
      await waitFor(async () => (await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'", [firstApplication],
      )).rowCount === 1, AbortSignal.timeout(5000), () => '第一进程未进入模型续轮的事务锁等待')
      const checkpoint = (await pool.query<{ run_id: string; phase: string }>(
        'SELECT run_id,phase FROM agent_run_checkpoints WHERE user_id=$1 AND session_id=5', [owner],
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
    await pool.query('UPDATE agent_run_leases SET expires_at=now() WHERE user_id=$1 AND session_id=5 AND run_id=$2', [owner, crashedRun])
    await pool.query('UPDATE agent_run_dispatch SET lease_expires_at=now() WHERE user_id=$1 AND session_id=5 AND run_id=$2', [owner, crashedRun])
    await pool.query(`UPDATE conversation_sessions
      SET session_context=jsonb_set(session_context,'{snapshot_context}','"重启后不同的快照"') WHERE id=5 AND user_id=$1`, [owner])
    await startChild(`${schema}_second`)
    const resumed = await fetch(base + '/api/v1/agent/sessions/5/stream', { headers: auth, signal: AbortSignal.timeout(12_000) })
    continueAfterReconnect.resolve()
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
      'SELECT run_id,status FROM agent_run_checkpoints WHERE user_id=$1 AND session_id=5', [owner],
    )).rows, [{ run_id: crashedRun, status: 'completed' }])

    const cancelling = await chat('等待取消的合成输入', 5)
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
      const cancel = (headers: Record<string, string>) => fetch(base + '/api/v1/agent/sessions/5/cancel', {
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
      "SELECT run_id,status FROM agent_run_checkpoints WHERE user_id=$1 AND session_id=5 AND status='cancelled'", [owner],
    )
    assert.equal(cancelled.rowCount, 1)
    assert.notEqual(cancelled.rows[0]!.run_id, crashedRun)
    assert.match((await pool.query(
      "SELECT content FROM conversation_messages WHERE session_id=5 AND role='assistant' AND run_id=$1 AND canonical_batch_id IS NULL",
      [cancelled.rows[0]!.run_id],
    )).rows[0]?.content ?? '', /取消前的合成片段[\s\S]*本轮已中止/u)
    const next = await chat('取消后继续的合成输入', 5)
    const nextSse = await next.text()
    assert.equal(next.status, 200, nextSse)
    assert.match(nextSse, /"type":"done","run_id":"[^"]+","cancelled":false/u)
    assert.doesNotMatch(nextSse, /"type":"error"/u)
  } finally {
    continueAfterReconnect.resolve()
    gate?.release(true)
    await stopChild(child, 'SIGKILL')
    await host?.close()
    if (ownerId) {
      const sessions = await pool.query<{ id: number }>('SELECT id FROM conversation_sessions WHERE user_id=$1', [ownerId])
      for (const session of sessions.rows)
        await clearRedisAgentReflectionSession(reflectionCommands, ownerId, String(session.id))
    }
    provider.closeAllConnections()
    await new Promise<void>(resolve => provider.close(() => resolve()))
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
  }
})
