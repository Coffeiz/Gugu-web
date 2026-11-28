import assert from 'node:assert/strict'
import test from 'node:test'
import { createImMediaBudget, IM_MEDIA_BATCH_BYTES, IM_MEDIA_MAX_FILES, IM_MEDIA_MAX_FILE_BYTES } from '../dist/runtime/media-budget.js'

test('IM 媒体额度把「单文件上限」与「批次总额」分开：两个各 10MB 的文件不会因合计超限被整批拒绝', () => {
  const budget = createImMediaBudget(30 * 1024 * 1024, 4, 20 * 1024 * 1024)
  const ten = 10 * 1024 * 1024
  assert.equal(budget.fileRemaining, 20 * 1024 * 1024)
  assert.equal(budget.consume(ten), true)
  assert.equal(budget.consume(ten), true)
  // 两个文件都记入成功：单文件都没超过 20MB，批次合计 20MB 也没超过 30MB
  assert.equal(budget.remaining, 10 * 1024 * 1024)
  assert.equal(budget.fileRemaining, 10 * 1024 * 1024)
})

test('单个附件超过自身上限时不能记入额度，且不占用批次额度', () => {
  const budget = createImMediaBudget(100 * 1024 * 1024, 4, 5 * 1024 * 1024)
  assert.equal(budget.consume(6 * 1024 * 1024), false)
  assert.equal(budget.remaining, 100 * 1024 * 1024)
  assert.equal(budget.consume(5 * 1024 * 1024), true)
  assert.equal(budget.remaining, 95 * 1024 * 1024)
})

test('批次总额用尽后不再给出额度；文件数用尽后同样不再给出额度', () => {
  const budget = createImMediaBudget(4 * 1024 * 1024, 2)
  assert.equal(budget.consume(3 * 1024 * 1024), true)
  assert.equal(budget.consume(2 * 1024 * 1024), false)
  assert.equal(budget.remaining, 1024 * 1024)
  const counted = createImMediaBudget(100 * 1024 * 1024, 1)
  assert.equal(counted.consume(1024), true)
  assert.equal(counted.remaining, 0)
  assert.equal(counted.fileRemaining, 0)
})

test('额度参数非法时拒绝建立预算', () => {
  assert.throws(() => createImMediaBudget(0), RangeError)
  assert.throws(() => createImMediaBudget(-1), RangeError)
  assert.throws(() => createImMediaBudget(1024, 0), RangeError)
  assert.throws(() => createImMediaBudget(1024, 1, 0), RangeError)
})

test('共享默认额度下，单文件上限小于批次总额', () => {
  assert.ok(IM_MEDIA_MAX_FILE_BYTES < IM_MEDIA_BATCH_BYTES)
  assert.ok(IM_MEDIA_MAX_FILES > 1)
})
