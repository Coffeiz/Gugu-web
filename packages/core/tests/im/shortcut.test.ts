import { describe, expect, it } from 'vitest'
import { agentCommandMenu } from '../../src/agent/commands/menu.js'
import { agentCommandHelp } from '../../src/agent/commands/help.js'
import { chooseImInstantReactionEmoji, classifyImShortcutText, decideImShortcut, imReplyAwaitsAnswer, isExplicitImCancel, parseImShortcutCommand } from '../../src/im/shortcut.js'

const own = { currentPlatformUserId: 'synthetic-initiator', activePlatformUserIds: ['synthetic-initiator'] }
const other = { currentPlatformUserId: 'synthetic-other', activePlatformUserIds: ['synthetic-initiator'] }

it('即时表情保持Python关键词优先级、大小写与媒体优先，不参与快捷动作判断', () => {
  for (const [text, emoji] of [['HAHA lol', 'LAUGH'], ['thanks!', 'THANKS'], ['搞定', 'DONE'], ['666', 'WOW'], ['emo', 'CRY'],
    ['上线庆祝', 'PARTY'], ['hello', 'OnIt'], ['怎么做？', 'THINKING'], ['普通内容', 'OnIt'], ['谢谢哈哈', 'LAUGH']]) {
    expect(chooseImInstantReactionEmoji(text!, false)).toBe(emoji)
    expect(chooseImInstantReactionEmoji(text!, true)).toBe('OnIt')
  }
})

describe('IM 纯快捷意图保持真实用户输入与取消权限', () => {
  it('ACK与闲时进度/催促/自然取消均交Agent，不吞跨轮次承诺和回答', () => {
    for (const text of ['嗯', '嗯嗯', '好', '好的！', '谢谢', 'ok', 'thanks', '👍', '👌', '🙏']) {
      expect(classifyImShortcutText(text)).toBe('ack')
      for (const state of ['idle', 'thinking', 'waiting_confirm']) expect(decideImShortcut(text, state, own)).toEqual({ action: 'run' })
    }
    for (const text of ['还在吗', '查到了吗', '进度怎么样', '？', '...', '在？', '快点', '咕咕怎么这么慢', '取消', '算了', '停一下'])
      expect(decideImShortcut(text, 'idle', { awaiting: true, currentPlatformUserId: 'synthetic-initiator', activePlatformUserIds: [] })).toEqual({ action: 'run' })
  })

  it('只有完整短取消指令命中，讨论取消或带话题主语的慢不短路', () => {
    for (const text of ['取消', '取消当前任务', '请取消这个任务', '麻烦停止当前执行', '终止搜索吧', '帮我终止上一个RUN可以吗', '： 取消 ，']) {
      expect(isExplicitImCancel(text)).toBe(true)
      expect(decideImShortcut(text, 'thinking', own).action).toBe('cancel')
      expect(decideImShortcut(text, 'thinking', other).action).toBe('no_permission')
    }
    for (const text of ['这版取消 shadow 后，命中率回放怎么做？', '报告在讨论取消任务的边界。', '不要取消当前任务。', '取消之后的行为是什么？', '法拉利怎么这么慢', '这电脑太慢']) {
      expect(decideImShortcut(text, 'thinking', other)).toEqual({ action: 'run' })
    }
  })

  it('斜杠别名、半全角和参数保留；路径、中文命令、原型属性名均是普通输入', () => {
    for (const text of ['/stop', '/s', '／cancel', '/x', '/STOP ignored-argument']) expect(decideImShortcut(text, 'thinking', own).action).toBe('cancel')
    expect(parseImShortcutCommand(' ／STATUS　help ')).toEqual({ command: 'status', argument: 'help' })
    expect(decideImShortcut('/compact help', 'idle', {helpCommands:['compact']})).toEqual({action:'reply',reply:agentCommandHelp('compact',['compact'])})
    for (const text of ['/Users/synthetic/file', '/状态', '/constructor', '/__proto__', '请看/status', '/', '／　']) expect(decideImShortcut(text, 'thinking', own)).toEqual({ action: 'run' })
    expect(decideImShortcut('/stop', 'idle')).toEqual({ action: 'reply', reply: '现在没有在跑的任务哦～' })
  })

  it('只有显式可信允许时剥离单个紧邻命令的mention，普通聊天前缀原样放行', () => {
    for (const text of ['@小北 /compact', '＠小北　／compact', '<@bot-placeholder> /compact', '<@!bot-placeholder> /compact']) {
      expect(decideImShortcut(text, 'idle', { allowLeadingMention: true })).toEqual({ action: 'compact' })
      expect(decideImShortcut(text, 'idle')).toEqual({ action: 'run' })
    }
    for (const text of ['@小北 这次不用 /compact 了', '@小北/compact', '@小北 @小南 /compact', '<@bot-placeholder>/compact'])
      expect(decideImShortcut(text, 'idle', { allowLeadingMention: true })).toEqual({ action: 'run' })
  })

  it('状态过期但当前发起者仍活跃时可取消；非发起者含/stop都不能取消', () => {
    expect(decideImShortcut('/stop', 'idle', own).action).toBe('cancel')
    expect(decideImShortcut('/stop', 'idle', other).action).toBe('no_permission')
    for (const text of ['/stop', '／s', '/cancel', '算了', '取消当前任务']) {
      expect(decideImShortcut(text, 'thinking', other).action).toBe('no_permission')
      expect(decideImShortcut(text, 'thinking', { currentPlatformUserId: 'synthetic-initiator', activePlatformUserIds: [] }).action).toBe('no_permission')
      expect(decideImShortcut(text, 'thinking').action).toBe('no_permission')
    }
    expect(decideImShortcut('/stop', 'thinking', { ...own, activePlatformUserIds: new Set(['synthetic-initiator', 'second-initiator']) }).action).toBe('cancel')
  })

  it('状态话术按真实Python阶段映射，未知阶段不读取对象原型或执行状态', () => {
    const expected = { thinking: '还在想哦，稍等一下下～', searching: '正在查资料，可能还要几秒～', generating: '正在整理内容，马上就好～', waiting_confirm: '在等你确认那一步哦～' }
    for (const [state, reply] of Object.entries(expected)) {
      expect(decideImShortcut('进度', state, own)).toEqual({ action: 'reply', reply })
      expect(decideImShortcut('/status', state, own)).toEqual({ action: 'reply', reply })
    }
    expect(decideImShortcut('/status', 'constructor')).toEqual({ action: 'reply', reply: '在的，你说～' })
    expect(decideImShortcut('快点', 'unknown-stage')).toEqual({ action: 'reply', reply: '马上好啦，我加把劲儿～' })
    expect(decideImShortcut('/stop', 'thinking', { ...own, hasAttachments: true })).toEqual({ action: 'run' })
  })

  it('帮助复用规范菜单与详情，仅展示Host明确接通的命令', () => {
    const defaults = decideImShortcut('/help', 'idle')
    expect(defaults.action).toBe('reply')
    if (defaults.action !== 'reply') return
    for (const command of ['/stop', '/status', '/help']) expect(defaults.reply).toContain(command)
    for (const command of ['/compact', '/goal', '/workspace', '/auto', '/unlimited']) expect(defaults.reply).not.toContain(command)
    expect(decideImShortcut('/help compact', 'idle')).toEqual({ action: 'reply', reply: '当前入口尚未提供 /compact 命令。' })
    const available = agentCommandMenu().map(item => item.command.slice(1))
    const all = decideImShortcut('/help', 'idle', { helpCommands: available })
    if (all.action !== 'reply') throw new Error('帮助应为静态回复')
    for (const item of agentCommandMenu()) expect(all.reply).toContain(item.command)
    expect(agentCommandHelp('workspace', available).split('\n')).toContain('/workspace delete <ID> confirm　确认删除工作区')
    expect(agentCommandHelp('goal', available).split('\n')).toContain('/goal resume　恢复目标任务')
    for (const text of ['/stop help', '/status HELP', '/stop ?', '/status ？','/compact help','／compact　？']) expect(decideImShortcut(text, 'thinking', other).action).toBe('reply')
  })

  it('Unicode空白与码点窗口对齐Python，BOM不误认成可剥前缀', () => {
    expect(parseImShortcutCommand('\u0085/stop\u001cHELP\u0085')).toEqual({ command: 'stop', argument: 'HELP' })
    expect(decideImShortcut('\uFEFF/compact', 'idle')).toEqual({ action: 'run' })
    expect(decideImShortcut('\u0085取消\u0085', 'idle', other)).toEqual({ action: 'run' })
    expect(decideImShortcut('@小北\u0085/compact', 'idle', { allowLeadingMention: true })).toEqual({ action: 'compact' })
    expect(imReplyAwaitsAnswer('确认一下' + '😀'.repeat(20))).toBe(true)
    expect(imReplyAwaitsAnswer('确认一下' + '😀'.repeat(24))).toBe(false)
    expect(imReplyAwaitsAnswer('可以吗？😀')).toBe(true)
    expect(imReplyAwaitsAnswer('普通说明，没有问题。')).toBe(false)
  })
})
