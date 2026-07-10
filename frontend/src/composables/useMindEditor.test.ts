import { describe, it, expect } from 'vitest'
import {
  docToMarkdown, markdownToDoc, toggleTaskInMd, mdToPreviewHtml, MIND_REF_RE,
} from './useMindEditor'

// Mind 便签的 Markdown ⇄ doc 序列化是存储层的核心不变量（P1 落地记录声称"往返无损且幂等"）。
// 窄口径：正文 / 单级标题 / 待办 / 无序列表 / 对象引用 [[type:id|label]]。这里钉死往返、幂等、
// 引用保真、待办勾选、以及只读预览的转义（GPT 说 Mind 预览安全，一并锁死）。

const roundTrip = (md: string) => docToMarkdown(markdownToDoc(md))

describe('Mind md⇄doc 往返：稳定形态无损', () => {
  it.each([
    '普通一段',
    '# 标题',
    '- [ ] 待办一\n- [x] 待办二',
    '- 项一\n- 项二',
    '跟进 [[project:7|某项目]] 收尾',
    '- [ ] 联系 [[client:3|张三]]',                  // 引用嵌在待办里（P1 落地记录点名）
    '第一段\n\n# 小标题\n\n- [ ] 待办\n\n- 列表',    // 混合块，块间空行分隔
  ])('%s', (md) => {
    expect(roundTrip(md)).toBe(md)
  })
})

describe('Mind md⇄doc 往返：规整与幂等', () => {
  it('多级标题 clamp 成单级', () => {
    expect(roundTrip('### 三级')).toBe('# 三级')
  })
  it('f(f(x)) === f(x)（幂等）', () => {
    const once = roundTrip('## 二级会被规整\n\n正文 [[file:9|报告]]\n\n- [x] 做完了')
    expect(roundTrip(once)).toBe(once)
  })
  it('空输入 → doc 至少一个空段落，序列化回空串', () => {
    expect(markdownToDoc('').content?.[0]?.type).toBe('paragraph')
    expect(roundTrip('')).toBe('')
  })
  it('mindRef 的 type/id/label 往返保真', () => {
    const doc = markdownToDoc('见 [[event:42|周会]]')
    const ref = doc.content?.[0]?.content?.find(n => n.type === 'mindRef')
    expect(ref?.attrs).toMatchObject({ refType: 'event', refId: 42, label: '周会' })
    expect(docToMarkdown(doc)).toBe('见 [[event:42|周会]]')
  })
})

describe('toggleTaskInMd', () => {
  const md = '- [ ] 一\n- [ ] 二\n- [x] 三'
  it('翻转指定序号的待办', () => {
    expect(toggleTaskInMd(md, 0)).toBe('- [x] 一\n- [ ] 二\n- [x] 三')
    expect(toggleTaskInMd(md, 2)).toBe('- [ ] 一\n- [ ] 二\n- [ ] 三')
  })
  it('序号越界返回原文', () => {
    expect(toggleTaskInMd(md, 9)).toBe(md)
  })
  it('只数待办、跳过普通列表行', () => {
    expect(toggleTaskInMd('- 普通\n- [ ] 待办0', 0)).toBe('- 普通\n- [x] 待办0')
  })
})

describe('mdToPreviewHtml — 只读预览转义（防注入，GPT 判安全，钉死）', () => {
  it('正文里的 HTML 被转义、不产生真实元素', () => {
    const html = mdToPreviewHtml('前 <img src=x onerror=alert(1)> 后')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
  it('mindRef 渲染成 span.mind-ref 并展示 label', () => {
    const html = mdToPreviewHtml('见 [[project:7|某项目]]')
    expect(html).toContain('class="mind-ref"')
    expect(html).toContain('data-ref-id="7"')
    expect(html).toContain('某项目')
  })
})

describe('MIND_REF_RE', () => {
  it('捕获 type / id / label', () => {
    const m = MIND_REF_RE.exec('[[client:12|张三]]')
    expect([m?.[1], m?.[2], m?.[3]]).toEqual(['client', '12', '张三'])
  })
})
