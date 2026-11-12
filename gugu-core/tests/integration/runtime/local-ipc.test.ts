import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProjectRecord } from '../../../src/contracts/index.js'
import { LocalRuntime } from '../../../dist/runtime/local.js'

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
