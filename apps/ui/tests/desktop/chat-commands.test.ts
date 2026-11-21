import { expect, it, vi } from 'vitest'
import { agentCommandMenu } from '@gugu/core/agent/commands/menu'

const { listCommands } = vi.hoisted(() => ({ listCommands: vi.fn(async () => ({ commands: [] })) }))
vi.mock('@/services/api', () => ({ agentApi: { listCommands } }))

import { agentApi } from '@/services/api'
import { createDesktopChatCommandAccess, listDesktopChatCommands } from '../../src/desktop/shell/chat-command-access'

it('桌面从 Core 目录展示入口已支持的命令', async () => {
  const commands = await listDesktopChatCommands()
  expect(commands.map(item => item.command)).toEqual(['/stop', '/status', '/compact', '/goal', '/new', '/memory', '/forget', '/auto', '/help'])
  for (const item of commands) expect(agentCommandMenu()).toContainEqual(expect.objectContaining({ command: item.command, insert: item.insert }))
  expect(vi.mocked(agentApi.listCommands)).not.toHaveBeenCalled()
})

it('全角命令和别名使用同一帮助，需进入 Agent 的命令继续走发送流程', async () => {
  const automaticMode = { read: vi.fn(async () => true), write: vi.fn(async (enabled: boolean) => enabled) }
  const resolve = createDesktopChatCommandAccess(automaticMode)
  await expect(resolve(' ／ AUTO　On ', null)?.()).resolves.toMatchObject({ automaticModeEnabled: true })
  expect(automaticMode.write).toHaveBeenCalledExactlyOnceWith(true)
  await expect(resolve('／H　／MEM', null)?.()).resolves.toMatchObject({ text: expect.stringContaining('/memory') })
  await expect(resolve('/help compact', null)?.()).resolves.toMatchObject({ text: expect.stringContaining('/compact') })
  expect(resolve('/compact', 42)).toBeUndefined()
  expect(resolve('/personal/notes.txt', null)).toBeUndefined()
  expect(resolve('//auto on', null)).toBeUndefined()
})
