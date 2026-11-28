import { describe, expect, it } from 'vitest'
import { buildImDeliveryFields, buildImTargetOptions, IM_DELIVERY_PLATFORMS } from '@/utils/imDelivery'

describe('IM scheduled delivery targets', () => {
  it('候选列表缺少已选群时保留原群选项', () => {
    expect(buildImTargetOptions([], 'previous-group', '私聊', id => `原群（当前不可验证）：${id}`)).toEqual([
      { value: 'private', label: '私聊' },
      { value: 'previous-group', label: '原群（当前不可验证）：previous-group' },
    ])
  })

  it.each(IM_DELIVERY_PLATFORMS)('%s 编辑时保留未改目标，显式切换才提交', platform => {
    const initial = { [platform]: 'previous-group' }
    expect(buildImDeliveryFields(true, initial, initial, [platform])).toEqual({})
    expect(buildImDeliveryFields(true, initial, initial, [])).toEqual({})
    expect(buildImDeliveryFields(true, initial, { [platform]: 'private' }, [platform]))
      .toEqual({ im_delivery: { [platform]: { mode: 'private' } } })
    expect(buildImDeliveryFields(true, { [platform]: 'private' }, { [platform]: 'new-group' }, [platform]))
      .toEqual({ im_delivery: { [platform]: { mode: 'group', chat_id: 'new-group' } } })
  })

  it.each(IM_DELIVERY_PLATFORMS)('%s 新建时按已选择渠道提交私聊或群目标', platform => {
    expect(buildImDeliveryFields(false, {}, { [platform]: 'private' }, [platform]))
      .toEqual({ im_delivery: { [platform]: { mode: 'private' } } })
    expect(buildImDeliveryFields(false, {}, { [platform]: 'group-1' }, [platform]))
      .toEqual({ im_delivery: { [platform]: { mode: 'group', chat_id: 'group-1' } } })
    expect(buildImDeliveryFields(false, {}, { [platform]: 'group-1' }, [])).toEqual({})
  })

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
