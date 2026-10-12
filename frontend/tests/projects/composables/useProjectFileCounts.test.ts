// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { useProjectFileCounts } from '@/composables/projects/useProjectFileCounts'

describe('useProjectFileCounts', () => {
  it('没有有界统计摘要时不伪造文件数量', () => {
    const state = useProjectFileCounts(0)
    expect(state.counts.value).toBeNull()
    expect(state.refresh()).toBeUndefined()
  })
})
