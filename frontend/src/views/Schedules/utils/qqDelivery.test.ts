// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildQqDeliveryFields, buildQqTargetOptions } from './qqDelivery'

describe('qqDelivery', () => {
  it('候选列表缺少已选群时保留原群选项', () => {
    expect(buildQqTargetOptions([], 'legacy-group', '私聊', id => `原群（当前不可验证）：${id}`)).toEqual([
      { value: 'private', label: '私聊' },
      { value: 'legacy-group', label: '原群（当前不可验证）：legacy-group' },
    ])
  })

  it('编辑任务未更改目标时省略 qq_delivery，包括渠道变更', () => {
    expect(buildQqDeliveryFields(true, 'legacy-group', 'legacy-group', true)).toEqual({})
    expect(buildQqDeliveryFields(true, 'legacy-group', 'legacy-group', false)).toEqual({})
  })

  it('编辑任务显式切换目标时提交新目标', () => {
    expect(buildQqDeliveryFields(true, 'legacy-group', 'private', true)).toEqual({
      qq_delivery: { mode: 'private' },
    })
    expect(buildQqDeliveryFields(true, 'private', 'new-group', true)).toEqual({
      qq_delivery: { mode: 'group', chat_id: 'new-group' },
    })
  })

  it('新建任务按当前 QQ 渠道与选择提交目标', () => {
    expect(buildQqDeliveryFields(false, 'private', 'private', true)).toEqual({
      qq_delivery: { mode: 'private' },
    })
    expect(buildQqDeliveryFields(false, 'private', 'group-1', true)).toEqual({
      qq_delivery: { mode: 'group', chat_id: 'group-1' },
    })
    expect(buildQqDeliveryFields(false, 'private', 'private', false)).toEqual({})
  })
})
