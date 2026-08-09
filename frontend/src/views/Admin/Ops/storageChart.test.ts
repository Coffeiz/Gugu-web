import { describe, expect, it } from 'vitest'
import { buildStorageTrend } from './storageChart'

describe('buildStorageTrend', () => {
  it('按日期 union 对齐缺失快照，不按数组下标左移', () => {
    const result = buildStorageTrend({
      user_files: [
        { taken_at: '2026-08-01T01:15:00Z', object_count: 1, total_bytes: 1024 * 1024 },
        { taken_at: '2026-08-02T01:15:00Z', object_count: 1, total_bytes: 2 * 1024 * 1024 },
        { taken_at: '2026-08-03T01:15:00Z', object_count: 1, total_bytes: 3 * 1024 * 1024 },
        { taken_at: '2026-08-04T01:15:00Z', object_count: 1, total_bytes: 4 * 1024 * 1024 },
      ],
      video_cache: [
        { taken_at: '2026-08-01T01:00:00Z', object_count: 1, total_bytes: 10 * 1024 * 1024 },
        { taken_at: '2026-08-03T01:00:00Z', object_count: 1, total_bytes: 30 * 1024 * 1024 },
        { taken_at: '2026-08-04T01:00:00Z', object_count: 1, total_bytes: 40 * 1024 * 1024 },
      ],
    }, [{ key: 'user_files' }, { key: 'video_cache' }])

    expect(result.dates).toEqual(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'])
    expect(result.datasets[1].values).toEqual([10, null, 30, 40])
  })
})
