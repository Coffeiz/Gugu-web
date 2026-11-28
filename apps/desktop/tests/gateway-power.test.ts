import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { createGatewayPowerPolicy } from '../src/main/im/gateway-power.js'

const power = vi.hoisted(() => ({
  onBattery: vi.fn(() => false),
  start: vi.fn(() => 1),
  stop: vi.fn(),
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    powerMonitor: Object.assign(new EventEmitter(), { isOnBatteryPower: power.onBattery }),
    powerSaveBlocker: { start: power.start, stop: power.stop },
  }
})

afterEach(() => {
  vi.clearAllMocks()
})

it('只在插电且有启用的网关时禁止空闲睡眠，拔电或退出时释放', async () => {
  const { powerMonitor } = await import('electron')
  const monitor = powerMonitor as unknown as EventEmitter
  let enabled = false
  power.onBattery.mockReturnValue(false)
  const policy = createGatewayPowerPolicy(() => enabled)
  try {
    policy.update()
    expect(power.start).not.toHaveBeenCalled()
    enabled = true
    policy.update()
    policy.update()
    expect(power.start).toHaveBeenCalledExactlyOnceWith('prevent-app-suspension')

    power.onBattery.mockReturnValue(true)
    monitor.emit('on-battery')
    policy.update()
    expect(power.stop).toHaveBeenCalledExactlyOnceWith(1)
    expect(power.start).toHaveBeenCalledTimes(1)

    power.onBattery.mockReturnValue(false)
    monitor.emit('on-ac')
    expect(power.start).toHaveBeenCalledTimes(2)
  } finally {
    policy.close()
  }
  expect(power.stop).toHaveBeenCalledTimes(2)
  monitor.emit('on-ac')
  expect(power.start).toHaveBeenCalledTimes(2)
})

it('插电期间关闭保活或停用最后一个网关会立即释放睡眠保护', () => {
  let shouldStayAwake = true
  power.onBattery.mockReturnValue(false)
  const policy = createGatewayPowerPolicy(() => shouldStayAwake)
  try {
    policy.update()
    shouldStayAwake = false
    policy.update()
    expect(power.stop).toHaveBeenCalledExactlyOnceWith(1)
  } finally {
    policy.close()
  }
})
