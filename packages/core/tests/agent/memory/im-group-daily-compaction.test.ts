import assert from 'node:assert/strict'
import { test } from 'vitest'
import { deduplicateGroupEventMemory, groupDailyDatesPreserved, parseGroupDailyEntries, renderGroupDailyEntries, shouldCompactGroupDaily, splitOldestGroupDailyBatch } from '../../../src/memory/im-group-daily-compaction.js'

test('group daily starts compaction at the Python trigger and splits oldest records first', () => {
  const entries = Array.from({ length: 150 }, (_, index) => index + 1)
  assert.equal(shouldCompactGroupDaily(99), false)
  assert.equal(shouldCompactGroupDaily(100), true)
  const [remaining, oldest] = splitOldestGroupDailyBatch(entries)
  assert.deepEqual(remaining, Array.from({ length: 50 }, (_, index) => index + 1))
  assert.deepEqual(oldest, Array.from({ length: 100 }, (_, index) => index + 51))
  assert.deepEqual(splitOldestGroupDailyBatch([1, 2, 3], 0), [[1, 2], [3]])
})

test('group compaction requires every date anchor from the selected batch', () => {
  const entries: Array<[string, string]> = [['2026-08-04', '新'], ['2026-07-31', '旧']]
  assert.equal(groupDailyDatesPreserved(entries, '## 决定\n- 2026-08-04 新\n- 2026-07-31 旧'), true)
  assert.equal(groupDailyDatesPreserved(entries, '## 决定\n- 2026-08-04 新'), false)
  assert.equal(groupDailyDatesPreserved([], '无日期'), true)
})

test('group daily parsing and rendering preserve Python heading and note order', () => {
  const source = '## 2026-08-04\n- 新记录\n\n## 2026-07-31\n- 旧记录\n'
  const entries = parseGroupDailyEntries(source)
  assert.deepEqual(entries, [['2026-08-04', '新记录'], ['2026-07-31', '旧记录']])
  assert.equal(renderGroupDailyEntries(entries), source)
})

test('group event memory normalizes legacy headings and deduplicates repeated sections', () => {
  assert.equal(deduplicateGroupEventMemory(
    '## 2026-08-20\n\n2026-08-20 已确认群规。\n\n## 2026-08-20\n\n2026-08-20 已确认群规。\n2026-08-21 新增补充。',
  ), '## 记录长期记忆：2026-08-20\n\n2026-08-20 已确认群规。\n2026-08-21 新增补充。')
  assert.equal(deduplicateGroupEventMemory('2026-08-20 发生了重要事件。'), '## 记录长期记忆：2026-08-20\n\n2026-08-20 发生了重要事件。')
})
