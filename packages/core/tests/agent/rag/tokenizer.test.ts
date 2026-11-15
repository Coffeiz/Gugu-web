import { beforeAll, describe, expect, it } from 'vitest'
import { tokenizeRaw, configureRagJieba } from '../../../src/agent/rag/tokenizer.js'

/** 固定词边界只替代 Jieba；日期别名与 ASCII 紧邻词合并仍经过生产 tokenizer。 */
const jieba = { cut: (text: string) => [text] }

beforeAll(() => configureRagJieba(jieba))

describe('1.7.7 RAG tokenizer 兼容边界', () => {
  it.each([
    ['2026-09-01 记录了这件事', ['2026', '09', '01', '记录了这件事', 'month_09']],
    ['9月', ['9', '月', 'month_09']],
    ['九月份', ['九月份', 'month_09']],
    ['September', ['september', 'month_09']],
    ['May 2026', ['may', '2026', 'may2026', 'month_05']],
    ['you may want to check', ['you', 'may', 'want', 'to', 'check']],
    ['March 2026', ['march', '2026', 'march2026', 'month_03']],
    ['we march forward', ['we', 'march', 'forward']],
  ])('日期与英文月名保持旧别名且不误识别普通词：%s', (text, expected) => {
    expect(tokenizeRaw(text)).toEqual(expected)
  })

  it('文档与查询共享同一日期规范词，防止索引和查询分词漂移', () => {
    const document = tokenizeRaw('记录了2026-09-01的工作区状态')
    const query = tokenizeRaw('工作区状态 2026-09-30')
    expect(document).toContain('month_09')
    expect(query).toContain('month_09')
  })
})
