const common = {
  list: '列出记录',
  create: '新建记录',
  update: '修改指定记录',
  delete: '删除指定记录',
}

export const objects: Record<string, { label: string; actions: Record<string, string> }> = {
  project: { label: '项目', actions: { ...common, delete: '移入回收站', get: '读取项目详情', restore: '从回收站恢复项目' } },
  calendar: { label: '日程', actions: common },
  note: { label: '笔记', actions: common },
  canvas: { label: '画布', actions: { ...common, items: '列出画布节点', relations: '列出画布连线' } },
  schedule: { label: '定时任务', actions: { ...common, get: '读取任务详情' } },
}

const examples: Record<string, Record<string, string>> = {
  project: { create: '{"name":"示例项目"}', update: '{"version":1,"name":"新项目名称"}' },
  calendar: {
    create: '{"title":"项目例会","date":"2027-01-15"}',
    update: '{"version":1,"title":"项目复盘"}',
    delete: '{"version":1}',
  },
  note: { create: '{"contentMd":"# 示例笔记"}', update: '{"version":1,"contentMd":"更新后的正文"}' },
  canvas: { create: '{"title":"示例画布"}', update: '{"title":"新画布标题"}' },
  schedule: {
    create: '{"name":"每日提醒","payload":"整理今日待办","schedule_kind":"cron","cron":"0 9 * * *","execution_mode":"reminder","channels":["web"]}',
    update: '{"name":"工作提醒"}',
  },
}

export function needsFields(object: string, action: string) {
  return action === 'create' || action === 'update' || (object === 'calendar' && action === 'delete')
}

export function renderHelp(object?: string, action?: string): string {
  if (!object) return [
    '咕咕 Desktop 命令行',
    '',
    '用法  gugu <对象> <命令> [参数]',
    '',
    ...Object.entries(objects).map(([name, spec]) => `  ${name.padEnd(10)} ${spec.label}`),
    '',
    '使用 gugu <对象> --help 查看命令。',
    '使用 gugu <对象> <命令> --help 查看参数和示例。',
    '安装版请先启动咕咕 Desktop。命令结果默认输出 JSON，也接受 --json。',
    '退出码  0 成功 / 1 请求失败 / 2 参数或配置错误 / 3 写入结果未确认',
  ].join('\n')

  const spec = Object.hasOwn(objects, object) ? objects[object] : undefined
  if (!spec || (action && !Object.hasOwn(spec.actions, action)))
    throw new Error('未知对象或命令，请查看 gugu --help')
  if (!action) return [
    `${spec.label}命令`, '', `用法  gugu ${object} <命令> [参数]`, '',
    ...Object.entries(spec.actions).map(([name, description]) => `  ${name.padEnd(10)} ${description}`),
    '', `使用 gugu ${object} <命令> --help 查看参数和示例。`,
  ].join('\n')

  const id = !['list', 'create'].includes(action)
  const fields = needsFields(object, action)
  const projectList = object === 'project' && action === 'list'
  const command = `gugu ${object} ${action}`
  const fieldHints: Record<string, string> = {
    'project:create': 'name 为项目名称。',
    'project:update': 'name 可用于重命名。',
    'calendar:create': 'title 为标题，date 使用 YYYY-MM-DD。',
    'calendar:update': '可修改 title、date 等日程字段。',
    'note:create': 'contentMd 为 Markdown 正文，可附 title。',
    'note:update': 'contentMd 为 Markdown 正文，也可修改 title 或 color。',
    'canvas:create': 'title 为画布标题。',
    'canvas:update': '可传 title 或 data 对象。',
    'schedule:create': 'schedule_kind 支持 cron、interval 和 once，分别搭配 cron、interval_minutes 或 start_at。',
    'schedule:update': '传入要修改的字段，例如 name。',
  }
  const hint = fieldHints[object + ':' + action]
  const suffix = [
    ...(id ? ['<ID>'] : []),
    ...(fields ? ['--fields <JSON>'] : []),
    ...(action === 'delete' ? ['--yes'] : []),
    ...(projectList ? ['[--archived | --deleted]', '[--offset N]'] : []),
  ]
  return [
    spec.actions[action], '', ['用法 ', command, ...suffix].join(' '), '',
    ...(id ? ['  ID            正整数。先用 list 查询对象 ID。'] : []),
    ...(fields ? ['  --fields JSON 必填。传入一个 JSON 对象，示例展示常用字段。'] : []),
    ...(hint ? ['                ' + hint] : []),
    ...(action === 'delete' ? ['  --yes         显式确认删除。'] : []),
    ...(projectList ? ['  --archived    查看归档项目。', '  --deleted     查看回收站。', '  --offset N    用上页返回的 nextOffset 继续查询。'] : []),
    ...(fields && (['project', 'note'].includes(object) && action === 'update' || object === 'calendar' && action !== 'create')
      ? ['  version       填入刚查询到的当前版本号。'] : []),
    '', '示例',
    '  ' + command + (id ? ' 12' : '') + (fields ? ` --fields '${examples[object][action]}'` : '') + (action === 'delete' ? ' --yes' : ''),
  ].join('\n')
}
