/** 交互存储端口授权并读取选项后，统一生成前端事件。 */
export function projectAgentInteraction(input: {
  runId: string
  prompt: {
    id: number
    session_id: number
    kind: string
    title: string
    body: string
    expires_at: string | Date
    created_at: string | Date
  }
  schema: Record<string, unknown>
  active: boolean
  options: Array<{ id: string; label: string; token: string }>
  selected: string | null
}) {
  const { runId, prompt, schema, active, options, selected } = input
  const context = object(schema.context)
  const resolved = object(schema.resolved_result)
  return {
    type: 'interaction_required' as const, prompt_id: prompt.id, session_id: prompt.session_id, core_run_id: runId,
    kind: prompt.kind, title: prompt.title, body: prompt.body,
    tool_call_id: typeof context.tool_call_id === 'string' ? context.tool_call_id : null,
    task_paused: prompt.kind === 'confirm',
    options: active ? options : readResolvedChoiceOptions(prompt.kind, schema),
    secret_fields: Array.isArray(schema.secret_fields) ? schema.secret_fields : [],
    allow_text_input: schema.source === 'agent' && Boolean(schema.allow_text_input),
    custom_input_active: Boolean(schema.custom_input_active), resolved: !active, selected_option_id: selected,
    ...(schema.selection_mode === 'multiple' ? { selection_mode: 'multiple', selected_option_ids: resolved.selected_option_ids } : {}),
    custom_answer: typeof resolved.custom_answer === 'string' ? resolved.custom_answer : undefined,
    response_text: typeof resolved.text === 'string' ? resolved.text : null,
    expires_at: new Date(prompt.expires_at).toISOString(), created_at: new Date(prompt.created_at).toISOString(),
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** 已结束的普通提问保留原选项，且不发放动作令牌。 */
export function readResolvedChoiceOptions(kind: string, schema: Record<string, unknown>) {
  const context = object(schema.context)
  if ((kind !== 'choice' && kind !== 'question') || schema.source !== 'agent' ||
    context.tool_name !== 'ask_user' || context.command_action || !Array.isArray(schema.options)) return []
  return schema.options.flatMap(item => {
    const option = object(item)
    if (option.action_type !== 'choice' || typeof option.id !== 'string' || typeof option.label !== 'string') return []
    return [{ id: option.id, label: option.label, token: '' }]
  })
}
