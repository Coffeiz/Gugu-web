import { describe, expect, it, vi } from 'vitest'
import { translateEmailDraft } from '../../src/email/translate.js'

const draft = {
  subject: '源主题', title: '源标题', preheader: '', body: '源正文',
  sections: [{ heading: '', text: '第一段' }, { heading: '区块', text: '第二段' }],
  actions: [{ label: '打开', url: 'https://example.test/path' }],
  template: 'notification', theme: 'light', palette: 'neutral',
}

describe('邮件本地化', () => {
  it('对每种目标语言保留邮件结构、空标题和原始操作链接', async () => {
    const complete = vi.fn(async (prompt: string) => {
      const locale = prompt.includes('ja-JP') ? 'ja-JP' : 'en-US'
      return JSON.stringify({ [locale]: {
        subject: `${locale} 主题`, title: `${locale} 标题`, body: `${locale} 正文`,
        sections: [{ heading: '不应新增标题', text: `${locale} 段落一` }, { heading: '区块译文', text: `${locale} 段落二` }, { heading: '多余', text: '应丢弃' }],
        actions: [{ label: `${locale} 按钮`, url: 'https://attacker.test/' }, { label: '多余按钮', url: 'https://attacker.test/extra' }],
      } })
    })

    const result = await translateEmailDraft(draft, complete)

    expect(Object.keys(result)).toEqual(['ja-JP', 'en-US'])
    expect(result['ja-JP']).toMatchObject({
      subject: 'ja-JP 主题', title: 'ja-JP 标题', body: 'ja-JP 正文', preheader: '',
      sections: [{ heading: '', text: 'ja-JP 段落一' }, { heading: '区块译文', text: 'ja-JP 段落二' }],
      actions: [{ label: 'ja-JP 按钮', url: 'https://example.test/path' }],
    })
    expect(result['en-US'].actions[0]?.url).toBe('https://example.test/path')
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('模型输出不完整或含未展开占位符时最多重试三次，并返回安全错误', async () => {
    const complete = vi.fn(async () => JSON.stringify({ subject: '{subject}', title: '标题', body: '正文', sections: [], actions: [] }))

    await expect(translateEmailDraft(draft, complete)).rejects.toMatchObject({ code: 'invalid_model_output' })
    expect(complete).toHaveBeenCalledTimes(3)
  })

  it('按 Python 字符长度接受合法的补充平面 Unicode 文案', async () => {
    const source = { ...draft, subject: '😀'.repeat(101), sections: [], actions: [] }
    const complete = vi.fn(async () => JSON.stringify({
      subject: '😀'.repeat(101), title: '标题', body: '正文', sections: [], actions: [],
    }))

    const result = await translateEmailDraft(source, complete)

    expect(result['ja-JP'].subject).toBe('😀'.repeat(101))
    expect(complete).toHaveBeenCalledTimes(2)
  })
})
