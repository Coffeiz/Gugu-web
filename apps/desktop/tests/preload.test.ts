import { expect, it, vi } from 'vitest'
const spies = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(async () => ({ ok: true, result: [] })),
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: spies.expose },
  ipcRenderer: { invoke: spies.invoke },
}))
import '../src/preload/index.js'

it('Preload 只暴露固定业务函数，不透传任意 channel 或 Electron 对象', async () => {
  const [name, bridge] = spies.expose.mock.calls[0]!
  expect(name).toBe('guguDesktop')
  expect(Object.keys(bridge).sort()).toEqual([
    'clients',
    'createClient',
    'createProject',
    'projects',
    'receipt',
    'sandboxStatus',
  ])
  await bridge.createProject('合成计划')
  expect(spies.invoke).toHaveBeenCalledWith('gugu:projects:create', '合成计划')
  await bridge.receipt('合成操作 ID')
  expect(spies.invoke).toHaveBeenCalledWith('gugu:operations:get', '合成操作 ID')
  expect(Object.isFrozen(bridge)).toBe(true)
})
