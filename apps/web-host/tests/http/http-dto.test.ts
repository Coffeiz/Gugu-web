import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { validateDto } from '../../src/http/dto.js'

test('Zod DTO 校验成功时返回经过解析和转换的数据', () => {
  const schema = z.object({ count: z.coerce.number().int().positive() })
  const result = validateDto(schema, { count: '4' })

  assert.deepEqual(result, { ok: true, value: { count: 4 } })
})

test('DTO 校验失败可保留旧 API 的显式 detail 文案', () => {
  const schema = z.object({ name: z.string() })
  const result = validateDto(schema, { name: 1 }, { detail: '联系人请求字段无效' })

  assert.deepEqual(result, { ok: false, detail: '联系人请求字段无效' })
})

test('DTO 校验失败默认将 Zod 问题合并成 FastAPI 兼容的 detail 字符串', () => {
  const schema = z.object({ name: z.string(), count: z.number().int() })
  const result = validateDto(schema, { name: 1, count: 'bad' })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(typeof result.detail, 'string')
  assert.ok(result.detail.includes('name'))
  assert.ok(result.detail.includes('count'))
  assert.ok(result.detail.includes('；'))
})
