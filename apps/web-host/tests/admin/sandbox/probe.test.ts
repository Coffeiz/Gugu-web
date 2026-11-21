import assert from 'node:assert/strict'
import test from 'node:test'
import { createSafeEgressProbe, SafeEgressProbeError } from '../../../../../packages/core/src/preferences/safe-egress-probe.js'

test('安全出站试测使用固定目标并保留 DNS、安全错误和 HTTP 状态', async () => {
  const seen: string[] = []
  const make = (status: number) => createSafeEgressProbe({
    async queryDns(host, type) { seen.push(`${host}:${type}`); return [{ type: 1, data: '192.0.0.9' }] },
    isAddress: () => true,
    isPublicAddress: () => true,
    async requestTarget(target, ip) { seen.push(`${target}:${ip}`); return status },
    now: (() => { let n = 0; return () => n++ })(),
  })
  assert.deepEqual(await make(204)(), { ok: true, stage: 'connected', message: '代理、DNS、IP 钉扎和 TLS 验证均已通过', status_code: 204, elapsed_ms: 1 })
  assert.ok(seen.some(value => value.startsWith('https://ja.wikipedia.org/wiki/Muque:')))
  assert.equal((await make(503)()).stage, 'upstream_http_error')
  const refused = createSafeEgressProbe({ async queryDns() { return [{ type: 1, data: '127.0.0.1' }] }, isAddress: () => true, isPublicAddress: () => false, async requestTarget() { throw new Error('不能请求') }, now: () => 0 })
  assert.deepEqual(await refused(), { ok: false, stage: 'non_public_destination', message: '域名解析包含非公网地址，已拒绝请求', elapsed_ms: 0 })
  const failed = createSafeEgressProbe({ async queryDns() { throw new SafeEgressProbeError('proxy_unavailable', '代理连接失败或代理拒绝建立隧道') }, isAddress: () => true, isPublicAddress: () => true, async requestTarget() { throw new Error('不能请求') }, now: () => 0 })
  assert.equal((await failed()).stage, 'proxy_unavailable')
  const malformed = createSafeEgressProbe({ async queryDns() { return [{ type: 1, data: 'invalid' }] }, isAddress: () => false, isPublicAddress: () => false, async requestTarget() { throw new Error('不能请求') }, now: () => 0 })
  assert.equal((await malformed()).stage, 'resolver_unavailable')
  const loop = createSafeEgressProbe({ async queryDns() { return [{ type: 1, data: '192.0.0.9' }, { type: 5, data: 'ja.wikipedia.org.' }] }, isAddress: () => true, isPublicAddress: () => true, async requestTarget() { throw new Error('不能请求') }, now: () => 0 })
  assert.equal((await loop()).stage, 'resolver_unavailable')
})
