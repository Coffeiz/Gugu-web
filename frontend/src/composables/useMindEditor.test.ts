import { describe, it, expect } from 'vitest'
import {
  docToMarkdown, markdownToDoc, toggleTaskInMd, mdToPreviewHtml, MIND_REF_RE,
} from './useMindEditor'

// 2026-07-11 起支持的行内标记（加粗/斜体/删除线/行内代码/链接）——简化解析，不认
// `_..._` 下划线写法（避免 snake_case 被误判成斜体），也不支持标记嵌套。

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
    '**加粗**',
    '*斜体*',
    '~~删除线~~',
    '`行内代码`',
    '[咕咕](https://example.com)',
    '一段 **加粗** 和 *斜体* 还有 `代码` 和 [链接](https://a.com) 混一起',
    '- [ ] **加粗的待办** [[project:1|X]]',
    '***加粗加斜体***',
    '~~**加粗加删除线**~~',
    '~~*斜体加删除线*~~',
    '~~***三个都加***~~',
    '前 ***中间*** 后',
  ])('%s', (md) => {
    expect(roundTrip(md)).toBe(md)
  })
})

describe('Mind md⇄doc 往返：多打的空行不会被吃掉', () => {
  it('两段之间多一条空行（2 条空行），往返保真', () => {
    expect(roundTrip('第一段\n\n\n第二段')).toBe('第一段\n\n\n第二段')
  })
  it('三条连续空行（多空两行），往返保真', () => {
    expect(roundTrip('第一段\n\n\n\n第二段')).toBe('第一段\n\n\n\n第二段')
  })
  it('单条空行（默认块间分隔）不受影响，不会平白多出空段落', () => {
    const doc = markdownToDoc('第一段\n\n第二段')
    expect(doc.content?.length).toBe(2)
    expect(roundTrip('第一段\n\n第二段')).toBe('第一段\n\n第二段')
  })
  it('文档开头的空行不产生多余空段落', () => {
    expect(markdownToDoc('\n\n第一段').content?.length).toBe(1)
  })
  it('结尾多打的空行也保留（不是只有中间的才算数）', () => {
    expect(roundTrip('第一段\n\n\n')).toBe('第一段\n\n\n')
    expect(roundTrip('第一段\n\n\n\n')).toBe('第一段\n\n\n\n')
  })
  it('结尾只是个孤零零的换行符（1 个 \\n，不构成一条完整空行）不产生多余空段落', () => {
    const doc = markdownToDoc('第一段\n')
    expect(doc.content?.length).toBe(1)
  })
  it('结尾恰好一条空行（2 个 \\n，跟块间分隔同一套换算）会产生 1 个空段落', () => {
    const doc = markdownToDoc('第一段\n\n')
    expect(doc.content?.length).toBe(2)
    expect(roundTrip('第一段\n\n')).toBe('第一段\n\n')
  })
  it('f(f(x)) === f(x)（多空行也幂等）', () => {
    const once = roundTrip('第一段\n\n\n第二段')
    expect(roundTrip(once)).toBe(once)
  })
  it('只读预览里空段落渲染成 .np-blank 占位，data-line-unit 照常递增', () => {
    const html = mdToPreviewHtml('第一段\n\n\n第二段')
    expect(html).toContain('class="np-blank"')
    expect(html).toContain('<p data-line-unit="0">第一段</p>')
    expect(html).toContain('<p data-line-unit="2">第二段</p>')
  })
})

describe('Mind md⇄doc 往返：加粗+斜体+删除线可以叠加在同一段文字上', () => {
  it('*** 解析成同一个文本节点上的 bold+italic 两个 mark，不是半个 mark 加裸星号', () => {
    const doc = markdownToDoc('***加粗加斜体***')
    const textNode = doc.content?.[0]?.content?.[0]
    expect(textNode?.text).toBe('加粗加斜体')
    expect(textNode?.marks?.map(m => m.type).sort()).toEqual(['bold', 'italic'])
    // 只有这一个节点，没有额外裸星号被当成普通文字残留
    expect(doc.content?.[0]?.content?.length).toBe(1)
  })
})

describe('Mind md⇄doc 往返：行内标记不误伤普通文本', () => {
  it('snake_case 变量名不被当成斜体（不认下划线写法）', () => {
    expect(roundTrip('文件是 some_snake_case_var.py')).toBe('文件是 some_snake_case_var.py')
  })
  it('乘法表达式里的星号不触发斜体（* 后紧跟空格不算开始定界符）', () => {
    expect(roundTrip('2 * 3 = 6')).toBe('2 * 3 = 6')
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
  it('加粗/斜体/删除线/行内代码渲染成对应标签', () => {
    expect(mdToPreviewHtml('**粗**')).toBe('<p data-line-unit="0"><strong>粗</strong></p>')
    expect(mdToPreviewHtml('*斜*')).toBe('<p data-line-unit="0"><em>斜</em></p>')
    expect(mdToPreviewHtml('~~删~~')).toBe('<p data-line-unit="0"><s>删</s></p>')
    expect(mdToPreviewHtml('`码`')).toBe('<p data-line-unit="0"><code>码</code></p>')
  })
  it('链接渲染成 <a> 且带 target=_blank/rel', () => {
    const html = mdToPreviewHtml('[咕咕](https://gugu.example.com)')
    expect(html).toContain('<a href="https://gugu.example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('>咕咕</a>')
  })
  it('危险 scheme 的链接被挡成 #（javascript: 注入兜底）', () => {
    const html = mdToPreviewHtml('[点我](javascript:alert(1))')
    expect(html).toContain('href="#"')
    expect(html).not.toContain('javascript:')
  })
})

describe('MIND_REF_RE', () => {
  it('捕获 type / id / label', () => {
    const m = MIND_REF_RE.exec('[[client:12|张三]]')
    expect([m?.[1], m?.[2], m?.[3]]).toEqual(['client', '12', '张三'])
  })
})
