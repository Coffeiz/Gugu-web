import assert from 'node:assert/strict'
import { test } from 'vitest'
import { deduplicateGroupEventMemory, groupDailyDatesPreserved, parseGroupDailyEntries, prepareGroupDailyCompactionBatch, renderGroupDailyEntries, shouldCompactGroupDaily, splitOldestGroupDailyBatch } from '../../../src/memory/im-group-daily-compaction.js'

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

const dailyEntries = (count: number): Array<[string, string]> => Array.from({ length: count }, (_, index) =>
  [index < 100 ? '2026-11-18' : index < 200 ? '2026-11-17' : '2026-11-16', `合成记录${index}：保留日期和正文。`])

test('初始99条不启动、100条整批清空，冻结内容不依赖调用者后续修改', () => {
  assert.equal(prepareGroupDailyCompactionBatch(renderGroupDailyEntries(dailyEntries(99))), null)
  const entries = dailyEntries(100), result = prepareGroupDailyCompactionBatch(renderGroupDailyEntries(entries))!
  assert.deepEqual(result.batch, entries); assert.deepEqual(result.remainingEntries, []); assert.equal(result.dailyAfter, '')
  const frozen = dailyEntries(100), saved = structuredClone(frozen)
  const resumed = prepareGroupDailyCompactionBatch(renderGroupDailyEntries(frozen), frozen)!
  frozen[0]![1] = '调用后变动不应改变已准备批次'
  assert.deepEqual(resumed.batch, saved)
})

test('250条初始范围按最旧100/100/50完整沉淀，末批不足阈值继续且日期正文均保留', () => {
  const entries = dailyEntries(250), batches: Array<Array<[string, string]>> = []
  let result = prepareGroupDailyCompactionBatch(renderGroupDailyEntries(entries))!
  for (;;) {
    batches.push(result.batch)
    assert.deepEqual(parseGroupDailyEntries(result.dailyAfter), result.remainingEntries)
    if (!result.remainingEntries.length) break
    result = prepareGroupDailyCompactionBatch(result.dailyAfter, result.remainingEntries)!
  }
  assert.deepEqual(batches.map(batch => batch.length), [100, 100, 50])
  assert.deepEqual(batches, [entries.slice(150), entries.slice(50, 150), entries.slice(0, 50)])
  assert.deepEqual([...batches].reverse().flat(), entries)
  assert.equal(result.dailyAfter, '')
})

test('恢复只处理冻结范围，并发新增头部完整保留且不被本轮余数吞掉', () => {
  const entries = dailyEntries(250), first = prepareGroupDailyCompactionBatch(renderGroupDailyEntries(entries))!
  const head: Array<[string, string]> = [['2026-11-19', '并发新增甲'], ['2026-11-18', '并发新增乙']]
  const second = prepareGroupDailyCompactionBatch(renderGroupDailyEntries([...head, ...first.remainingEntries]), first.remainingEntries)!
  assert.deepEqual(second.batch, entries.slice(50, 150))
  assert.deepEqual(parseGroupDailyEntries(second.dailyAfter), [...head, ...entries.slice(0, 50)])
  const last = prepareGroupDailyCompactionBatch(second.dailyAfter, second.remainingEntries)!
  assert.deepEqual(last.batch, entries.slice(0, 50)); assert.equal(last.dailyAfter, renderGroupDailyEntries(head))
  assert.equal(prepareGroupDailyCompactionBatch(last.dailyAfter, last.remainingEntries), null)
  const newHead = dailyEntries(101)
  assert.equal(prepareGroupDailyCompactionBatch(renderGroupDailyEntries(newHead), []), null, '该轮完成不顺带沉淀新头部')
  assert.equal(prepareGroupDailyCompactionBatch(renderGroupDailyEntries(newHead))?.batch.length, 100)
})

test('旧tail日期/正文修改、删除、重排或插入均拒绝，错误不包含原文', () => {
  const frozen = dailyEntries(120), changed = structuredClone(frozen); changed[119]![1] = 'synthetic-private-body'
  const dateChanged = structuredClone(frozen); dateChanged[100]![0] = '2026-01-01'
  const reordered = structuredClone(frozen); [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!]
  for (const current of [changed, dateChanged, frozen.slice(1), frozen.slice(0, -1), reordered,
    [...frozen.slice(0, 50), ['2026-11-18', '中途插入'] as [string, string], ...frozen.slice(50)]])
    assert.throws(() => prepareGroupDailyCompactionBatch(renderGroupDailyEntries(current), frozen), error =>
      error instanceof Error && error.message === '群每日记忆已变更，暂不能沉淀' && !('cause' in error))
  assert.throws(() => prepareGroupDailyCompactionBatch('', [['2026-11-18', 42]] as never), /群每日记忆已变更/)
})
