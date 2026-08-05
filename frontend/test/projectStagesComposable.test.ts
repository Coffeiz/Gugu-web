import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useProjectStages } from '@/composables/projects/useProjectStages'

describe('useProjectStages', () => {
  it('计算因手动完成待办而锁定的阶段位置', () => {
    const stages = ref([
      { key: 'one', label: '一', todos: [{ id: 'a', text: 'A', done: true }] },
      { key: 'two', label: '二', todos: [{ id: 'b', text: 'B', done: true, autoCompleted: true }] },
      { key: 'three', label: '三', todos: [{ id: 'c', text: 'C', done: false }] },
    ])
    const composable = useProjectStages({ stages, saveStages: vi.fn() })
    expect([...composable.lockedStageIndices('three')]).toEqual([0])
  })
})
