import { expect, it } from 'vitest'
import { projectRecentAttachments } from '../../../src/agent/attachments/recent.js'

it('以共享格式投影草稿和当前会话附件元数据', () => {
  const now = Date.parse('2026-11-21T00:05:00.000Z')
  const result = projectRecentAttachments([
    { attach_id: 'draft-id', name: '合成草稿.png', ext: 'png', kind: 'image', platform: null,
      size: '12', img_width: 640, img_height: 480, duration: null, created_at: '2026-11-21T00:00:00.000Z' },
  ], [
    { attach_id: 'attached-id', name: '合成语音.wav', ext: 'wav', kind: 'voice', platform: 'web',
      size: 24, img_width: null, img_height: null, duration: 3, created_at: '2026-11-20T23:00:00.000Z' },
  ], now)

  expect(result).toEqual([
    { attach_id: 'draft-id', name: '合成草稿.png', ext: 'png', kind: 'image', platform: null,
      size_bytes: 12, img_width: 640, img_height: 480, state: 'draft', staged_about: '约5天前' },
    { attach_id: 'attached-id', name: '合成语音.wav', ext: 'wav', kind: 'voice', platform: 'web',
      size_bytes: 24, img_width: null, img_height: null, state: 'attached', duration: 3 },
  ])
})

it('拒绝无效时间，不伪造草稿新鲜度', () => {
  expect(() => projectRecentAttachments([], [], Number.NaN)).toThrow('附件列表时钟无效')
})
