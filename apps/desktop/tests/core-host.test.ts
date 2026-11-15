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
  it('联系人重命名经具名 IPC 写入正式 SQLite 并在重启后保留', async () => {
    const root = directory(), database = join(root, 'core.db')
    const runtime = await LocalRuntime.initialize(database)
    await runtime.close()
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    let host = await CoreHost.launch(process.execPath, entry, database)
    try {
      const handlers = desktopHandlers(host, async () => null)
      const client = await handlers['gugu:clients:create']!('旧联系人') as { id: number }
      expect(await handlers['gugu:clients:rename']!(client.id, '新联系人')).toMatchObject({ id: client.id, name: '新联系人' })
      await expect(handlers['gugu:clients:rename']!(client.id, '  ')).rejects.toMatchObject({ code: 'invalid_request' })
    } finally { await host.close() }
    host = await CoreHost.launch(process.execPath, entry, database)
    try { expect(await desktopHandlers(host, async () => null)['gugu:clients:list']!()).toEqual(expect.arrayContaining([expect.objectContaining({ name: '新联系人' })])) }
    finally { await host.close() }
  })
  it('联系人经具名 IPC 删除后不再出现在 SQLite 列表中，且重启后仍已删除', async () => {
    const root = directory(), database = join(root, 'core.db')
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    let host = await CoreHost.launch(process.execPath, entry, database)
    let client: { id: number }
    try {
      const handlers = desktopHandlers(host, async () => null)
      client = await handlers['gugu:clients:create']!('待删除联系人') as typeof client
      await handlers['gugu:clients:delete']!(client.id)
      expect(await handlers['gugu:clients:list']!()).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: client.id })]))
    } finally { await host.close() }
    host = await CoreHost.launch(process.execPath, entry, database)
    try {
      expect(await desktopHandlers(host, async () => null)['gugu:clients:list']!()).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: client!.id })]))
    } finally { await host.close() }
  })
  it('项目重命名经具名 IPC 写入正式 SQLite 并在重启后保留', async () => {
    const root = directory(), database = join(root, 'core.db')
    const runtime = await LocalRuntime.initialize(database)
    await runtime.close()
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    let host = await CoreHost.launch(process.execPath, entry, database)
    try {
      const handlers = desktopHandlers(host, async () => null)
      const project = await handlers['gugu:projects:create']!('原项目') as { id: number; version: number }
      const updated = await handlers['gugu:projects:rename']!(project.id, project.version, '新项目') as { version: number }
      expect(updated.version).toBe(project.version + 1)
      await expect(handlers['gugu:projects:rename']!(project.id, project.version, '旧版本')).rejects.toMatchObject({ code: 'conflict' })
    } finally { await host.close() }
    host = await CoreHost.launch(process.execPath, entry, database)
    try { expect(await desktopHandlers(host, async () => null)['gugu:projects:list']!()).toEqual(expect.arrayContaining([expect.objectContaining({ name: '新项目', version: 2 })])) }
    finally { await host.close() }
  })
  it('日历经具名 IPC 编辑、软删除、Undo/Redo 并通过正式 SQLite 持久化', async () => {
    const root = directory(), database = join(root, 'core.db')
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    let host = await CoreHost.launch(process.execPath, entry, database)
    let event: { id: number; title: string; date: string; version: number }
    try {
      const handlers = desktopHandlers(host, async () => null)
      event = await handlers['gugu:calendar:create']!('桌面日历回归', '2026-11-16') as typeof event
      expect(event).toMatchObject({ title: '桌面日历回归', date: '2026-11-16', version: 1 })
      event = await handlers['gugu:calendar:update']!(event.id, { version: event.version, title: '更新的桌面日程', date: '2026-11-17' }) as typeof event
      expect(event).toMatchObject({ title: '更新的桌面日程', date: '2026-11-17', version: 2 })
      await expect(handlers['gugu:calendar:update']!(event.id, { version: 1, title: '旧版本' })).rejects.toMatchObject({ code: 'conflict' })
      await handlers['gugu:calendar:delete']!(event.id, event.version)
      expect(await handlers['gugu:calendar:list']!()).toEqual([])
      const preview = await handlers['gugu:undo:preview']!('desktop-calendar') as { undo: { operation_id: string; can_undo: boolean } }
      expect(preview.undo).toMatchObject({ can_undo: true })
    } finally { await host.close() }
    host = await CoreHost.launch(process.execPath, entry, database)
    try {
      const handlers = desktopHandlers(host, async () => null)
      await handlers['gugu:undo:apply']!('desktop-calendar', (await handlers['gugu:undo:preview']!('desktop-calendar') as { undo: { operation_id: string } }).undo.operation_id, randomUUID())
      const events = await handlers['gugu:calendar:list']!() as typeof event[]
      event = events[0]!
      expect(event).toMatchObject({ id: event.id, title: '更新的桌面日程', date: '2026-11-17', version: 4 })
      const preview = await handlers['gugu:undo:preview']!('desktop-calendar') as { redo: { operation_id: string; can_redo: boolean } }
      expect(preview.redo).toMatchObject({ can_redo: true })
      await handlers['gugu:undo:redo']!('desktop-calendar', preview.redo.operation_id, randomUUID())
      expect(await handlers['gugu:calendar:list']!()).toEqual([])
    } finally { await host.close() }
    const databaseView = new DatabaseSync(database)
    try {
      expect(databaseView.prepare("SELECT operation FROM rag_index_jobs WHERE source_type='calendar' AND source_id=?").get(String(event!.id))).toMatchObject({ operation: 'delete' })
    } finally { databaseView.close() }
  })
  it('便签经具名 IPC 创建、版本更新和软删除，均写入正式 SQLite 并在重启后保留', async () => {
    const root = directory(), database = join(root, 'core.db')
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    let host = await CoreHost.launch(process.execPath, entry, database)
    let note: { id: number; contentMd: string; version: number }
    try {
      const handlers = desktopHandlers(host, async () => null)
      note = await handlers['gugu:mind:notes:create']!('# 桌面便签\n\n正文') as typeof note
      expect(note).toMatchObject({ contentMd: '# 桌面便签\n\n正文', version: 1 })
      expect(await handlers['gugu:mind:notes:list']!()).toEqual([note])
      note = await handlers['gugu:mind:notes:update']!(note.id, { version: note.version, contentMd: '# 桌面便签\n\n更新正文' }) as typeof note
      expect(note).toMatchObject({ contentMd: '# 桌面便签\n\n更新正文', version: 2 })
      await expect(handlers['gugu:mind:notes:update']!(note.id, { version: 1, contentMd: '过期版本' })).rejects.toMatchObject({ code: 'conflict' })
    } finally { await host.close() }
    host = await CoreHost.launch(process.execPath, entry, database)
    try {
      const handlers = desktopHandlers(host, async () => null)
      expect(await handlers['gugu:mind:notes:list']!()).toEqual([note!])
      await handlers['gugu:mind:notes:delete']!(note!.id)
      expect(await handlers['gugu:mind:notes:list']!()).toEqual([])
      const preview = await handlers['gugu:undo:preview']!('desktop-mind') as { undo: { operation_id: string; can_undo: boolean } }
      expect(preview.undo).toMatchObject({ can_undo: true })
      await handlers['gugu:undo:apply']!('desktop-mind', preview.undo.operation_id, randomUUID())
      expect(await handlers['gugu:mind:notes:list']!()).toEqual([
        expect.objectContaining({ id: note!.id, contentMd: '# 桌面便签\n\n更新正文', version: 4 }),
      ])
    }
    finally { await host.close() }
  })
  it('画布经具名 IPC 创建、改名、软删除及 Undo/Redo 持久化到正式 SQLite', async () => {
    const root = directory(), database = join(root, 'core.db')
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    let host = await CoreHost.launch(process.execPath, entry, database)
    let canvas: { id: number; title: string }
    try {
      const handlers = desktopHandlers(host, async () => null)
      canvas = await handlers['gugu:mind:canvases:create']!('桌面画布') as typeof canvas
      expect(await handlers['gugu:mind:canvases:list']!()).toEqual([expect.objectContaining({ id: canvas.id, title: '桌面画布' })])
      canvas = await handlers['gugu:mind:canvases:update']!(canvas.id, { title: '更新的桌面画布' }) as typeof canvas
      expect(canvas.title).toBe('更新的桌面画布')
      await handlers['gugu:mind:canvases:delete']!(canvas.id)
      expect(await handlers['gugu:mind:canvases:list']!()).toEqual([])
    } finally { await host.close() }
    host = await CoreHost.launch(process.execPath, entry, database)
    try {
      const handlers = desktopHandlers(host, async () => null)
      const undo = await handlers['gugu:undo:preview']!('desktop-mind') as { undo: { operation_id: string; can_undo: boolean } }
      expect(undo.undo).toMatchObject({ can_undo: true })
      await handlers['gugu:undo:apply']!('desktop-mind', undo.undo.operation_id, randomUUID())
      expect(await handlers['gugu:mind:canvases:list']!()).toEqual([expect.objectContaining({ id: canvas!.id, title: '更新的桌面画布' })])
      const redo = await handlers['gugu:undo:preview']!('desktop-mind') as { redo: { operation_id: string; can_redo: boolean } }
      expect(redo.redo).toMatchObject({ can_redo: true })
      await handlers['gugu:undo:redo']!('desktop-mind', redo.redo.operation_id, randomUUID())
      expect(await handlers['gugu:mind:canvases:list']!()).toEqual([])
    } finally { await host.close() }
    const databaseView = new DatabaseSync(database)
    try {
      expect(databaseView.prepare('SELECT deleted_at FROM mind_maps WHERE id=?').get(canvas!.id)).toMatchObject({ deleted_at: expect.any(String) })
    } finally { databaseView.close() }
  })
  it('画布便签经具名 IPC 创建、编辑、定位、移除并通过 SQLite 与 Undo/Redo 持久化', async () => {
    const root = directory(), database = join(root, 'core.db')
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    let host = await CoreHost.launch(process.execPath, entry, database)
    let canvas: { id: number }
    let item: { id: number; nodeId: number; x: number; y: number; node: { id: number; kind: string; contentMd: string; version: number } }
    try {
      const handlers = desktopHandlers(host, async () => null)
      canvas = await handlers['gugu:mind:canvases:create']!('可编辑画布') as typeof canvas
      item = await handlers['gugu:mind:canvases:notes:create']!(canvas.id, { contentMd: '# 画布便签\n\n初始正文', color: 'amber', x: 12, y: 34 }) as typeof item
      expect(item).toMatchObject({ canvasId: canvas.id, x: 12, y: 34, node: { kind: 'canvas_note', contentMd: '# 画布便签\n\n初始正文', version: 1 } })
      expect(await handlers['gugu:mind:canvases:items:list']!(canvas.id)).toEqual([expect.objectContaining({ id: item.id, nodeId: item.nodeId })])
      await handlers['gugu:mind:canvases:notes:update']!(item.nodeId, { version: 1, contentMd: '# 画布便签\n\n更新正文' })
      await expect(handlers['gugu:mind:canvases:notes:update']!(item.nodeId, { version: 1, contentMd: '过期版本' })).rejects.toMatchObject({ code: 'conflict' })
      item = await handlers['gugu:mind:canvases:items:update']!(canvas.id, item.id, { x: 90, y: 120 }) as typeof item
      expect(item).toMatchObject({ x: 90, y: 120 })
      await handlers['gugu:mind:canvases:items:delete']!(canvas.id, item.id)
      expect(await handlers['gugu:mind:canvases:items:list']!(canvas.id)).toEqual([])
    } finally { await host.close() }
    host = await CoreHost.launch(process.execPath, entry, database)
    try {
      const handlers = desktopHandlers(host, async () => null)
      const undo = await handlers['gugu:undo:preview']!('desktop-mind') as { undo: { operation_id: string; can_undo: boolean } }
      expect(undo.undo.can_undo).toBe(true)
      await handlers['gugu:undo:apply']!('desktop-mind', undo.undo.operation_id, randomUUID())
      expect(await handlers['gugu:mind:canvases:items:list']!(canvas!.id)).toEqual([
        expect.objectContaining({ id: item!.id, x: 90, y: 120, node: expect.objectContaining({ contentMd: '# 画布便签\n\n更新正文', version: 2 }) }),
      ])
      const redo = await handlers['gugu:undo:preview']!('desktop-mind') as { redo: { operation_id: string; can_redo: boolean } }
      expect(redo.redo.can_redo).toBe(true)
      await handlers['gugu:undo:redo']!('desktop-mind', redo.redo.operation_id, randomUUID())
      expect(await handlers['gugu:mind:canvases:items:list']!(canvas!.id)).toEqual([])
    } finally { await host.close() }
  })
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
    ).toHaveLength(29)
  })
})
