import { describe, expect, it } from 'vitest'
import { buildImDeliveryFields, buildImTargetOptions, IM_DELIVERY_PLATFORMS } from '@/utils/imDelivery'

describe('IM scheduled delivery targets', () => {
  it('offers group selection only for QQ, Feishu, and Telegram', () => {
    expect(IM_DELIVERY_PLATFORMS).toEqual(['qq', 'feishu', 'telegram'])
    expect(buildImTargetOptions(
      [{ chat_id: 'group-1', title: '工作群' }], 'private', '私聊提醒我', id => `不可用群 ${id}`,
    )).toEqual([
      { value: 'private', label: '私聊提醒我' },
      { value: 'group-1', label: '工作群' },
    ])
  })

  it('preserves an existing target on unrelated edits and serializes changed targets', () => {
    const initial = { qq: 'group-qq', feishu: 'private', telegram: 'private' }
    const unchanged = buildImDeliveryFields(true, initial, { ...initial }, ['qq', 'feishu'])
    expect(unchanged).toEqual({})

    const changed = buildImDeliveryFields(true, initial, {
      ...initial, feishu: 'group-feishu', telegram: 'group-telegram',
    }, ['qq', 'feishu', 'telegram'])
    expect(changed).toEqual({
      im_delivery: {
        feishu: { mode: 'group', chat_id: 'group-feishu' },
        telegram: { mode: 'group', chat_id: 'group-telegram' },
      },
    })
  })

  it('does not submit delivery settings for unselected platforms', () => {
    expect(buildImDeliveryFields(false, {}, { qq: 'private', feishu: 'group-1' }, ['qq']))
      .toEqual({ im_delivery: { qq: { mode: 'private' } } })
  })
})
