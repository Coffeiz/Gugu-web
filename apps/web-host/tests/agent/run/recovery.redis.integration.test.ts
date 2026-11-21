import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import test from 'node:test'
import { createRedisAgentRunRecoveryState } from '../../../src/adapters/cache/redis-events.js'

const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL
async function command(url: string, ...parts: string[]): Promise<string> {
  const address = new URL(url)
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ host: address.hostname, port: Number(address.port || 6379) })
    socket.on('error', reject)
    socket.on('connect', () => socket.write(`*${parts.length}\r\n${parts.map(part => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('')}`))
    socket.on('data', data => { socket.destroy(); resolve(data.toString()) })
  })
}
test('僵尸快照核验后出现新租约或替换快照时不能删除新 run', { skip: !redisUrl && '需要隔离 Redis' }, async () => {
  const id = 100000000 + Math.floor(Math.random() * 100000000)
  const state = `genstream:state:${id}`, owner = `genstream:owner:${id}`, cancel = `genstream:cancel:${id}`
  const stale = '{"done":false,"owner_run_id":"old"}', fresh = '{"done":false,"owner_run_id":"new"}'
  const recovery = createRedisAgentRunRecoveryState(redisUrl!)
  try {
    await command(redisUrl!, 'SET', state, stale)
    const first = await recovery.probe(id)
    assert.equal(first.stale, true)
    await command(redisUrl!, 'SET', owner, 'new')
    assert.equal(await recovery.reapIfStale(id, first.snapshot!), false)
    assert.match(await command(redisUrl!, 'GET', state), /old/)
    await command(redisUrl!, 'DEL', owner)
    await command(redisUrl!, 'SET', state, fresh)
    assert.equal(await recovery.reapIfStale(id, first.snapshot!), false)
    assert.match(await command(redisUrl!, 'GET', state), /new/)
    assert.equal(await recovery.reapIfStale(id, fresh), true)
    assert.match(await command(redisUrl!, 'GET', state), /^\$-1/)
  } finally { await command(redisUrl!, 'DEL', state, owner, cancel) }
})
