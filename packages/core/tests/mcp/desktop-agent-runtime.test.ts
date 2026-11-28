import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import { createDesktopMcpAgentRuntime } from '../../src/mcp/desktop-agent-runtime.js'
import { createDesktopMcpCrypto } from '../../src/mcp/desktop-crypto.js'
import { desktopMcp } from '../../src/runtime/desktop-resources.js'

it('Desktop 从本地 MCP 配置发现 owner 工具并调用服务端原名', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-mcp-agent-'))
  const database = join(directory, 'local.db')
  await initializeSqlite(database)
  const { runtime, ownerId } = await openSqliteRuntime(database)
  try {
    const crypto = createDesktopMcpCrypto(database)
    const saved = await desktopMcp(runtime.db, ownerId, crypto).write(undefined, {
      name: 'places', endpoint: 'https://mcp.example.test/server', enabled: true,
      credential_slots: [], credential_values: {}, tool_allowlist: ['lookup'],
    })
    const calls: string[] = []
    let connectAction: (() => Promise<unknown>) | undefined
    const mcp = createDesktopMcpAgentRuntime(runtime.db, ownerId, crypto, {
      transport() {
        return { async request() { throw new Error('测试不能发起网络请求') }, async close() {} } as never
      },
      async builtinNames() { return new Set(['web_search']) },
      client(input) {
        expect(input.endpoint).toBe('https://mcp.example.test/server')
        return {
          async connect() { await connectAction?.() },
          async listTools() { return { tools: [{ name: 'lookup', description: '查找地点', inputSchema: {
            type: 'object', properties: { query: { type: 'string' } }, required: ['query'],
          } }] } },
          async callTool(name, args) {
            calls.push(name)
            expect(args).toEqual({ query: '附近咖啡馆' })
            return { content: [{ type: 'text', text: '找到两家' }] }
          },
          async close() {},
        } as ReturnType<NonNullable<Parameters<typeof createDesktopMcpAgentRuntime>[3]['client']>>
      },
    })
    await expect(mcp.state(ownerId, saved.id)).resolves.toMatchObject({ state: 'unloaded', loaded_tool_count: 0 })
    await expect(mcp.directory(ownerId)).resolves.toMatchObject([
      { name: 'mcp_places_lookup', server_id: saved.id, tool_name: 'lookup' },
    ])
    await expect(mcp.state(ownerId, saved.id)).resolves.toEqual({
      state: 'ok', loaded_tool_count: 1, loaded_tool_names: ['mcp_places_lookup'],
    })
    await expect(desktopMcp(runtime.db, ownerId, crypto).list()).resolves.toMatchObject({
      items: [{ id: saved.id, state: 'ok', loaded_tool_count: 1, loaded_tool_names: ['mcp_places_lookup'] }],
    })
    await expect(mcp.directory('00000000-0000-4000-8000-000000000099')).resolves.toEqual([])
    await expect(mcp.dispatchForAgent(ownerId, saved.id, 'mcp_places_lookup', { query: '附近咖啡馆' }))
      .resolves.toEqual({ result: '找到两家', executed: true })
    connectAction = async () => { throw new Error('合成连接失败') }
    await expect(mcp.dispatchForAgent(ownerId, saved.id, 'mcp_places_lookup', { query: '附近咖啡馆' }))
      .resolves.toMatchObject({ executed: false })
    connectAction = () => desktopMcp(runtime.db, ownerId, crypto).write(saved.id, { enabled: false })
    await expect(mcp.dispatchForAgent(ownerId, saved.id, 'mcp_places_lookup', { query: '附近咖啡馆' }))
      .resolves.toMatchObject({ executed: false })
    expect(calls).toEqual(['lookup'])
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
