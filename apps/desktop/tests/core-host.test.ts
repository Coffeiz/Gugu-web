import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { LocalRuntime } from '@gugu/core/local'
import { CORE_SCHEMA_VERSION } from '@gugu/core/desktop'
import { pathToFileURL } from 'node:url'
import {
  CoreHost,
  DesktopError,
  verifyArtifact,
  desktopReply,
  desktopHandlers,
} from '../src/main/core-host.js'

const folders: string[] = []
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'gugu-electron-host-'))
  folders.push(path)
  return path
}
afterEach(() => {
  for (const path of folders.splice(0))
    rmSync(path, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
})
function fake(response: string, undoAvailable = true) {
  const root = directory(),
    entry = join(root, 'host.mjs')
  writeFileSync(
    entry,
    `import {createInterface} from 'node:readline'; process.stdout.write(JSON.stringify({v:2,event:'ready',schema:'${CORE_SCHEMA_VERSION}',capabilities:${JSON.stringify(undoAvailable ? ['operation_receipts', 'undo_mind_v1'] : ['operation_receipts'])}})+'\\n'); createInterface({input:process.stdin}).on('line',line=>{ const request=JSON.parse(line); const response=request.method==='operations.get'?{v:2,id:request.id,result:null}:${response}; process.stdout.write(JSON.stringify(response)+'\\n') });`,
  )
  return CoreHost.launch(process.execPath, entry, join(root, 'core.db'))
}
describe('Electron 与独立 Node Core 的真实边界', () => {
  it('拒绝旧 schema 的 Core 握手', async () => {
    const root = directory(), entry = join(root, 'old.mjs')
    writeFileSync(entry, `process.stdout.write(JSON.stringify({v:2,event:'ready',schema:'5',capabilities:['operation_receipts']})+'\\n')`)
    await expect(CoreHost.launch(process.execPath, entry, join(root, 'core.db'))).rejects.toMatchObject({ code: 'startup_failed' })
  })
  it('第二个 Host 拒绝打开同一数据库，原 Host 仍可写入且释放后可重新接管', async () => {
    const root = directory(),
      database = join(root, 'core.db'),
      entry = resolve(
        import.meta.dirname,
        '../../../packages/core/dist/runtime/transport/stdio.js',
      )
    const first = await CoreHost.launch(process.execPath, entry, database)
    let unexpected: CoreHost | undefined
    try {
      await first.request('projects.create', { name: '接管前计划' })
      await expect(
        CoreHost.launch(process.execPath, entry, database).then((host) => {
          unexpected = host
          return host
        }),
      ).rejects.toMatchObject({ code: 'database_in_use' })
      await first.request('clients.create', { name: '拒绝第二实例后仍可写入' })
      expect(await first.request('projects.list')).toMatchObject([{ name: '接管前计划' }])
    } finally {
      await unexpected?.close()
      await first.close()
    }
    const reopened = await CoreHost.launch(process.execPath, entry, database)
    try {
      expect(await reopened.request('projects.list')).toMatchObject([
        { name: '接管前计划' },
      ])
      expect(await reopened.request('clients.list')).toMatchObject([
        { name: '拒绝第二实例后仍可写入' },
      ])
    } finally {
      await reopened.close()
    }
  })
  it('实际提交后丢失回包保留操作 UUID，重启仅查询收据即可恢复且不重复写入', async () => {
    const root = directory(),
      database = join(root, 'core.db'),
      entry = join(root, 'commit-drop.mjs'),
      local = pathToFileURL(
        resolve(import.meta.dirname, '../../../packages/core/dist/runtime/local.js'),
      ).href
    writeFileSync(
      entry,
      `
      import {createInterface} from 'node:readline';
      const {LocalRuntime} = await import(${JSON.stringify(local)});
      const database = process.argv[process.argv.indexOf('--database') + 1];
      const runtime = await LocalRuntime.initialize(database, {exclusive:true});
      process.stdout.write(JSON.stringify({v:2,event:'ready',schema:'${CORE_SCHEMA_VERSION}',capabilities:['operation_receipts']})+'\\n');
      for await (const line of createInterface({input:process.stdin})) {
        const request = JSON.parse(line);
        await runtime.call(request.method, request.params, {operationId:request.operation_id});
        await runtime.close();
        process.exit(23);
      }
    `,
    )
    const host = await CoreHost.launch(process.execPath, entry, database)
    let operation: string | undefined
    try {
      const failure: unknown = await host
        .request('projects.create', { name: '已提交但无回包' })
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DesktopError)
      if (!(failure instanceof DesktopError)) throw new Error('未收到可恢复的桌面错误')
      expect(failure).toMatchObject({
        code: 'unknown_result',
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      })
      operation = failure.operationId
      await expect(
        host.request('projects.create', { name: '不得自动重放' }),
      ).rejects.toMatchObject({ code: 'closed' })
    } finally {
      await host.close()
    }
    const reopened = await CoreHost.launch(
      process.execPath,
      resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js'),
      database,
    )
    try {
      const receipt = await reopened.request<{ method: string; result: { name: string } }>(
        'operations.get',
        { operation_id: operation },
      )
      expect(receipt).toMatchObject({
        method: 'projects.create',
        result: { name: '已提交但无回包', version: 1 },
      })
      expect(await reopened.request('projects.list')).toEqual([
        { id: receipt.result.id, name: receipt.result.name, version: receipt.result.version },
      ])
    } finally {
      await reopened.close()
    }
  })
  it('排队请求固定调用时的参数快照，不受随后对象修改影响', async () => {
    const host = await fake('({v:2,id:request.id,result:request.params})')
    try {
      const params = { name: '原始计划' },
        result = host.request('projects.create', params)
      params.name = '不应替换'
      expect(await result).toEqual({ name: '原始计划' })
    } finally {
      await host.close()
    }
  })
  it('真实数据进程支持并发调用排队、关闭拒绝新增、重启收据和稳定身份', async () => {
    const root = directory(),
      database = join(root, 'core.db'),
      entry = resolve(
        import.meta.dirname,
        '../../../packages/core/dist/runtime/transport/stdio.js',
      )
    const host = await CoreHost.launch(process.execPath, entry, database)
    const [project, contact] = await Promise.all([
      host.request<{ id: number; name: string }>('projects.create', {
        name: '本地计划',
      }),
      host.request<{ name: string }>('clients.create', { name: '小北' }),
    ])
    expect(project.name).toBe('本地计划')
    expect(contact.name).toBe('小北')
    const closes = [host.close(), host.close()]
    await expect(host.request('projects.list')).rejects.toMatchObject({
      code: 'closed',
    })
    await Promise.all(closes)
    const reopened = await CoreHost.launch(process.execPath, entry, database)
    try {
      expect(await reopened.request('projects.list')).toMatchObject([
        { id: project.id, name: '本地计划' },
      ])
    } finally {
      await reopened.close()
    }
  })
  it.each([
    ['({v:2,id:request.id+1,result:{}})', true],
    ['({v:2,id:request.id})', true],
    ["({v:2,id:request.id,result:{},error:{code:'conflict'}})", true],
  ])('未知写入结果保留操作 ID，损坏协议终止 Host %#', async (response, fatal) => {
    const host = await fake(response as string)
    try {
      const error = await host
        .request('projects.create', { name: '合成项目' })
        .catch((error) => error)
      expect(error).toBeInstanceOf(DesktopError)
      expect(error.code).toBe('unknown_result')
      expect(error.operationId).toMatch(/^[0-9a-f-]{36}$/)
      expect(error.message).not.toContain('合成敏感正文')
      if (fatal)
        await expect(
          host.request('operations.get', { operation_id: error.operationId }),
        ).rejects.toMatchObject({ code: 'closed' })
      else
        expect(
          await host.request('operations.get', {
            operation_id: error.operationId,
          }),
        ).toBeNull()
    } finally {
      await host.close()
    }
  })
  it.each([
    ['busy', '本地数据队列已满，请稍后重试'],
    ['cancelled', '操作已取消'],
    ['result_too_large', '返回结果超出桌面协议限制'],
    ['storage_error', '本地数据操作失败，请刷新数据确认状态'],
  ])('Core 明确返回 %s 时保留确定失败语义', async (code, message) => {
    const host = await fake(`({v:2,id:request.id,error:{code:'${code}',message:'合成错误'}})`)
    try {
      await expect(host.request('projects.list')).rejects.toMatchObject({ code, message })
    } finally {
      await host.close()
    }
  })
  it('拒绝通用 Shell、FS 与身份覆盖，合法拒绝后仍能读取', async () => {
    const host = await fake("({v:2,id:request.id,error:{code:'invalid_request'}})")
    try {
      for (const method of ['shell.run', 'fs.read', '__proto__'])
        await expect(host.request(method)).rejects.toMatchObject({
          code: 'invalid_request',
        })
      await expect(
        host.request('projects.create', {
          name: '覆盖身份',
          owner_id: '合成身份',
        }),
      ).rejects.toMatchObject({ code: 'invalid_request' })
      expect(await host.request('operations.get', { operation_id: '合成操作' })).toBeNull()
    } finally {
      await host.close()
    }
  })
  it('制品必须匹配平台、ABI 元数据和全部资源摘要，拒绝越界及额外注入', async () => {
    const root = directory(),
      executable = process.platform === 'win32' ? 'node.exe' : 'node'
    const files: Record<string, string> = {}
    for (const name of [
      executable,
      'host/dist/runtime/transport/stdio.js',
      'host/dist/runtime/worker.js',
    ]) {
      mkdirSync(dirname(join(root, name)), { recursive: true })
      writeFileSync(join(root, name), '合成运行资源')
      files[name] = createHash('sha256')
        .update(readFileSync(join(root, name)))
        .digest('hex')
    }
    const manifest = {
      platform: process.platform,
      arch: process.arch,
      coreVersion: '0.2.0',
      nodeVersion: process.versions.node,
      nodeAbi: process.versions.modules,
      protocol: 2,
      schema: CORE_SCHEMA_VERSION,
      executable,
      entry: 'host/dist/runtime/transport/stdio.js',
      files,
    }
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
    expect((await verifyArtifact(root)).manifest.protocol).toBe(2)
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ ...manifest, schema: 5 }))
    await expect(verifyArtifact(root)).rejects.toMatchObject({ code: 'artifact_invalid' })
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
    writeFileSync(join(root, 'injected.js'), '合成额外模块')
    await expect(verifyArtifact(root)).rejects.toMatchObject({
      code: 'artifact_invalid',
    })
    rmSync(join(root, 'injected.js'))
    writeFileSync(join(root, executable), '合成篡改')
    await expect(verifyArtifact(root)).rejects.toMatchObject({
      code: 'artifact_invalid',
    })
    files['../outside'] = files[executable]!
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
    await expect(verifyArtifact(root)).rejects.toMatchObject({
      code: 'artifact_invalid',
    })
  })
  it('旧 v2 侧车仍可启动但没有撤销能力时拒绝 Undo', async () => {
    const host = await fake('{v:2,id:request.id,result:request}', false)
    try {
      expect(await host.request('projects.list')).toMatchObject({ method: 'projects.list' })
      await expect(host.request('undo.preview', { context_id: 'tab' })).rejects.toMatchObject({ code: 'invalid_request' })
      await expect(host.request('undo.apply', { context_id: 'tab', undo_id: 'op-1' }, randomUUID())).rejects.toMatchObject({ code: 'invalid_request' })
      expect(await host.request('operations.get', { operation_id: randomUUID() })).toBeNull()
    } finally { await host.close() }
  })
  it('具名 Undo IPC 通过真实 Core Worker 持久化撤销、重做与收据', async () => {
    const root = directory(), database = join(root, 'core.db')
    const runtime = await LocalRuntime.initialize(database), owner = runtime.ownerId.replaceAll('-', '')
    await runtime.close()
    const db = new DatabaseSync(database), stamp = '2026-01-01 00:00:00.000000'
    try {
      db.prepare("INSERT INTO mind_nodes (id,user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at) VALUES (1,?,'note','本地','','','user',1,?,?,?)").run(owner, stamp, stamp, stamp)
      const snapshot = { kind: 'note', title: '本地', content_md: '', content_plain: '', color: null, captured_at: stamp, deleted_at: null }
      db.prepare("INSERT INTO undo_operations (id,user_id,undo_context_id,group_id,resource,action,target_refs,before_state,after_state,base_versions,artifact_refs,actor_type,status,created_at) VALUES ('undo-one',?,'tab','group','mind','create','[1]','{}',?,'{}','{}','web','active',?)").run(owner, JSON.stringify({ items: { 'note:1': snapshot } }), stamp)
    } finally { db.close() }
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    const host = await CoreHost.launch(process.execPath, entry, database)
    try {
      const handlers = desktopHandlers(host, async () => null)
      expect(await handlers['gugu:undo:preview']!('tab')).toMatchObject({ available: true })
      const operationId = randomUUID()
      const first = await handlers['gugu:undo:apply']!('tab', 'undo-one', operationId) as { events: unknown[] }
      expect(first.events).toHaveLength(1)
      expect((await handlers['gugu:undo:apply']!('tab', 'undo-one', operationId) as { events: unknown[] }).events).toEqual([])
      expect(await handlers['gugu:operations:get']!(operationId)).toMatchObject({ method: 'undo.apply' })
      expect((await handlers['gugu:undo:redo']!('tab', 'undo-one', randomUUID()) as { events: unknown[] }).events).toHaveLength(1)
    } finally { await host.close() }
  })
  it('Undo 仅允许具名 v2 调用并保留调用方操作标识', async () => {
    const host = await fake('{v:2,id:request.id,result:request}')
    const operationId = 'c60f3fd0-f9bb-4237-8a38-505be6769f42'
    try {
      const preview = await host.request<Record<string, unknown>>('undo.preview', { context_id: 'tab' })
      expect(preview).toMatchObject({ v: 2, method: 'undo.preview', params: { context_id: 'tab' } })
      expect(preview).not.toHaveProperty('operation_id')
      for (const method of ['undo.apply', 'undo.redo']) {
        const result = await host.request<Record<string, unknown>>(method, { context_id: 'tab', undo_id: 'op-1' }, operationId)
        expect(result).toMatchObject({ v: 2, method, operation_id: operationId, params: { context_id: 'tab', undo_id: 'op-1' } })
        await expect(host.request(method, { context_id: 'tab', undo_id: 'op-1' })).rejects.toMatchObject({ code: 'invalid_request' })
        await expect(host.request(method, { context_id: 'tab', undo_id: 'op-1' }, 'invalid')).rejects.toMatchObject({ code: 'invalid_request' })
      }
      await expect(host.request('undo.apply', { context_id: 'tab', undo_id: 'op-1', owner_id: 'foreign' }, operationId)).rejects.toMatchObject({ code: 'invalid_request' })
      await expect(host.request('undo.other', {}, operationId)).rejects.toMatchObject({ code: 'invalid_request' })
    } finally { await host.close() }
  })
  it('Undo 未知结果保留调用方操作标识供收据查询', async () => {
    const host = await fake("{v:2,id:request.id,error:{code:'synthetic_failure'}}")
    const operationId = 'c60f3fd0-f9bb-4237-8a38-505be6769f42'
    try {
      await expect(host.request('undo.apply', { context_id: 'tab', undo_id: 'op-1' }, operationId)).rejects.toMatchObject({ code: 'unknown_result', operationId })
      expect(await host.request('operations.get', { operation_id: operationId })).toBeNull()
    } finally { await host.close() }
  })
  it('Undo 存储错误与通信中断保留收据标识，确定拒绝仍为业务错误', async () => {
    const operationId = 'c60f3fd0-f9bb-4237-8a38-505be6769f42'
    for (const response of ["{v:2,id:request.id,error:{code:'storage_error'}}", '{v:2,id:request.id+1,result:null}']) {
      const host = await fake(response)
      try {
        await expect(host.request('undo.redo', { context_id: 'tab', undo_id: 'op-1' }, operationId))
          .rejects.toMatchObject({ code: 'unknown_result', operationId })
      } finally { await host.close() }
    }
    const host = await fake("{v:2,id:request.id,error:{code:'not_found'}}")
    try {
      await expect(host.request('undo.apply', { context_id: 'tab', undo_id: 'op-1' }, operationId))
        .rejects.toMatchObject({ code: 'not_found', operationId: undefined })
    } finally { await host.close() }
  })
  it('未授权窗口不调用 Core，错误信封不包含原始异常，暴露能力只有固定业务项', async () => {
    let called = false
    expect(
      await desktopReply(false, async () => {
        called = true
      }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(called).toBe(false)
    expect(
      await desktopReply(true, async () => {
        throw new Error('合成私有异常')
      }),
    ).toEqual({
      ok: false,
      error: { code: 'failed', message: '本地操作失败，请检查运行时状态' },
    })
    expect(
      Object.keys(
        desktopHandlers(
          { request: async () => null } as unknown as CoreHost,
          async () => null,
        ),
      ),
    ).toHaveLength(9)
  })
})
