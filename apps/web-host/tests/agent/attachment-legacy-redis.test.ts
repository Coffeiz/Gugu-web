import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'
import { createRedisLegacyChatAttachmentCleaner } from '../../src/adapters/cache/redis-events.js'

const owner = '11111111-1111-4111-8111-111111111111'

function parseCommand(buffer: Buffer): string[] | null {
  const text = buffer.toString('utf8')
  const lines = text.split('\r\n')
  if (!lines[0]?.startsWith('*')) return null
  const count = Number(lines[0].slice(1))
  const values: string[] = []
  let cursor = 1
  for (let index = 0; index < count; index += 1) {
    const header = lines[cursor++]
    if (!header?.startsWith('$')) return null
    const length = Number(header.slice(1))
    const value = lines[cursor++]
    if (value === undefined || Buffer.byteLength(value) !== length) return null
    values.push(value)
  }
  return values
}

test('旧 Redis 附件适配限制 owner 前缀并逐项删除已处理键', async () => {
  const commands: string[][] = []
  const server = createServer(socket => {
    let input = Buffer.alloc(0)
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk])
      const command = parseCommand(input)
      if (!command) return
      commands.push(command)
      if (command[0] === 'EVAL') {
        const json = JSON.stringify([
          { id: 'legacy-1', storageKey: `${owner}/.chat_staging/legacy.txt` },
          { id: 'expired', storageKey: null },
        ])
        socket.end(`$${Buffer.byteLength(json)}\r\n${json}\r\n`)
      } else socket.end(':1\r\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    const cleaner = createRedisLegacyChatAttachmentCleaner(`redis://127.0.0.1:${address.port}`)
    assert.deepEqual(await cleaner.list(owner), [
      { id: 'legacy-1', storageKey: `${owner}/.chat_staging/legacy.txt` },
      { id: 'expired', storageKey: null },
    ])
    await cleaner.remove(owner, 'legacy-1')
    assert.equal(commands.length, 2)
    assert.equal(commands[0]?.[0], 'EVAL')
    assert.equal(commands[0]?.[3], `chatfile:${owner}:*`)
    assert.equal(commands[0]?.[4], `chatfile:${owner}:`)
    assert.deepEqual(commands[1], ['DEL', `chatfile:${owner}:legacy-1`])
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
