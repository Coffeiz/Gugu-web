import { describe, expect, it, vi } from 'vitest'
import { createDesktopAddressResolver } from '../../../src/agent/providers/transport/desktop.js'
import { resolvePinnedTarget, type ResolvedAddress } from '../../../src/agent/providers/transport/network.js'

const fake = [{ address: '198.18.0.10', family: 4 }, { address: '2001:2::1', family: 6 }] satisfies ResolvedAddress[]
const normal = [{ address: '93.184.216.34', family: 4 }] satisfies ResolvedAddress[]
const privateAddress = [{ address: '192.168.1.2', family: 4 }] satisfies ResolvedAddress[]
const url = 'https://example.test/'

describe('桌面 DNS', () => {
  it('默认 DNS 返回 Fake IP 时，固定连接目标为本地 DNS 返回的真实地址', async () => {
    const resolve = createDesktopAddressResolver(async () => fake, async () => normal)
    await expect(resolvePinnedTarget(url, { resolve })).resolves.toMatchObject({ target: normal[0] })
  })

  it('正常解析保留系统结果，私网地址可交给允许局域网的宿主处理', async () => {
    const local = vi.fn(async () => normal)
    const resolve = createDesktopAddressResolver(async () => privateAddress, local)
    await expect(resolve('example.test')).resolves.toEqual(privateAddress)
    expect(local).not.toHaveBeenCalled()
  })

  it('拒绝混合 Fake IP 与私网地址的系统结果', async () => {
    const local = vi.fn(async () => normal)
    const resolve = createDesktopAddressResolver(async () => [...fake, ...privateAddress], local)
    await expect(resolve('example.test')).rejects.toMatchObject({ code: 'input_rejected' })
    expect(local).not.toHaveBeenCalled()
  })

  it('本地 DNS 仍返回 Fake IP 时拒绝该结果', async () => {
    const resolve = createDesktopAddressResolver(async () => fake, async () => fake)
    await expect(resolve('example.test')).rejects.toMatchObject({ code: 'network' })
  })

  it('公网访问仍拒绝本地 DNS 返回的私网地址', async () => {
    const resolve = createDesktopAddressResolver(async () => fake, async () => privateAddress)
    await expect(resolvePinnedTarget(url, { resolve })).rejects.toMatchObject({ code: 'input_rejected' })
  })
})
