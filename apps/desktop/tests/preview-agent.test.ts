import { createServer, request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import { startDesktopPreviewAgent } from '../src/main/preview-agent.js'

it('同一桌面宿主向受信预览返回模型和会话，拒绝未授权连接', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gugu-'))
  const socketPath = process.platform === 'win32' ? String.raw`\\.\pipe\gugu-${randomUUID()}` : join(folder, 'agent.sock')
  let server: ReturnType<typeof createServer> | undefined
  const secret = 'synthetic-preview-secret'
  let reloads = 0
  let emitRunChange: ((sessionId: number) => void) | undefined
  const stopRunChanges = vi.fn()
  let useSystemProxy = false
  const updateAppearance = vi.fn(async (patch: { useSystemProxy: boolean }) => {
    useSystemProxy = patch.useSystemProxy
    return { useSystemProxy }
  })
  const search = vi.fn(async (_queries: string[]) => ({ total: 1, groups: [{ type: 'project', items: [{ id: 1, title: '合成项目' }] }] }))
  const files = vi.fn(async () => [{ name: '合成.txt' }])
  const content = vi.fn(async (_url: URL, range: string | null) => new Response('片段', { status: range ? 206 : 200 }))
  const attachment = vi.fn(async (command: { action: string }) => command.action === 'download'
    ? { data: new Uint8Array([0, 255]), name: '合成.txt', mime: 'text/plain' }
    : { attach_id: 'synthetic' })
  try {
    server = await startDesktopPreviewAgent(socketPath, secret, {
      [DESKTOP_CHANNELS.projectBoard]: async (collection, offset) => ({ collection, offset, items: [{ id: 'synthetic-project' }] }),
      [DESKTOP_CHANNELS.notes]: async () => [{ id: 'synthetic-note' }],
      [DESKTOP_CHANNELS.canvases]: async () => [{ id: 'synthetic-canvas' }],
      [DESKTOP_CHANNELS.canvasItems]: async canvasId => [{ canvasId, id: 'synthetic-item' }],
      [DESKTOP_CHANNELS.agentAttachment]: attachment,
      [DESKTOP_CHANNELS.files]: files,
      [DESKTOP_CHANNELS.search]: search,
      [DESKTOP_CHANNELS.appearance]: async () => ({ useSystemProxy }),
      [DESKTOP_CHANNELS.updateAppearance]: updateAppearance,
      [DESKTOP_CHANNELS.wechatPairing]: async () => ({ configured: true }),
      [DESKTOP_CHANNELS.agentModel]: async () => ({ items: [{ model: 'synthetic-model' }] }),
      [DESKTOP_CHANNELS.agentSessions]: async () => [{ id: 1, title: '合成会话' }],
    }, () => { reloads += 1 }, listener => { emitRunChange = listener; return stopRunChanges }, undefined,
      { content, handlers: { [DESKTOP_CHANNELS.files]: files } })
    const call = (path: string, method: string, authorization: string, body?: string | Buffer, headers: Record<string, string> = {}, verb = 'POST') => new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const req = request({ socketPath, path, method: verb,
        headers: { 'Content-Type': 'application/json', Authorization: authorization, ...headers } }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end(body ?? JSON.stringify({ method, args: [{ action: 'list' }] }))
    })
    const board = JSON.stringify({ method: 'projectBoard', args: ['archived', 20] })
    const workspaceReads = [
      ['/__desktop-preview/projects', 'projectBoard', board,
        { collection: 'archived', offset: 20, items: [{ id: 'synthetic-project' }] }],
      ['/__desktop-preview/mind', 'notes', undefined, [{ id: 'synthetic-note' }]],
      ['/__desktop-preview/mind', 'canvases', undefined, [{ id: 'synthetic-canvas' }]],
      ['/__desktop-preview/mind', 'canvasItems', JSON.stringify({ method: 'canvasItems', args: ['synthetic-canvas'] }),
        [{ canvasId: 'synthetic-canvas', id: 'synthetic-item' }]],
    ] as const
    for (const [endpoint, method, body, result] of workspaceReads) {
      await expect(call(endpoint, method, 'invalid', body)).resolves.toEqual({ status: 403, body: '' })
      expect(JSON.parse((await call(endpoint, method, secret, body)).body)).toEqual({ ok: true, result })
    }
    expect(JSON.parse((await call('/__desktop-preview/projects', 'notes', secret)).body))
      .toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    const fileList = await call('/__desktop-preview/files', 'files', secret)
    expect(JSON.parse(fileList.body)).toEqual({ ok: true, result: [{ name: '合成.txt' }] })
    const searches = JSON.stringify({ method: 'search', args: [['合成']] })
    await expect(call('/__desktop-preview/files', 'search', 'invalid', searches)).resolves.toEqual({ status: 403, body: '' })
    expect(search).not.toHaveBeenCalled()
    expect(JSON.parse((await call('/__desktop-preview/files', 'search', secret, searches)).body))
      .toEqual({ ok: true, result: { total: 1, groups: [{ type: 'project', items: [{ id: 1, title: '合成项目' }] }] } })
    expect(search).toHaveBeenCalledWith(['合成'])
    const open = JSON.stringify({ method: 'files', args: [{ action: 'open' }] })
    expect(JSON.parse((await call('/__desktop-preview/files', 'files', secret, open)).body))
      .toMatchObject({ ok: false, error: { code: 'unsupported' } })
    expect(files).toHaveBeenCalledTimes(1)
    const filePath = '/__local-files/content?path=synthetic.txt'
    await expect(call(filePath, '', 'invalid', '', { Range: 'bytes=0-3' }, 'GET')).resolves.toEqual({ status: 403, body: '' })
    expect(content).not.toHaveBeenCalled()
    await expect(call(filePath, '', secret, '', { Range: 'bytes=0-3' }, 'GET')).resolves.toEqual({ status: 206, body: '片段' })
    expect(content).toHaveBeenCalledWith(expect.any(URL), 'bytes=0-3')
    await call('/__local-files/upload?path=synthetic.txt', '', secret, Buffer.from('合成'), { 'Content-Type': 'application/octet-stream' })
    expect(files).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'upload', path: 'synthetic.txt', data: Buffer.from('合成') }))
    const preferencesPath = '/__desktop-preview/preferences'
    const update = JSON.stringify({ method: 'updateAppearance', args: [{ useSystemProxy: true }] })
    await expect(call(preferencesPath, 'updateAppearance', 'invalid', update)).resolves.toEqual({ status: 403, body: '' })
    expect(updateAppearance).not.toHaveBeenCalled()
    expect(JSON.parse((await call(preferencesPath, 'updateAppearance', secret, update)).body))
      .toEqual({ ok: true, result: { useSystemProxy: true } })
    expect(JSON.parse((await call(preferencesPath, 'appearance', secret)).body))
      .toEqual({ ok: true, result: { useSystemProxy: true } })
    const watchBody = JSON.stringify({ method: 'agentSessions', args: [{ action: 'watchRuns' }] })
    const watchHeaders = { Accept: 'text/event-stream' }
    await expect(call('/__desktop-preview/agent-sessions', 'agentSessions', 'invalid', watchBody, watchHeaders))
      .resolves.toEqual({ status: 403, body: '' })
    expect(emitRunChange).toBeUndefined()
    await new Promise<void>((resolve, reject) => {
      const req = request({ socketPath, path: '/__desktop-preview/agent-sessions', method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: secret, ...watchHeaders } }, res => {
        expect(res.headers['content-type']).toContain('text/event-stream')
        let received = ''
        let announced = false
        res.setEncoding('utf8')
        res.on('data', chunk => {
          received += chunk
          if (!announced && received.includes('"type":"ready"')) {
            announced = true
            emitRunChange?.(42)
          }
          if (received.includes('"type":"run_changed","session_id":42')) {
            res.destroy()
            resolve()
          }
        })
        res.once('error', reject)
      })
      req.once('error', reject)
      req.end(watchBody)
    })
    await vi.waitFor(() => expect(stopRunChanges).toHaveBeenCalledOnce())
    const models = await call('/__desktop-preview/agent-model', 'agentModel', secret)
    expect(JSON.parse(models.body)).toEqual({ ok: true, result: { items: [{ model: 'synthetic-model' }] } })
    const sessions = await call('/__desktop-preview/agent-sessions', 'agentSessions', secret)
    expect(JSON.parse(sessions.body)).toEqual({ ok: true, result: [{ id: 1, title: '合成会话' }] })
    await expect(call('/__desktop-preview/agent-model', 'agentModel', 'invalid')).resolves.toEqual({ status: 403, body: '' })
    const im = await call('/__desktop-preview/im', 'wechatPairing', secret)
    expect(JSON.parse(im.body)).toEqual({ ok: true, result: { configured: true } })
    await expect(call('/__desktop-preview/im', 'wechatPairing', 'invalid')).resolves.toEqual({ status: 403, body: '' })
    const path = '/__desktop-preview/agent-attachments'
    const binary = Buffer.from([0, 255])
    const headers = { 'Content-Type': 'application/octet-stream',
      'x-gugu-attachment-name': encodeURIComponent('合成.txt'), 'x-gugu-attachment-type': 'text/plain' }
    await expect(call(path, '', 'invalid', binary, headers)).resolves.toEqual({ status: 403, body: '' })
    expect(attachment).not.toHaveBeenCalled()
    const uploaded = await call(path, '', secret, binary, headers)
    expect(JSON.parse(uploaded.body)).toEqual({ ok: true, result: { attach_id: 'synthetic' } })
    expect(attachment).toHaveBeenCalledWith({
      action: 'upload', name: '合成.txt', mime: 'text/plain', voice: false, data: binary,
    })
    const downloaded = await call(path, '', secret, JSON.stringify({ action: 'download', attachId: 'synthetic' }))
    expect(JSON.parse(downloaded.body)).toMatchObject({ ok: true, result: { data: 'AP8=', name: '合成.txt' } })
    await expect(call('/__desktop-preview/reload', '', 'invalid')).resolves.toEqual({ status: 403, body: '' })
    expect(reloads).toBe(0)
    await expect(call('/__desktop-preview/reload', '', secret)).resolves.toEqual({ status: 202, body: '' })
    expect(reloads).toBe(1)
  } finally {
    if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections() })
    await rm(folder, { recursive: true, force: true })
  }
})
