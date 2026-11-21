import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import { expect, it, vi } from 'vitest'
import { testMcp } from '../src/main/mcp/connection.js'
import { resourceHandlers } from '../src/main/mcp/ipc.js'
import type { IpcHost } from '../src/main/ipc/types.js'

vi.mock('../src/main/mcp/connection.js', () => ({ testMcp: vi.fn() }))

it('刷新列表保留当前配置的测试结果，配置变化后清除旧结果', async () => {
  let digest = 'original'
  const request = vi.fn(async (method: string) => method === 'mcp.config'
    ? { config_digest: digest, endpoint: 'https://example.test/mcp' }
    : { enabled: true, max_servers: null, items: [{ id: 'server', enabled: true, config_digest: digest, state: 'unloaded', loaded_tool_count: 0 }] })
  vi.mocked(testMcp).mockResolvedValue({ ok: true, tool_count: 1, tools: ['lookup'] })
  const handle = resourceHandlers({ request } as unknown as IpcHost)[DESKTOP_CHANNELS.resources]!
  const list = () => handle({ domain: 'mcp', action: 'list' })
  await handle({ domain: 'mcp', action: 'test', id: 'server' })
  await expect(list()).resolves.toEqual({
    enabled: true, max_servers: null,
    items: [{ id: 'server', enabled: true, state: 'ok', loaded_tool_count: 1, loaded_tool_names: ['lookup'] }],
  })
  digest = 'updated'
  await expect(list()).resolves.toMatchObject({ items: [{ state: 'unloaded', loaded_tool_count: 0 }] })
  expect(testMcp).toHaveBeenCalledTimes(1)
})
