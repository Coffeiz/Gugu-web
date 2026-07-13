import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import {
  docToMarkdown, markdownToDoc, mindExtensions, toggleTaskInMd, mdToPreviewHtml, MIND_REF_RE, splitMindTitleBody,
} from './useMindEditor'
import type { MindDocNode } from './useMindEditor'

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

describe('Mind md⇄doc 往返：代码块/引用块/有序列表/分割线（2026-07-11 起支持）', () => {
  it.each([
    '```\ncode line\n```',
    '```js\nconst x = 1\n```',
    '> 一条引用',
    '> 第一行\n> 第二行',                       // 多段引用，累进同一个块
    '1. 第一项\n2. 第二项\n3. 第三项',
    '---',
    '第一段\n\n```py\nprint(1)\n```\n\n第二段', // 代码块跟普通段落混排
    '- [ ] 待办\n\n1. 有序项\n\n> 引用',        // 四种块级/待办混排，互不吞并
  ])('%s', (md) => {
    expect(roundTrip(md)).toBe(md)
  })

  it('代码块内容原样保留，不当 mindRef/加粗解析（[[ ]] 和 ** 都是字面量）', () => {
    const md = '```\n[[project:1|X]] 和 **不是加粗**\n```'
    const doc = markdownToDoc(md)
    const code = doc.content?.[0]
    expect(code?.type).toBe('codeBlock')
    expect(code?.content?.[0]?.text).toBe('[[project:1|X]] 和 **不是加粗**')
    expect(roundTrip(md)).toBe(md)
  })

  it('代码块空行是代码的一部分，不当成分段空行', () => {
    const md = '```\na\n\nb\n```'
    const doc = markdownToDoc(md)
    expect(doc.content?.length).toBe(1)
    expect(doc.content?.[0]?.content?.[0]?.text).toBe('a\n\nb')
    expect(roundTrip(md)).toBe(md)
  })

  it('有序列表 orderedListItem 是独立节点名，不会被无序列表的圆点渲染吃掉', () => {
    const doc = markdownToDoc('1. 项一')
    expect(doc.content?.[0]?.type).toBe('orderedList')
    expect(doc.content?.[0]?.content?.[0]?.type).toBe('orderedListItem')
  })

  it('分割线渲染成 <hr>，不认带空格的 "- - -" 写法（会先被无序列表吃掉）', () => {
    expect(mdToPreviewHtml('---')).toBe('<hr class="np-hr">')
    expect(markdownToDoc('- - -').content?.[0]?.type).toBe('bulletList')
  })

  it('空代码块（插入后什么都没打）不产生非法的空文本节点，能正常再解析回来', () => {
    // 插入代码块后立刻保存，TipTap 自己给出的空 codeBlock 没有 content 字段
    const emptyFromEditor: MindDocNode = { type: 'doc', content: [{ type: 'codeBlock' }] }
    const md = docToMarkdown(emptyFromEditor)
    expect(md).toBe('```\n\n```')
    // 重新读回来（比如便签重开一次），不能出现 { type:'text', text:'' } 这种非法节点——
    // ProseMirror 的 text 节点不允许零长度，带着这种节点的 JSON 灌进编辑器会直接失败
    const doc = markdownToDoc(md)
    const code = doc.content?.[0]
    expect(code?.type).toBe('codeBlock')
    expect(code?.content).toBeUndefined()
    expect(roundTrip(md)).toBe(md)
  })
  it('未闭合的代码围栏结尾也不丢内容', () => {
    const doc = markdownToDoc('```\n没有结束的代码')
    expect(doc.content?.[0]?.type).toBe('codeBlock')
    expect(doc.content?.[0]?.content?.[0]?.text).toBe('没有结束的代码')
  })

  it('只读预览：代码块整块一个 data-line-unit，引用块每段一个', () => {
    const html = mdToPreviewHtml('> 第一行\n> 第二行\n\n```\nx\n```')
    expect(html).toContain('<blockquote class="np-quote">')
    expect(html).toContain('data-line-unit="0"')
    expect(html).toContain('data-line-unit="1"')
    expect(html).toContain('class="np-code-block" data-line-unit="2"')
  })

  it('只读预览：代码块按语言语法高亮，跟 GuguChat 聊天同一套 hljs token class', () => {
    const html = mdToPreviewHtml('```js\nconst x = 1\n```')
    expect(html).toContain('class="hljs language-js"')
    expect(html).toContain('hljs-keyword')   // const 应该被识别成关键字
  })
  it('只读预览：代码块显示语言名标签（写了语言直接显示，没写就显示 highlightAuto 猜的）', () => {
    expect(mdToPreviewHtml('```js\nconst x = 1\n```')).toContain('<div class="np-code-lang">js</div>')
    expect(mdToPreviewHtml('```\nconst x = 1\n```')).toMatch(/<div class="np-code-lang">\S+<\/div>/)
  })
  it('没写语言时不报错，交给 highlightAuto 猜（用全量语言库，猜中什么算什么，不强求 plaintext）', () => {
    expect(() => mdToPreviewHtml('```\n随便写点什么\n```')).not.toThrow()
    expect(mdToPreviewHtml('```\n随便写点什么\n```')).toMatch(/class="hljs language-\S+"/)
  })
  it('写了个不存在的语言名不报错，退化成自动猜', () => {
    expect(() => mdToPreviewHtml('```not-a-real-lang\nx\n```')).not.toThrow()
    expect(mdToPreviewHtml('```not-a-real-lang\nx\n```')).toMatch(/class="hljs language-\S+"/)
  })

  // bug：引用块里塞列表，docToMarkdown 只认段落子节点，会把列表项序列化成空字符串——
  // 保存后引用块整个变空、再编辑也是空的。改成从 schema 层面（content:'paragraph+'）
  // 挡掉这类嵌套，而不是等序列化层再兜底：工具栏的列表/待办命令在引用块里应该直接失效。
  it('引用块内不能再嵌套列表/待办（schema 收窄成 paragraph+，工具栏命令应失效）', () => {
    const editor = new Editor({ extensions: mindExtensions(), content: '<blockquote><p>hello</p></blockquote>' })
    editor.commands.setTextSelection(5)
    expect(editor.can().toggleBulletList()).toBe(false)
    expect(editor.can().toggleOrderedList()).toBe(false)
    expect(editor.can().toggleTaskList()).toBe(false)
    editor.destroy()
  })
})

describe('MIND_REF_RE', () => {
  it('捕获 type / id / label', () => {
    const m = MIND_REF_RE.exec('[[client:12|张三]]')
    expect([m?.[1], m?.[2], m?.[3]]).toEqual(['client', '12', '张三'])
  })
})

describe('splitMindTitleBody', () => {
  it('只把首个非空的 Markdown 标题分离出来，并保留对象引用显示名', () => {
    expect(splitMindTitleBody('\n# [[project:7|画布项目]]\n\n正文')).toEqual({ titleRaw: '画布项目', body: '正文' })
  })

  it('普通正文不伪造标题', () => {
    expect(splitMindTitleBody('- [ ] 想法')).toEqual({ titleRaw: '', body: '- [ ] 想法' })
  })
})
