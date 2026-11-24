import assert from 'node:assert/strict'
import test from 'node:test'
import { sendQqImageBatch } from '../dist/runtime/media-delivery.js'
import { QqMediaUploadError } from '../dist/platforms/qq/media-upload.js'

test('多图同时上传，按原顺序发送，上传失败可继续且未知结果不重发', async () => {
  const first = Promise.withResolvers()
  const started = []
  const sent = []
  const platform = { platform: 'qq',
    mediaUpload: { async upload(input) {
      assert.equal(input.partConcurrencyLimit, 5)
      const { fileName } = input
      started.push(fileName)
      if (fileName === '1.png') await first.promise
      if (fileName === '3.png') throw new QqMediaUploadError('prepare', 'FAILED_CONFIRMED')
      return { file_info: fileName }
    } },
    sender: { async media(_recipient, media) {
      sent.push(media.filename)
      return { outcome: media.filename === '2.png' ? 'unknown' : 'accepted' }
    } },
  }
  const inputs = [1, 2, 3, 4].map(index => ({
    platform, scope: { platform: 'qq', chatType: 'group', chatId: 'synthetic', platformUserId: 'owner' },
    file: { name: String(index), ext: 'png', mime: 'image/png' },
    bytes: Uint8Array.of(1), authorize: async () => true,
  }))
  const results = Array.fromAsync(sendQqImageBatch(inputs))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(started, ['1.png', '2.png'])
  assert.deepEqual(sent, [])
  first.resolve()
  assert.deepEqual((await results).map(item => item.outcome), ['accepted', 'unknown', 'rejected', 'accepted'])
  assert.deepEqual(sent, ['1.png', '2.png', '4.png'])
})
