import { describe,expect,it } from 'vitest'
import {
announcesIntent,classifyReply,couldBeToolProgress,createPortableReplyPolicy,
decideReply,
endsWithColon,getGuardLocale,
initialReplyState,
isDecisionDodge,isToolProgressOnly,isVerifyPlaceholder,looksLikeNarration,
toolReplyProgress
} from "../../../../src/agent/harness/index.js"

describe('真实文字分类与语言策略', () => {
  it('将来行动宣告触发意图跟进，征询问题不能变成执行授权', () => {
    const request = '帮我查一下项目进度'
    const intent = classifyReply('我这就去帮你查一下项目进度', { userRequest: request })
    expect(intent.announcesIntent).toBe(true); expect(intent.narration).toBe(false)
    const first = decideReply(initialReplyState, intent)
    expect(first.action).toBe('retry'); expect(first.prompt).toBe(getGuardLocale().prompts.intent)
    const question = classifyReply('要我现在去查一下项目进度吗？', { userRequest: '项目怎么样了' })
    expect(question.announcesIntent).toBe(false)
    expect(decideReply(initialReplyState, question).action).toBe('complete')
  })
  it('读取声明保留文件/结果宾语边界，普通谈话和第三方事实不误判本轮操作', () => {
    expect(looksLikeNarration('我看到了文件内容，正文已经整理好了。')).toBe(true)
    expect(looksLikeNarration('我查了一下文件，发现配置写入到了个人目录。')).toBe(true)
    expect(looksLikeNarration('收到，测试的事我看到了，你之前做过类似验证。')).toBe(false)
    const reported = classifyReply('好——查了下，示例公司已经发出传票，公开资料还不完整。', { userRequest: '查一下案件进展' })
    expect(reported.narration).toBe(false)
    expect(decideReply(initialReplyState, reported)).toMatchObject({ action: 'complete', visible: 'original' })
  })
  it('真实叙事守卫仅追一次，第二次仍无工具的结果不能作为核实成功输出', () => {
    const first = decideReply(initialReplyState, classifyReply('让我读一下这个文件，读到了，改好了！', { userRequest: '帮我改一下文件' }))
    expect(first.action).toBe('retry'); expect(first.prompt).toBe(getGuardLocale().prompts.narration)
    const second = decideReply(first.state, classifyReply('好的，明白了', { userRequest: '帮我改一下文件' }))
    expect(second.action).toBe('complete'); expect(second.visible).toBe('suppressed')
  })
  it.each(['先把文件移动到目标文件夹：', 'Let me move the file to the target folder:', 'Here are the results：', '说明：   '])('任意开头的末尾冒号%j可独立续写', text => {
    expect(endsWithColon(text)).toBe(true)
  })
  it('说明冒号与行动宣告分开，前一轮工具不阻止本轮补完整说明', () => {
    const text = '下面是本次测试的说明：', facts = classifyReply(text, { userRequest: '说明测试', locale: 'zh-CN' })
    expect(facts.announcesIntent).toBe(false); expect(announcesIntent('Here is the explanation:', 'en-US')).toBe(false)
    expect(endsWithColon('说明如下。')).toBe(false)
    const first = decideReply(toolReplyProgress(initialReplyState, true), facts)
    expect(first.action).toBe('retry'); expect(first.prompt).toBe(getGuardLocale().prompts.colon)
    const completion = decideReply(first.state, classifyReply('句末冒号表示说明尚未完整，接下来应把结果说清楚。', { userRequest: '说明测试' }))
    expect(completion.visible).toBe('original')
    const unverified = decideReply(first.state, classifyReply('我查了一下文件，发现任务写入到了个人文件夹。', { userRequest: '说明测试' }))
    expect(unverified.visible).toBe('suppressed')
  })
  it('工具进度前缀支持流式部分，但完整正常句不能当纯占位回复', () => {
    expect(couldBeToolProgress('正在为你查')).toBe(true)
    expect(isToolProgressOnly('正在为你查')).toBe(false)
    expect(isToolProgressOnly('正在为你查询最新信息。')).toBe(true)
    expect(isToolProgressOnly('正在　为你 查询最新信息……')).toBe(true)
    expect(isToolProgressOnly('我正在查询最新信息，稍后把三支车队的升级整理给你。')).toBe(false)
    const facts = classifyReply('正在为你查询最新信息。', { userRequest: '查一下最新信息' })
    expect(decideReply(initialReplyState, facts).prompt).toBe(getGuardLocale().prompts.tools)
  })
  it('requiresTools来自明确运行时元数据，正文不凭空产生必须执行工具的事实', () => {
    const normal = classifyReply('下面介绍requires_tools参数。', { userRequest: '解释参数' })
    expect(normal.requiresTools).toBe(false)
    const required = classifyReply('稍后给你结果。', { userRequest: '查信息', requiresTools: true })
    expect(required.requiresTools).toBe(true)
    expect(decideReply(initialReplyState, required).prompt).toBe(getGuardLocale().prompts.tools)
  })
  it('决策守卫仅用户optin开启，实际分类为推脱也不能代替开关', () => {
    const request = '帮我把这些任务重新排序一下', response = '这个不需要重新排序，已经挺合理的了。'
    const disabled = classifyReply(response, { userRequest: request })
    expect(disabled.decisionDodge).toBe(true); expect(disabled.decisionGuardEnabled).toBe(false)
    expect(decideReply(initialReplyState, disabled)).toMatchObject({ action: 'complete', visible: 'original' })
    const enabled = classifyReply(response, { userRequest: request, decisionGuardEnabled: true })
    const first = decideReply(initialReplyState, enabled)
    expect(first.action).toBe('retry'); expect(first.prompt).toBe(getGuardLocale().prompts.decision)
    expect(decideReply(first.state, classifyReply('好的，已经帮你重新排好序了', { userRequest: request, decisionGuardEnabled: true })).visible).toBe('suppressed')
  })
  it('引用历史中的操作词不等于本轮操作请求，澄清或讨论仍正常回答', () => {
    const request = '[当前群聊发言人]\n群昵称=小北\n💬 用户引用/回复了一条历史消息（原文：「要不要把登录页换成另一个服务？」），针对这条消息说：\n\n登录页是不是自家前端渲染？'
    expect(isDecisionDodge(request, '登录页是自家前端渲染的，不需要走另一个服务。')).toBe(false)
    expect(isDecisionDodge('帮我把这些任务重新排序一下', '这个不需要重新排序。要不要我先给你几个排序方案？')).toBe(false)
    expect(isDecisionDodge('登录页不需要走统一认证吗？', '不需要走统一认证，登录页可以由应用前端自己渲染。')).toBe(false)
    expect(isDecisionDodge('帮我把这些任务重新排序一下', '这个不需要重新排序，已经挺合理的了。')).toBe(true)
  })
  it.each(['en-US', 'EN_us'])('用户界面语言%j使用真实英文分类和英文提示，不按正文自动改语言', locale => {
    const facts = classifyReply('Let me move the file to the target folder.', { userRequest: 'Move the file.', locale })
    expect(facts.announcesIntent).toBe(true); expect(facts.prompts.intent.startsWith('[System reminder')).toBe(true)
    expect(looksLikeNarration('I checked the file.', locale)).toBe(true)
    expect(looksLikeNarration('The company moved its offices last year.', locale)).toBe(false)
    expect(announcesIntent('Should I move the file?', locale)).toBe(false)
    expect(isDecisionDodge('Please reorder these tasks.', 'There is no need to reorder them.', locale)).toBe(true)
    expect(isDecisionDodge('Please reorder these tasks.', 'Would you like me to show a plan first?', locale)).toBe(false)
    expect(classifyReply('我这就去查一下', { userRequest: '查一下', locale }).announcesIntent).toBe(false)
  })
  it('英文词边界与Python Unicode行为一致，不误把中文或更长单词中的I/read当独立动作', () => {
    expect(looksLikeNarration('我I checked the file.', 'en-US')).toBe(false)
    expect(looksLikeNarration('I checked the file.', 'en-US')).toBe(true)
    expect(announcesIntent('I will readership-check this definition.', 'en-US')).toBe(true)
    expect(announcesIntent('I will readership this definition.', 'en-US')).toBe(false)
  })
  it('日文规则保留完成声明和征询问题边界', () => {
    expect(looksLikeNarration('ファイルを確認しました。', 'ja-JP')).toBe(true)
    expect(announcesIntent('ファイルを確認しますか？', 'ja-JP')).toBe(false)
    const facts = classifyReply('これからファイルを移動します。', { userRequest: '移動してください', locale: 'JA_jp' })
    expect(facts.announcesIntent).toBe(true); expect(facts.prompts.intent).toContain('システム通知')
    expect(isDecisionDodge('ファイルを並べ替えてください', '並べ替える必要はありません', 'ja-JP')).toBe(true)
  })
  it.each([undefined, null, '', 'fr-FR', 'en', 'en-GB', 'ja', ' en-US '])('未知/未设精确语言键%j稳定采用中文策略', locale => {
    expect(getGuardLocale(locale)).toBe(getGuardLocale('zh-CN'))
    expect(classifyReply('我这就去查一下', { userRequest: '查一下', locale }).announcesIntent).toBe(true)
  })
  it('核验过程占位不等于交付结果，完整核验摘要不因包含已核实而误伤', () => {
    expect(isVerifyPlaceholder('正在核实……')).toBe(true)
    expect(isVerifyPlaceholder(' 都核实过了，没问题。')).toBe(true)
    expect(isVerifyPlaceholder('　')).toBe(true)
    expect(isVerifyPlaceholder('已核实三个文件的归属、版本和目录关系，具体结果请见下面的清单。')).toBe(false)
  })
  it('默认Core工厂用真实分类，只把locale/本轮请求/optin作为可信上下文输入', async () => {
    const policy = createPortableReplyPolicy<{ locale: string; request: string; optin: boolean }>({
      context: value => ({
        locale: value.locale,
        userRequest: value.request, decisionGuardEnabled: value.optin
      })
    })
    const context = { locale: 'en-US', request: 'Please move the file.', optin: false }
    expect(await policy.evaluate('Let me move the file.', context)).toBe('accept')
    const facts = await policy.classify!('Let me move the file.', context)
    expect(facts.announcesIntent).toBe(true)
    expect(decideReply(initialReplyState, facts).prompt).toBe(getGuardLocale('en-US').prompts.intent)
  })
  it('本轮Provider requiresTools显式true/false覆盖请求hint，缺报不借用前轮事实', async () => {
    const policy = createPortableReplyPolicy<{ requiresTools?: boolean }>({ context: value => ({ locale: 'zh-CN', userRequest: '移动文件', ...value }) })
    expect((await policy.classify!('完成了', { requiresTools: true }, { requiresTools: false })).requiresTools).toBe(false)
    expect((await policy.classify!('完成了', { requiresTools: false }, { requiresTools: true })).requiresTools).toBe(true)
    expect((await policy.classify!('完成了', { requiresTools: true }, {})).requiresTools).toBe(false)
    expect((await policy.classify!('完成了', { requiresTools: true }, { requiresTools: undefined })).requiresTools).toBe(false)
    expect((await policy.classify!('完成了', { requiresTools: true })).requiresTools).toBe(true)
    expect((await policy.classify!('完成了', {})).requiresTools).toBe(false)
  })
})
