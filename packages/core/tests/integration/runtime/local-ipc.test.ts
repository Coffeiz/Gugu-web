import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProjectRecord } from '../../../src/contracts/index.js'
import { LocalRuntime } from '../../../dist/runtime/local.js'
import SQLite from 'better-sqlite3'
import { desktopFrame } from '../../../src/runtime/commands.js'

const folders: string[] = []
const entry = fileURLToPath(
  new URL('../../../dist/runtime/transport/stdio.js', import.meta.url),
)
function file(): string {
  const root = mkdtempSync(join(tmpdir(), 'gugu-core-ipc-'))
  folders.push(root)
  return join(root, '本地.db')
}
function request(id: number, method: string, params = {}, operation_id?: string): object {
  return {
    v: 2,
    id,
    method,
    params,
    ...(operation_id ? { operation_id } : {}),
  }
}
function exchange(
  database: string,
  requests: object[],
  raw?: Buffer,
): { code: number | null; frames: any[]; error: string } {
  const result = spawnSync(process.execPath, [entry, '--database', database], {
    input: raw ?? requests.map((frame) => JSON.stringify(frame) + '\n').join(''),
    encoding: 'utf8',
    timeout: 20_000,
  })
  return {
    code: result.status,
    frames: result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    error: result.stderr,
  }
}
afterEach(() => {
  for (const root of folders.splice(0))
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
})
describe('独立 Node Host 与 SQLite Worker', () => {
  it('Undo Worker 使用本地身份、事务收据和可恢复的提交后结果', async () => {
    const path = file(), initial = await LocalRuntime.initialize(path), owner = initial.ownerId
    await initial.close()
    const db = new SQLite(path), key = owner.replaceAll('-', ''), stamp = '2026-01-01 00:00:00.000000'
    try {
      db.prepare("INSERT INTO mind_nodes (id,user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at) VALUES (1,?,'note','本地','','','user',1,?,?,?)").run(key, stamp, stamp, stamp)
      const snapshot = { kind: 'note', title: '本地', content_md: '', content_plain: '', color: null, captured_at: stamp, deleted_at: null }
      const insert = db.prepare("INSERT INTO undo_operations (id,user_id,undo_context_id,group_id,resource,action,target_refs,before_state,after_state,base_versions,artifact_refs,actor_type,status,created_at) VALUES (?,?,'tab','group','mind','create','[1]','{}',?,'{}','{}','web','active',?)")
      insert.run('undo-one', key, JSON.stringify({ items: { 'note:1': snapshot } }), stamp)
      insert.run('undo-conflict', key, JSON.stringify({ items: { 'note:1': snapshot } }), stamp)
      insert.run('undo-failure', key, JSON.stringify({ items: { 'note:1': snapshot } }), stamp)
      insert.run('undo-v2', key, JSON.stringify({ items: { 'note:1': snapshot } }), stamp)
    } finally { db.close() }
    const token = randomUUID(), conflictToken = randomUUID()
    const runtime = await LocalRuntime.open(path)
    try {
      expect((await runtime.call<any>('undo.preview', { context_id: 'tab' })).available).toBe(true)
      await expect(runtime.call('undo.apply', { context_id: 'tab', undo_id: 'undo-one', owner_id: randomUUID() }, { operationId: token })).rejects.toMatchObject({ code: 'invalid_request' })
      await expect(runtime.call('undo.apply', { context_id: 'other', undo_id: 'undo-one' }, { operationId: token })).rejects.toMatchObject({ code: 'not_found' })
      const first = await runtime.call<any>('undo.apply', { context_id: 'tab', undo_id: 'undo-one' }, { operationId: token })
      expect(first.events).toHaveLength(1)
      expect((await runtime.call<any>('undo.apply', { context_id: 'tab', undo_id: 'undo-one' }, { operationId: token })).events).toEqual([])
      await expect(runtime.call('undo.apply', { context_id: 'tab', undo_id: 'undo-conflict' }, { operationId: token })).rejects.toMatchObject({ code: 'conflict' })
      await expect(runtime.call('undo.apply', { context_id: 'tab', undo_id: 'undo-conflict' }, { operationId: conflictToken })).rejects.toMatchObject({ code: 'conflict' })
      expect(await runtime.call('operations.get', { operation_id: conflictToken })).toMatchObject({ method: 'undo.apply', result: { error: { code: 'undo.conflict' } } })
      const cancelled = new AbortController(); cancelled.abort()
      await expect(runtime.call('undo.redo', { context_id: 'tab', undo_id: 'undo-one' }, { operationId: randomUUID(), signal: cancelled.signal })).rejects.toMatchObject({ code: 'cancelled' })
    } finally { await runtime.close() }
    const reopened = await LocalRuntime.open(path)
    try {
      expect(await reopened.call('operations.get', { operation_id: token })).toMatchObject({ method: 'undo.apply', result: { result: { events: expect.any(Array) } } })
      expect((await reopened.call<any>('undo.apply', { context_id: 'tab', undo_id: 'undo-one' }, { operationId: token })).events).toEqual([])
      expect((await reopened.call<any>('undo.redo', { context_id: 'tab', undo_id: 'undo-one' }, { operationId: randomUUID() })).events).toHaveLength(1)
      const observer = new SQLite(path), failureToken = randomUUID()
      try {
        observer.exec("CREATE TRIGGER fail_undo_worker BEFORE UPDATE ON undo_operations WHEN NEW.id='undo-failure' BEGIN SELECT RAISE(ABORT, '合成失败'); END")
        await expect(reopened.call('undo.apply', { context_id: 'tab', undo_id: 'undo-failure' }, { operationId: failureToken })).rejects.toMatchObject({ code: 'storage_error' })
        expect(observer.prepare('SELECT deleted_at FROM mind_nodes WHERE id=1').get()).toEqual({ deleted_at: null })
        expect(observer.prepare("SELECT status FROM undo_operations WHERE id='undo-failure'").get()).toEqual({ status: 'active' })
        expect(await reopened.call('operations.get', { operation_id: failureToken })).toBeNull()
      } finally { observer.close() }

    } finally { await reopened.close() }
    const ndjsonToken = randomUUID()
    const frames = exchange(path, [
      request(1, 'undo.preview', { context_id: 'tab' }),
      request(2, 'undo.apply', { context_id: 'other', undo_id: 'undo-one' }, randomUUID()),
      request(3, 'undo.apply', { context_id: 'tab', undo_id: 'undo-one' }),
      request(4, 'undo.preview', { context_id: 'tab', owner_id: randomUUID() }),
      request(5, 'undo.apply', { context_id: 'tab', undo_id: 'undo-v2' }, ndjsonToken),
      request(6, 'undo.apply', { context_id: 'tab', undo_id: 'undo-v2' }, ndjsonToken),
    ])
    expect(frames.code).toBe(0)
    expect(frames.frames[0]).toMatchObject({ v: 2, event: 'ready', capabilities: ['operation_receipts', 'undo_mind_v1'] })
    expect(frames.frames[1]).toMatchObject({ id: 1, result: { available: true } })
    expect(frames.frames[2]).toMatchObject({ id: 2, error: { code: 'not_found' } })
    expect(frames.frames[3]).toMatchObject({ id: 3, error: { code: 'invalid_request' } })
    expect(frames.frames[4]).toMatchObject({ id: 4, error: { code: 'invalid_request' } })
    expect(frames.frames[5].result.events).toHaveLength(1)
    expect(frames.frames[6].result.events).toEqual([])
  })
  it('旧 v1 进程握手与读取格式保持不变', () => {
    const result = spawnSync(process.execPath, [entry, '--database', file(), '--protocol', '1'], {
      input: JSON.stringify({ v: 1, id: 1, method: 'projects.list', params: {} }) + '\n', encoding: 'utf8', timeout: 20_000,
    })
    expect(result.status).toBe(0)
    const frames = result.stdout.trim().split('\n').map(line => JSON.parse(line))
    expect(frames[0]).toEqual({ v: 1, event: 'ready' })
    expect(frames[1]).toEqual({ v: 1, id: 1, result: [] })
  })
  it('旧 v1 帧拒绝 Undo 写命令', async () => {
    const runtime = { schemaVersion: '13', async call() { throw new Error('不得调用') } }
    expect(await desktopFrame({ v: 1, id: 1, method: 'undo.apply', params: { context_id: 'tab', undo_id: 'op' } }, runtime, 1)).toMatchObject({ error: { code: 'invalid_request' } })
  })

  it('直接 Worker 调用同样拒绝非法收据参数、身份覆盖和未知控制能力', async () => {
    const runtime = await LocalRuntime.initialize(file())
    try {
      for (const params of [
        { operation_id: [randomUUID()] },
        { operation_id: randomUUID(), extra: true },
        { operation_id: randomUUID(), owner_id: randomUUID() },
      ]) {
        await expect(runtime.call('operations.get', params)).rejects.toMatchObject({
          code: 'invalid_request',
        })
      }
      await expect(runtime.call('__proto__')).rejects.toMatchObject({
        code: 'invalid_request',
      })
      await expect(runtime.call('runtime.close')).rejects.toMatchObject({
        code: 'invalid_request',
      })
      expect(await runtime.call('projects.list')).toEqual([])
    } finally {
      await runtime.close()
    }
  })
  it('队列已满也能关闭，关闭开始后拒绝新请求，并发关闭等待同一轮释放', async () => {
    const path = file(),
      runtime = await LocalRuntime.initialize(path)
    const pending = Promise.allSettled(
      Array.from({ length: 128 }, () => runtime.call('projects.list')),
    )
    const closing = Promise.allSettled([runtime.close(), runtime.close()])
    try {
      await expect(runtime.call('projects.list')).rejects.toMatchObject({
        code: 'closed',
      })
      expect((await closing).every((result) => result.status === 'fulfilled')).toBe(true)
    } finally {
      await pending
      await closing
    }
    const reopened = await LocalRuntime.open(path)
    try {
      expect(await reopened.call('projects.list')).toEqual([])
    } finally {
      await reopened.close()
    }
  })
  it('进程在提交前崩溃，重启只读回已经提交的数据', async () => {
    const path = file(),
      runtime = await LocalRuntime.initialize(path)
    try {
      await runtime.call('projects.create', { name: '已提交计划' })
    } finally {
      await runtime.close()
    }
    const script = `
      const { openSqliteRuntime } = await import(process.argv[2]);
      const { dataContext } = await import(process.argv[3]);
      const { runtime, ownerId } = await openSqliteRuntime(process.argv[1]);
      await runtime.transaction(dataContext(ownerId), async data => {
        await data.projects.create({ name: '未提交计划' });
        process.exit(13);
      });`
    const crashed = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        script,
        path,
        new URL('../../../dist/data/sqlite.js', import.meta.url).href,
        new URL('../../../dist/contracts/index.js', import.meta.url).href,
      ],
      { encoding: 'utf8', timeout: 20_000 },
    )
    expect(crashed.status).toBe(13)
    const restored = await LocalRuntime.open(path)
    try {
      expect(
        (await restored.call<ProjectRecord[]>('projects.list')).map((row) => row.name),
      ).toEqual(['已提交计划'])
    } finally {
      await restored.close()
    }
  })
  it('真实进程重启读取权威状态，收据重放不重复创建或再次递增版本', () => {
    const path = file(),
      creation = randomUUID(),
      rename = randomUUID()
    const first = exchange(path, [
      request(1, 'projects.create', { name: '桌面计划' }, creation),
    ])
    expect(first.code).toBe(0)
    expect(first.error).toBe('')
    expect(first.frames[0]).toMatchObject({ v: 2, event: 'ready' })
    const second = exchange(path, [
      request(2, 'projects.create', { name: '桌面计划' }, creation),
      request(3, 'projects.rename', { id: 1, version: 1, name: '已更新' }, rename),
      request(4, 'projects.rename', { id: 1, version: 1, name: '已更新' }, rename),
      request(5, 'operations.get', { operation_id: rename }),
      request(6, 'projects.list'),
    ])
    expect(second.code).toBe(0)
    expect(second.frames[1].result).toEqual(first.frames[1].result)
    expect(second.frames[3].result.version).toBe(2)
    expect(second.frames[4].result.result.name).toBe('已更新')
    expect(second.frames[5].result).toHaveLength(1)
    expect(second.frames[5].result[0]).toMatchObject({
      name: '已更新',
      version: 2,
    })
  })
  it('拒绝 Shell、FS、身份覆盖、缺少操作 ID、错误版本和非法 UTF-8/超长帧', () => {
    const path = file(),
      result = exchange(path, [
        request(1, 'shell.run'),
        request(2, 'fs.read'),
        request(
          3,
          'projects.create',
          { name: '覆盖身份', owner_id: randomUUID() },
          randomUUID(),
        ),
        request(4, 'projects.create', { name: '无收据' }),
        { v: 3, id: 5, method: 'projects.list', params: {} },
        request(6, 'projects.list'),
      ])
    expect(result.code).toBe(0)
    expect(
      result.frames.slice(1, 6).every((frame) => frame.error.code === 'invalid_request'),
    ).toBe(true)
    expect(result.frames[6].result).toEqual([])
    expect(exchange(file(), [], Buffer.alloc(65_538, 120)).code).toBe(2)
    expect(exchange(file(), [], Buffer.from([255, 10])).frames[1].error.code).toBe(
      'invalid_request',
    )
  })
  it('管道结果未读取即退出，仍可在新进程按操作 ID 查询已提交收据', async () => {
    const path = file(),
      operationId = randomUUID()
    const child = spawn(process.execPath, [entry, '--database', path], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end(
      JSON.stringify(request(1, 'projects.create', { name: '丢失回包计划' }, operationId)) +
        '\n',
    )
    // 不消费业务结果；进程完成代表提交成功，下一次请求仅查询收据，不重新写入。
    child.stdout.resume()
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
    expect(code).toBe(0)
    const restored = exchange(path, [
      request(2, 'operations.get', { operation_id: operationId }),
      request(3, 'projects.list'),
    ])
    expect(restored.frames[1].result.result.name).toBe('丢失回包计划')
    expect(restored.frames[2].result).toHaveLength(1)
  })
  it('跨域完整命令回滚、并发 CAS 与提前取消均通过真实 Worker', async () => {
    const runtime = await LocalRuntime.initialize(file())
    try {
      await expect(
        runtime.call('projects.createWithClient', {
          project: { name: '半成品' },
          client: { name: '' },
        }),
      ).rejects.toThrow()
      expect(await runtime.call('projects.list')).toEqual([])
      await expect(
        runtime.call('projects.create', { name: () => '不可传输' }),
      ).rejects.toMatchObject({ code: 'invalid_request' })
      const created = await runtime.call<ProjectRecord>(
        'projects.create',
        { name: '初始计划' },
        { operationId: randomUUID() },
      )
      const results = await Promise.allSettled(
        ['计划甲', '计划乙'].map((name) =>
          runtime.call(
            'projects.rename',
            { id: created.id, version: 1, name },
            { operationId: randomUUID() },
          ),
        ),
      )
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const controller = new AbortController()
      controller.abort()
      await expect(
        runtime.call('projects.create', { name: '取消' }, { signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'cancelled' })
    } finally {
      await runtime.close()
    }
    await expect(runtime.call('projects.list')).rejects.toMatchObject({
      code: 'closed',
    })
  })
})
