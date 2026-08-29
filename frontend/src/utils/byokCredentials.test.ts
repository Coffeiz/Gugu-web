import { describe, expect, it } from 'vitest'
import { pickByokCredential } from './byokCredentials'

describe('pickByokCredential', () => {
  it('优先选择已启用凭据，避免更新停用旧记录后运行时回退服务器配置', () => {
    const rows = [
      { id: 11, capability: 'similar_image_search', provider: 'qianfan', enabled: false },
      { id: 12, capability: 'similar_image_search', provider: 'qianfan', enabled: true },
    ]

    expect(pickByokCredential(rows, 'similar_image_search')?.id).toBe(12)
  })

  it('没有启用项时仍返回历史记录，供专项面板更新并重新启用', () => {
    const rows = [{ id: 11, capability: 'similar_image_search', enabled: false }]

    expect(pickByokCredential(rows, 'similar_image_search')?.id).toBe(11)
  })
})
