import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { readTrustedImPrivateStreaming } from '../../../src/modules/im/gateway/reply-settings.js'
import type { NodeImBotBinding } from '../../../src/modules/im/gateway/inbound/inbox.js'

const platforms = ['qq', 'feishu', 'telegram'] as const

test('QQ、飞书和 Telegram 共用私聊流式设置读取与默认值，微信不开放该设置', async () => {
  for (const platform of platforms) {
    const binding: NodeImBotBinding = { ownerId: 'synthetic-owner', botId: 'synthetic-bot', platform }
    const read = async (value: boolean | null) => readTrustedImPrivateStreaming({
      async query(_sql: string, params: unknown[]) {
        assert.deepEqual(params, [binding.ownerId, binding.botId, platform])
        return { rows: [{ private_streaming_enabled: value }] }
      },
    } as unknown as Pick<Pool, 'query'>, binding)

    assert.equal(await read(null), true, `${platform} 缺省开启`)
    assert.equal(await read(false), false, `${platform} 可关闭`)
    assert.equal(await read(true), true, `${platform} 可开启`)
  }

  await assert.rejects(readTrustedImPrivateStreaming({ query: async () => ({ rows: [] }) } as unknown as Pick<Pool, 'query'>, {
    ownerId: 'synthetic-owner', botId: 'synthetic-bot', platform: 'wechat',
  }), /IM 运行回复装配不可用/)
})
