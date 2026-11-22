const contactToolAliases = new Map([
  ['list_clients', 'list_contacts'],
  ['create_client', 'create_contact'],
  ['update_client', 'update_contact'],
  ['delete_client', 'delete_contact'],
])

export function canonicalAgentToolName(name: string): string {
  return contactToolAliases.get(name) ?? name
}

const CONFIGURED_AGENT_TOOL_NAMES = new Set([
  'shell', 'view_image', 'present_file', 'send_file', 'save_attachment', 'list_recent_attachments', 'delete_folder', 'delete_file', 'list_trash', 'restore_file', 'restore_folder', 'permanent_delete',
  'search_conversations', 'search_memory', 'remember', 'read_conversation', 'get_current_time', 'get_upcoming',
  'list_events', 'list_scheduled_tasks', 'create_scheduled_task', 'update_scheduled_task', 'delete_scheduled_task', 'list_workspaces', 'get_workspace',
  'list_contacts', 'create_contact', 'update_contact', 'list_projects', 'get_project', 'create_project', 'update_project', 'delete_project', 'delete_contact',
  'set_color', 'archive_project', 'add_stage', 'remove_stage', 'rename_stage', 'set_stages', 'update_stage',
  'canvas_list', 'canvas_get', 'canvas_search', 'canvas_focus_node', 'canvas_search_placeable', 'canvas_create', 'canvas_create_note', 'canvas_add_node', 'canvas_update_node', 'canvas_remove_node',
  'canvas_update_note', 'canvas_update_anchor', 'canvas_connect', 'canvas_delete', 'canvas_delete_note', 'canvas_disconnect', 'canvas_batch',
  'note_search', 'note_get', 'note_delete', 'note_restore', 'note_undo', 'use_skill', 'list_skills', 'create_skill', 'update_skill', 'delete_skill', 'note_create', 'note_update', 'ask_user',
  'search_tools', 'call_tool', 'manage_mcp_servers', 'web_search', 'web_download', 'http_get', 'similar_image_search', 'deep_research', 'send_link_buttons', 'send_email',
  'read_knowledge', 'save_knowledge', 'update_knowledge', 'delete_knowledge', 'global_search', 'create_workspace', 'update_workspace', 'unlink_workspace', 'delete_workspace_directory',
  'agent_message', 'agent_inbox', 'agent_cancel', 'agent_inspect',
  'undo_last_action', 'create_event', 'update_event', 'delete_event',
])

/** Web 和桌面共享静态 Agent 工具白名单；动态 MCP 名称仍需由当前 Host 注册器验证。 */
export function filterConfiguredAgentTools(names: readonly string[]): string[] {
  return [...new Set(names.map(canonicalAgentToolName))].filter(name => CONFIGURED_AGENT_TOOL_NAMES.has(name)
    || (name.length <= 64 && /^mcp_[A-Za-z0-9_]+_[A-Za-z0-9_]+$/u.test(name)))
}
