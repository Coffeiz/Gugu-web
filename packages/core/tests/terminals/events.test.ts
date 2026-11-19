import assert from 'node:assert/strict'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { test } from 'vitest'
import { createTerminalEventPageReader } from '../../src/terminals/events.js'
import { createTerminalEventAppender } from '../../src/terminals/append.js'
import { createTerminalCommandService } from '../../src/terminals/command.js'
import { createTerminalShellFactsReader } from '../../src/terminals/shell-facts.js'
import { createTerminalCommandStateReader } from '../../src/terminals/command-state.js'
import { createDefaultWorkspaceShellTargetReader, createWorkspaceShellDirectoryReader, createWorkspaceShellTargetReader } from '../../src/workspaces/shell-target.js'

const owner = '00000000-0000-4000-8000-000000000171'
const other = '00000000-0000-4000-8000-000000000172'

test('远端取消只在活动租约存在时返回成功', async () => {
  let active = true
  const lease = { acquire: async () => 'token', renew: async () => true, release: async () => true, cancel: async () => active }
  const service = createTerminalCommandService({ authorize: async () => {}, lease, nextId: () => 'id', diagnose: () => {}, publish: async () => {},
    append: async () => null, execute: async () => ({ stdout: '', stderr: '', exitCode: 0, ok: true }) })
  assert.deepEqual(await service.cancel(owner, 'mine', 'id'), { cancelled: true, requestId: 'id' })
  active = false
  assert.deepEqual(await service.cancel(owner, 'mine', 'id'), { cancelled: false })
})

test('关闭终端服务中止活动命令并等待取消事件提交', async () => {
  const events: string[] = []
  const service = createTerminalCommandService({
    authorize: async () => {}, nextId: () => 'closing', diagnose: () => {}, publish: async () => {},
    append: async (_owner, _terminal, event) => {
      events.push(event.kind === 'running' ? 'running' : event.stderr)
      return { sequence: events.length, type: event.kind, source: 'user', runId: event.runId, command: event.command, stdout: '', stderr: '', exitCode: null, occurredAt: '' }
    },
    execute: async (_owner, _terminal, _id, _input, signal) => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(new Error())
      else signal.addEventListener('abort', () => reject(new Error()), { once: true })
    }),
  })
  const input = { command: 'pwd', cwd: '.', timeout: 30, maxOutputChars: 100, network: 'none' as const }
  await service.start(owner, 'mine', input)
  await service.close()
  assert.deepEqual(events, ['running', '命令已取消'])
  await assert.rejects(service.start(owner, 'mine', input), { statusCode: 503 })
})

test('关闭与正在授权的启动并发时等待授权结束并拒绝启动', async () => {
  let release!: () => void, appended = false
  const authorization = new Promise<void>(resolve => { release = resolve })
  const service = createTerminalCommandService({ authorize: async () => authorization, nextId: () => 'id', diagnose: () => {}, publish: async () => {},
    append: async () => { appended = true; return null }, execute: async () => ({ stdout: '', stderr: '', exitCode: 0, ok: true }) })
  const start = service.start(owner, 'mine', { command: 'pwd', cwd: '.', timeout: 30, maxOutputChars: 100, network: 'none' })
  const close = service.close()
  release()
  await assert.rejects(start, { statusCode: 503 })
  await close
  assert.equal(appended, false)
})

test('关闭与 running 事件提交并发时记录取消并阻止执行', async () => {
  let release!: () => void, runs = 0
  const blocked = new Promise<void>(resolve => { release = resolve })
  const events: string[] = []
  let entered!: () => void
  const enteredAppend = new Promise<void>(resolve => { entered = resolve })
  const service = createTerminalCommandService({ authorize: async () => {}, nextId: () => 'id', diagnose: () => {}, publish: async () => {},
    append: async (_owner, _terminal, event) => {
      if (event.kind === 'running') { entered(); await blocked; events.push('running') } else events.push(event.stderr)
      return { sequence: events.length, type: event.kind, source: 'user', runId: event.runId, command: event.command, stdout: '', stderr: '', exitCode: null, occurredAt: '' }
    }, execute: async () => { runs++; return { stdout: '', stderr: '', exitCode: 0, ok: true } } })
  const start = service.start(owner, 'mine', { command: 'pwd', cwd: '.', timeout: 30, maxOutputChars: 100, network: 'none' })
  await enteredAppend
  const close = service.close()
  release()
  await start
  await close
  assert.equal(runs, 0)
  assert.deepEqual(events, ['running', '命令已取消'])
})

test('并发启动相同请求标识只允许一次提交', async () => {
  let release!: () => void, entered!: () => void, writes = 0
  const waiting = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const service = createTerminalCommandService({ authorize: async () => {}, nextId: () => 'same', diagnose: () => {}, publish: async () => {},
    append: async (_owner, _terminal, event) => {
      writes++
      if (event.kind === 'running') { entered(); await waiting }
      return { sequence: writes, type: event.kind, source: 'user', runId: event.runId, command: event.command, stdout: '', stderr: '', exitCode: null, occurredAt: '' }
    }, execute: async () => ({ stdout: '', stderr: '', exitCode: 0, ok: true }) })
  const input = { command: 'pwd', cwd: '.', timeout: 30, maxOutputChars: 100, network: 'none' as const }
  const first = service.start(owner, 'mine', input)
  await started
  await assert.rejects(service.start(owner, 'mine', input), /标识冲突/)
  assert.equal(writes, 1)
  release()
  await first
  await service.close()
})

test('通知和诊断失败后命令仍执行并记录终态', async () => {
  const events: string[] = []
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const service = createTerminalCommandService({
    authorize: async () => {}, nextId: () => 'run', diagnose: () => { throw new Error('诊断失败') },
    publish: async () => { throw new Error('通知失败') },
    execute: async () => ({ stdout: 'ok', stderr: '', exitCode: 0, ok: true }),
    append: async (_owner, _terminal, event) => {
      events.push(event.kind)
      if (event.kind === 'result') finish()
      return { sequence: events.length, type: event.kind, source: 'user', runId: event.runId, command: event.command, stdout: '', stderr: '', exitCode: null, occurredAt: '' }
    },
  })
  await service.start(owner, 'mine', { command: 'pwd', cwd: '.', timeout: 30, maxOutputChars: 100, network: 'none' })
  await done
  assert.deepEqual(events, ['running', 'result'])
})

test('执行异常不会写入原始异常，结束后不能再次取消', async () => {
  const results: string[] = []
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const service = createTerminalCommandService({
    authorize: async () => {}, nextId: () => 'failure', diagnose: () => {}, publish: async () => {},
    execute: async () => { throw new Error('敏感异常') },
    append: async (_owner, _terminal, event) => {
      if (event.kind === 'result') { results.push(event.stderr); finish() }
      return { sequence: 1, type: event.kind, source: 'user', runId: event.runId, command: event.command, stdout: '', stderr: '', exitCode: null, occurredAt: '' }
    },
  })
  await service.start(owner, 'mine', { command: 'pwd', cwd: '.', timeout: 30, maxOutputChars: 100, network: 'none' })
  await done
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(results, ['命令执行失败'])
  assert.deepEqual(await service.cancel(owner, 'mine', 'failure'), { cancelled: false })
})

test('工作区目标必须属于 owner，且目录和文件夹不能已删除', async () => {
  const native = new SQLite(':memory:')
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE workspaces(id INTEGER,user_id TEXT,name TEXT,kind TEXT,folder_id INTEGER,project_id INTEGER,directory_id INTEGER,enabled INTEGER);
    CREATE TABLE workspace_directories(id INTEGER,user_id TEXT,directory_name TEXT,deleted_at TEXT,is_default INTEGER,name TEXT);
    CREATE TABLE folders(id INTEGER,user_id TEXT,name TEXT,project_id INTEGER,deleted_at TEXT);
    CREATE TABLE projects(id INTEGER,user_id TEXT,name TEXT);
    INSERT INTO workspaces VALUES(1,'${owner.replaceAll('-', '')}','工作区','directory',NULL,NULL,2,1);
    INSERT INTO workspace_directories VALUES(2,'${owner.replaceAll('-', '')}','safe',NULL,1,'默认'),(3,'${other.replaceAll('-', '')}','other',NULL,0,'其他');`)
  try {
    const read = createWorkspaceShellTargetReader(db, 'sqlite')
    assert.equal((await read(owner, 1))?.space, 'workspace')
    assert.equal((await createDefaultWorkspaceShellTargetReader(db, 'sqlite')(owner))?.workspaceId, 1)
    assert.deepEqual(await createWorkspaceShellDirectoryReader(db, 'sqlite')(owner), [{ id: 2, directoryName: 'safe', isDefault: true }])
    assert.equal(await read(other, 1), null)
    native.exec("UPDATE workspace_directories SET deleted_at='2026-01-01'")
    assert.deepEqual(await createWorkspaceShellDirectoryReader(db, 'sqlite')(owner), [])
    assert.equal(await read(owner, 1), null)
    native.exec("UPDATE workspaces SET kind='folder',folder_id=3; INSERT INTO folders VALUES(3,'foreign','文件夹',NULL,NULL)")
    assert.equal(await read(owner, 1), null)
  } finally { await db.destroy(); native.close() }
})

test('Shell 事实每次读取 owner 会话、工作区、用户开关和授权撤销', async () => {
  const native = new SQLite(':memory:')
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE terminal_sessions(id TEXT,owner_id TEXT,session_id INTEGER,workspace_id INTEGER,closed_at TEXT);
    CREATE TABLE conversation_sessions(id INTEGER,user_id TEXT,workspace_id INTEGER);
    CREATE TABLE workspaces(id INTEGER,user_id TEXT,name TEXT,kind TEXT,folder_id INTEGER,project_id INTEGER,directory_id INTEGER,enabled INTEGER);
    CREATE TABLE workspace_directories(id INTEGER,user_id TEXT,directory_name TEXT,deleted_at TEXT,is_default INTEGER,name TEXT);
    CREATE TABLE user_preferences(user_id TEXT,data_json TEXT);
    CREATE TABLE filesystem_authorization_grants(id INTEGER,user_id TEXT,subject_type TEXT,subject_id TEXT,scope TEXT,permission TEXT,revoked_at TEXT,expires_at TEXT);
    INSERT INTO terminal_sessions VALUES('mine','${owner.replaceAll('-', '')}',1,NULL,NULL);
    INSERT INTO conversation_sessions VALUES(1,'${owner.replaceAll('-', '')}',2);
    INSERT INTO workspaces VALUES(2,'${owner.replaceAll('-', '')}','工作区','directory',NULL,NULL,3,1);
    INSERT INTO workspace_directories VALUES(3,'${owner.replaceAll('-', '')}','default',NULL,0,'默认');
    INSERT INTO filesystem_authorization_grants VALUES(1,'${owner.replaceAll('-', '')}','session','1','user_sandbox','read_write',NULL,NULL);`)
  try {
    const read = createTerminalShellFactsReader(db, 'sqlite')
    assert.equal(await read(other, 'mine', true), null)
    assert.equal((await read(owner, 'mine', false))?.fullUserSandboxWrite, false)
    assert.equal((await read(owner, 'mine', true))?.fullUserSandboxWrite, true)
    native.exec("UPDATE filesystem_authorization_grants SET subject_id='99'")
    assert.equal((await read(owner, 'mine', true))?.fullUserSandboxWrite, false)
    native.exec("UPDATE filesystem_authorization_grants SET subject_id='1'")
    native.exec("UPDATE filesystem_authorization_grants SET expires_at='2000-01-01 00:00:00'")
    assert.equal((await read(owner, 'mine', true))?.fullUserSandboxWrite, false)
    native.exec("UPDATE filesystem_authorization_grants SET expires_at=NULL; UPDATE conversation_sessions SET user_id='foreign'")
    assert.equal((await read(owner, 'mine', true))?.sessionOwned, false)
    assert.equal((await read(owner, 'mine', true))?.fullUserSandboxWrite, false)
    native.prepare('UPDATE conversation_sessions SET user_id=?').run(owner.replaceAll('-', ''))
    native.exec("UPDATE workspace_directories SET deleted_at='2026-01-01'")
    assert.equal((await read(owner, 'mine', true))?.workspaceValid, false)
    native.exec('UPDATE workspace_directories SET deleted_at=NULL')
    native.exec("UPDATE filesystem_authorization_grants SET revoked_at='2026-01-01'; UPDATE workspaces SET enabled=0")
    assert.deepEqual(await read(owner, 'mine', true), { sessionId: 1, sessionOwned: true, workspaceValid: false, workspaceId: 2, workspaceTarget: null, userEnabled: true, userDangerousEnabled: true, fullUserSandboxWrite: false })
  } finally { await db.destroy(); native.close() }
})

test('未绑定 Workspace 时 Shell 快照跟踪 owner 的默认目录目标', async () => {
  const native = new SQLite(':memory:')
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE terminal_sessions(id TEXT,owner_id TEXT,session_id INTEGER,workspace_id INTEGER,closed_at TEXT);
    CREATE TABLE conversation_sessions(id INTEGER,user_id TEXT,workspace_id INTEGER);
    CREATE TABLE workspaces(id INTEGER,user_id TEXT,name TEXT,kind TEXT,folder_id INTEGER,project_id INTEGER,directory_id INTEGER,enabled INTEGER);
    CREATE TABLE workspace_directories(id INTEGER,user_id TEXT,directory_name TEXT,deleted_at TEXT,is_default INTEGER,name TEXT);
    CREATE TABLE user_preferences(user_id TEXT,data_json TEXT);
    INSERT INTO terminal_sessions VALUES('mine','${owner.replaceAll('-', '')}',1,NULL,NULL);
    INSERT INTO conversation_sessions VALUES(1,'${owner.replaceAll('-', '')}',NULL);
    INSERT INTO workspaces VALUES(2,'${owner.replaceAll('-', '')}','默认工作区','directory',NULL,NULL,3,1);
    INSERT INTO workspace_directories VALUES(3,'${owner.replaceAll('-', '')}','个人目录',NULL,1,'默认目录');
    INSERT INTO user_preferences VALUES('${owner.replaceAll('-', '')}','{}');`)
  try {
    const read = createTerminalShellFactsReader(db, 'sqlite')
    assert.deepEqual((await read(owner, 'mine', false))?.workspaceTarget, {
      workspaceId: 2, workspaceName: '默认工作区', kind: 'directory', space: 'workspace', directoryId: 3, directoryName: '个人目录',
    })
    native.exec("UPDATE workspace_directories SET directory_name='新默认目录' WHERE id=3")
    assert.deepEqual((await read(owner, 'mine', false))?.workspaceTarget, {
      workspaceId: 2, workspaceName: '默认工作区', kind: 'directory', space: 'workspace', directoryId: 3, directoryName: '新默认目录',
    })
    assert.equal((await read(other, 'mine', false)), null)
  } finally { await db.destroy(); native.close() }
})

test('命令先持久化运行状态，取消仅作用于匹配的 owner 和终端，并持久化取消结果', async () => {
  const events: string[] = []
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const service = createTerminalCommandService({
    authorize: async () => {}, nextId: () => 'request', diagnose: () => { throw new Error('unexpected') },
    append: async (_owner, _terminal, event) => {
      events.push(event.kind === 'running' ? 'running' : event.stderr)
      if (event.kind === 'result') finish()
      return { sequence: events.length, type: event.kind, source: 'user', runId: event.runId, command: event.command, stdout: '', stderr: '', exitCode: null, occurredAt: '' }
    },
    publish: async () => {},
    execute: async (_owner, _terminal, _id, _input, signal) => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(new Error())
      else signal.addEventListener('abort', () => reject(new Error()), { once: true })
    }),
  })
  const input = { command: 'pwd', cwd: '.', timeout: 10, maxOutputChars: 100, network: 'none' as const }
  await service.start(owner, 'mine', input)
  assert.deepEqual(events, ['running'])
  assert.deepEqual(await service.cancel(other, 'mine', 'request'), { cancelled: false })
  assert.deepEqual(await service.cancel(owner, 'mine', 'request'), { cancelled: true, requestId: 'request' })
  await done
  assert.deepEqual(events, ['running', '命令已取消'])
})

test('终端事件页按 owner/cursor 排序并返回关闭状态和 Python 事件 DTO', async () => {
  const native = new SQLite(':memory:')
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE terminal_sessions(id TEXT PRIMARY KEY,owner_id TEXT,session_id INTEGER,last_sequence INTEGER,closed_at TEXT);
    CREATE TABLE terminal_events(terminal_id TEXT,sequence INTEGER,event_type TEXT,source TEXT,run_id TEXT,command TEXT,stdout TEXT,stderr TEXT,exit_code INTEGER,occurred_at TEXT);
    INSERT INTO terminal_sessions VALUES('mine','${owner.replaceAll('-', '')}',NULL,2,NULL),('foreign','${other.replaceAll('-', '')}',NULL,1,NULL);
    INSERT INTO terminal_events VALUES('mine',1,'command','agent','run-1','echo 1','一','',0,'2026-11-17T00:00:00.000Z'),('mine',2,'command','agent','run-1','echo 2','二','',0,'2026-11-17T00:00:01.000Z');`)
  try {
    const read = createTerminalEventPageReader(db, 'sqlite')
    assert.deepEqual(await read(owner, 'mine', 1), {
      events: [{ sequence: 2, type: 'command', source: 'agent', runId: 'run-1', command: 'echo 2', stdout: '二', stderr: '', exitCode: 0, occurredAt: '2026-11-17T00:00:01.000Z' }],
      closed: false, lastSequence: 2,
    })
    assert.equal(await read(other, 'mine', 0), null)
    native.prepare('UPDATE terminal_sessions SET closed_at=?,owner_id=? WHERE id=?').run('2026-11-17T00:00:02.000Z', owner.replaceAll('-', ''), 'mine')
    assert.deepEqual(await read(owner, 'mine', 2), { events: [], closed: true, lastSequence: 2 })
  } finally { await db.destroy(); native.close() }
})

test('终端命令事件事务分配序号、隔离 owner 并转义 NUL', async () => {
  const native = new SQLite(':memory:')
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE terminal_sessions(id TEXT PRIMARY KEY,owner_id TEXT,last_sequence INTEGER,output_chars INTEGER,status TEXT,updated_at TEXT,closed_at TEXT);
    CREATE TABLE terminal_events(id INTEGER PRIMARY KEY,terminal_id TEXT,sequence INTEGER,event_type TEXT,source TEXT,run_id TEXT,command TEXT,stdout TEXT,stderr TEXT,exit_code INTEGER,occurred_at TEXT,UNIQUE(terminal_id,sequence));
    INSERT INTO terminal_sessions VALUES('mine','${owner.replaceAll('-', '')}',0,0,'idle','',NULL)`)
  try {
    const append = createTerminalEventAppender(db, 'sqlite')
    assert.equal(await append(other, 'mine', { kind: 'running', command: 'pwd', runId: 'r' }), null)
    assert.equal((await append(owner, 'mine', { kind: 'running', command: 'pwd', runId: 'r' }))?.sequence, 1)
    const state = createTerminalCommandStateReader(db, 'sqlite')
    assert.equal(await state(owner, 'mine', 'r'), 'running')
    assert.equal(await state(other, 'mine', 'r'), null)
    const result = await append(owner, 'mine', { kind: 'result', command: 'pwd', runId: 'r', stdout: 'a\0b', stderr: '', exitCode: 0, ok: true })
    assert.equal(result?.sequence, 2)
    assert.equal(result?.stdout, 'a\\0b')
    assert.equal(await state(owner, 'mine', 'r'), 'finished')
    assert.deepEqual(native.prepare('SELECT last_sequence,output_chars,status FROM terminal_sessions').get(), { last_sequence: 2, output_chars: 4, status: 'idle' })
    native.exec("CREATE TRIGGER reject_event BEFORE INSERT ON terminal_events BEGIN SELECT RAISE(ABORT, 'rejected'); END")
    await assert.rejects(append(owner, 'mine', { kind: 'running', command: 'pwd', runId: 'r2' }))
    assert.deepEqual(native.prepare('SELECT last_sequence,output_chars,status FROM terminal_sessions').get(), { last_sequence: 2, output_chars: 4, status: 'idle' })
  } finally { await db.destroy(); native.close() }
})

test('终端输出超过保留上限时删除旧事件并保留最新事件和单调序号', async () => {
  const native = new SQLite(':memory:')
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: native }) })
  native.exec(`CREATE TABLE terminal_sessions(id TEXT PRIMARY KEY,owner_id TEXT,last_sequence INTEGER,output_chars INTEGER,status TEXT,updated_at TEXT,closed_at TEXT);
    CREATE TABLE terminal_events(id INTEGER PRIMARY KEY,terminal_id TEXT,sequence INTEGER,event_type TEXT,source TEXT,run_id TEXT,command TEXT,stdout TEXT,stderr TEXT,exit_code INTEGER,occurred_at TEXT,UNIQUE(terminal_id,sequence));
    INSERT INTO terminal_sessions VALUES('mine','${owner.replaceAll('-', '')}',0,0,'idle','',NULL)`)
  try {
    const append = createTerminalEventAppender(db, 'sqlite')
    await append(owner, 'mine', { kind: 'result', command: 'one', runId: '1', stdout: 'a'.repeat(300000), stderr: '', exitCode: 0, ok: true })
    await append(owner, 'mine', { kind: 'result', command: 'two', runId: '2', stdout: 'b'.repeat(300000), stderr: '', exitCode: 0, ok: true })
    assert.deepEqual(native.prepare('SELECT sequence FROM terminal_events').all(), [{ sequence: 2 }])
    assert.deepEqual(native.prepare('SELECT last_sequence,output_chars FROM terminal_sessions').get(), { last_sequence: 2, output_chars: 300000 })
  } finally { await db.destroy(); native.close() }
})
