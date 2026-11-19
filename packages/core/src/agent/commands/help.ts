import { agentCommandMenu } from './menu.js'
import { strip } from '../../shared/values.js'

/** 帮助只描述命令；Host必须按当前入口已接通的能力传入available，不能用目录代替执行实现。 */
const details: Readonly<Record<string, string>> = {
  stop: '停止当前正在运行的任务。\n/stop　停止当前任务\n别名：/s、/cancel、/x',
  status: '查看当前任务所处阶段。\n/status　查看当前任务状态\n别名：无',
  compact: '立即整理当前会话的旧历史，不创建新会话。\n/compact　整理当前会话上下文\n别名：无',
  goal: '创建一个持续推进直到完成的目标任务。\n/goal <目标>　创建目标任务\n/goal status　查看目标状态\n/goal pause　暂停目标任务\n/goal resume　恢复目标任务\n/goal cancel　取消目标任务\n别名：无',
  new: '清空当前会话的消息、摘要、快照和已加载能力，开始一段新的对话。保留当前会话的工作区绑定、用户设置和权限配置。\n/new　开始新对话\n别名：无',
  memory: '查看咕咕保存的个人长期记忆。\n/memory　查看已保存记忆\n别名：/mem',
  forget: '删除与指定内容匹配的个人记忆。\n/forget <内容>　删除匹配的记忆\n示例：/forget I like coffee\n别名：无',
  workspace: '管理当前会话的工作区绑定和文件系统授权，也可以删除工作区声明。\n/workspace show　查看当前绑定\n/workspace status　查看沙箱权限状态\n/workspace god　申请完整用户沙箱权限\n/workspace revoke　撤销完整用户沙箱权限\n/workspace list　列出可绑定工作区\n/workspace <ID>　绑定指定工作区\n/workspace unlink　解除当前会话绑定\n/workspace delete <ID>　删除工作区（随后确认/取消）\n/workspace delete <ID> confirm　确认删除工作区\n解除只取消当前会话绑定；删除会解除所有会话绑定，但不会删除项目或文件。',
  auto: '查看或切换当前用户的自动模式。无参数只查看状态；管理员未开放时不能开启。\n/auto status　查看状态\n/auto on　开启自动模式\n/auto off　关闭自动模式\n自动模式只跳过普通操作确认；权限授权和强制确认仍需你确认。',
  help: '查看全部斜杠命令。\n/help　查看全部命令\n/<command> help　查看指定命令的详细说明',
}

export function isAgentCommandHelpArgument(value: string): boolean { return ['help', '?', '？'].includes(strip(value).toLowerCase()) }

export function agentCommandHelp(name: string, available: readonly string[]): string {
  const menu = agentCommandMenu().filter(item => available.includes(item.command.slice(1)))
  if (name && Object.hasOwn(details, name))
    return menu.some(item => item.command === `/${name}`) ? details[name]! : `当前入口尚未提供 /${name} 命令。`
  return ['🤖 当前入口可用命令：', ...menu.map(item => `${item.command}　${item.description}；发送 ${item.command} help 查看说明`)].join('\n')
}
