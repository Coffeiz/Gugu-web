/** 内置工具的用户可见默认标签，沿用旧版注册器的短文案。 */
export const BUILTIN_AGENT_TOOL_STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  add_stage: '新增阶段',
  archive_project: '归档项目',
  ask_user: '询问用户',
  call_tool: '调用工具',
  canvas_add_node: '放置画布节点',
  canvas_batch: '批量编排画布',
  canvas_connect: '连接画布节点',
  canvas_create: '创建思维画布',
  canvas_create_note: '创建画布便签',
  canvas_delete: '删除思维画布',
  canvas_delete_note: '删除画布便签',
  canvas_disconnect: '断开画布连接',
  canvas_focus_node: '定位画布卡片',
  canvas_get: '读取思维画布',
  canvas_list: '列出思维画布',
  canvas_remove_node: '移除画布节点',
  canvas_search: '搜索画布内容',
  canvas_search_placeable: '搜索可放置画布节点',
  canvas_update_anchor: '调整画布连接点',
  canvas_update_node: '调整画布节点',
  canvas_update_note: '修改画布便签',
  create_client: '新建联系人',
  create_contact: '新建联系人',
  create_event: '新建日历事件',
  create_project: '新建项目',
  create_scheduled_task: '新建定时任务',
  create_skill: '创建咕咕技能',
  deep_research: '深度研究',
  delete_client: '删除联系人',
  delete_contact: '删除联系人',
  delete_event: '删除日历事件',
  delete_knowledge: '删除知识',
  delete_project: '删除项目',
  delete_scheduled_task: '删除定时任务',
  delete_skill: '删除咕咕技能',
  get_current_time: '获取当前时间',
  get_dashboard_stats: '总览统计',
  get_project: '项目详情',
  search_tools: '搜索工具',
  get_upcoming: '近期待办',
  get_workspace: '查看工作区',
  global_search: '站内全局搜索',
  list_clients: '查询联系人',
  list_contacts: '查询联系人',
  list_events: '查询日历事件',
  list_projects: '查询项目列表',
  list_scheduled_tasks: '查看定时任务',
  list_skills: '列出咕咕技能',
  list_trash: '查看回收站',
  list_workspaces: '查询工作区',
  manage_mcp_servers: '管理 MCP 服务',
  note_create: '记录思维笔记',
  note_delete: '删除思维笔记',
  note_get: '读取思维节点',
  note_restore: '恢复思维笔记',
  note_search: '搜索思维笔记',
  note_undo: '撤销刚才的咕咕记录',
  note_update: '更新思维笔记',
  read_conversation: '读历史对话',
  read_file: '读取文件',
  read_knowledge: '读取知识',
  remember: '记住',
  remove_stage: '删除阶段',
  rename_stage: '重命名阶段',
  restore_file: '还原文件',
  restore_folder: '还原文件夹',
  save_knowledge: '保存知识',
  search_conversations: '搜历史对话',
  search_memory: '搜索记忆',
  send_email: '发送邮件',
  send_link_buttons: '发送链接按钮',
  set_color: '设置项目颜色',
  set_stages: '整体设置阶段',
  similar_image_search: '以图搜图',
  update_client: '更新联系人',
  update_contact: '更新联系人',
  update_event: '更新日历事件',
  update_knowledge: '更新知识',
  update_project: '更新项目',
  update_scheduled_task: '更新定时任务',
  update_skill: '更新咕咕技能',
  update_stage: '更新阶段',
  update_workspace: '更新工作区',
  use_skill: '调用技能',
  web_download: '下载到文件库',
  web_search: '联网搜索',
})

export interface AgentStateLabelRow {
  key: string
  default: string
  custom: unknown
  label: unknown
}

export interface AgentStateLabelCatalog {
  special: AgentStateLabelRow[]
  tools: AgentStateLabelRow[]
}

function row(key: string, fallback: string, overrides: Readonly<Record<string, unknown>>): AgentStateLabelRow {
  const custom = overrides[key] ?? ''
  return { key, default: fallback, custom, label: custom || fallback }
}

/** Admin 状态名目录投影；工具标签稳定按工具名排序。 */
export function projectAgentStateLabelCatalog(
  specialDefaults: Readonly<Record<string, string>>,
  toolDefaults: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, unknown>>,
): AgentStateLabelCatalog {
  return {
    special: Object.entries(specialDefaults).map(([key, value]) => row(key, value, overrides)),
    tools: Object.entries(toolDefaults).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => row(key, value, overrides)),
  }
}

/** 与旧 Admin handler 一致：空值和等于默认值的覆盖不写入，未知 key 保留。 */
export function cleanAgentStateLabelOverrides(
  overrides: Readonly<Record<string, string>>,
  defaults: Readonly<Record<string, string>>,
): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [key, raw] of Object.entries(overrides)) {
    const value = raw.trim()
    if (!value || (Object.hasOwn(defaults, key) && value === defaults[key])) continue
    clean[key] = value
  }
  return clean
}
