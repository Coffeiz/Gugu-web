const events = new Map(Object.entries({
  'agent.tools.shell_unavailable': '当前任务未装配 Shell',
  'host.started': 'Web 后端已启动',
  'host.stopped': 'Web 后端已停止',
  'host.start_failed': 'Web 后端启动失败',
  'host.stop_failed': 'Web 后端停止失败',
  'host.shutdown_requested': 'Web 后端收到关闭请求',
  'host.shutdown_phase_started': '开始关闭',
  'host.shutdown_phase_finished': '关闭完成',
  'host.shutdown_phase_slow': '关闭耗时较长',
  'host.shutdown_phase_failed': '关闭失败',
  'host.database_unavailable': '数据库不可用',
  'host.rag_unavailable': '知识检索不可用',
  'host.trash_purge_unavailable': '回收站清理不可用',
  'host.search_usage_unavailable': '搜索用量统计不可用',
  'gateway.started': '消息网关已启动',
  'gateway.stopped': '消息网关已停止',
  'gateway.start_failed': '消息网关启动失败',
  'gateway.stop_failed': '消息网关停止失败',
  'gateway.degraded': '消息网关运行异常',
  'gateway.rag_timeout': '消息知识检索超时',
  'gateway.rag_late_completion': '消息知识检索超时后完成',
  'sandbox.probe_failed': '沙箱探测失败',
  'sandbox.command_failed': '沙箱命令执行失败',
  'sandbox.system_completed': '系统命令执行结束',
  'agent.run.started': '开始执行任务',
  'agent.run.resumed': '恢复执行任务',
  'agent.run.continued': '继续执行任务',
  'agent.run.finished': '任务执行结束',
  'agent.run.failure': '任务执行失败',
  'agent.run.round_limit': '任务达到轮次上限',
  'agent.run.finalization_failed': '任务收尾失败',
  'agent.runtime.failure': '任务运行异常',
  'agent.provider.retry': '重试模型请求',
  'agent.provider.error': '模型调用失败',
  'agent.provider.incomplete': '模型响应未完成',
  'agent.provider.empty': '模型响应为空',
  'agent.provider.round_result': '收到本轮模型响应',
  'agent.context.compaction_failed': '上下文压缩失败',
  'agent.context.compaction_skipped': '已跳过上下文压缩',
  'agent.context.overflow_recovery': '正在恢复超限的上下文',
  'agent.tools.parallel_batch': '并行执行工具',
  'agent.tools.serial_batch': '串行执行工具',
  'agent.tools.invocation': '工具调用结果',
  'agent.tools.dispatch_failed': '工具调度失败',
  'agent.tools.schema_error': '工具参数校验失败',
  'agent.reply_gate.blocked': '回复被拦截',
  'agent.interaction.confirm_replay_failed': '确认操作重放失败',
  'agent.interaction.activation_failed': '交互请求激活失败',
  'agent.interaction.result_missing': '交互结果缺失',
}))

const shutdownPhases = new Map(Object.entries({
  http: 'HTTP 服务',
  gateway: '消息网关',
  account_memory: '账号记忆',
  workers: '后台工作线程',
  scheduled_runs: '定时任务',
  agent_runs: '运行中的任务',
  mcp: 'MCP 连接',
  embedding_rebuild: '向量重建',
  embedding_transport: '向量服务连接',
  loopscope: 'LoopScope',
  loopscope_transport: 'LoopScope 连接',
  im_transports: '即时通信连接',
  im_delivery_pool: '即时通信投递连接池',
  project_journal_pool: '项目日志连接池',
  core: '核心服务',
  postgres_pool: 'PostgreSQL 连接池',
}))

const providerStages = new Map(Object.entries({
  prepare: '构造请求', transport: '建立连接或传输', http: '检查 HTTP 响应',
  decode: '解析响应', stream: '读取响应流', continuation: '续接模型调用',
}))

const conditions = new Map(Object.entries({
  im_provider_failed: 'IM 模型调用失败', im_run_failed: 'IM 任务执行失败', dispatch_unavailable: '消息调度不可用',
  im_model_unavailable: '即时通讯缺少默认模型，消息等待处理',
  'wechat-typing-ticket-unavailable': '微信输入状态不可用，继续处理消息',
  migration_incompatible: '数据库迁移版本不兼容', migration_pending: '数据库迁移尚未执行',
  migration_unavailable: '无法检查数据库迁移状态', platform_unsupported: '当前平台不支持',
}))

export function eventMessage(record) {
  const label = events.get(record?.event)
  if (!label) return undefined
  const attributes = record.attributes ?? {}
  const phase = record.event.startsWith('host.shutdown_phase_') && shutdownPhases.get(attributes.phase)
  const details = [
    phase || undefined,
    ['SIGINT', 'SIGTERM'].includes(attributes.signal) ? attributes.signal : undefined,
    Number.isSafeInteger(attributes.elapsedMs) ? `耗时 ${attributes.elapsedMs} 毫秒` : undefined,
    Number.isSafeInteger(record.round) ? `第 ${record.round} 轮` : undefined,
    conditions.get(attributes.code),
    providerStages.get(attributes.providerStage),
    Number.isInteger(attributes.httpStatus) && attributes.httpStatus >= 100 && attributes.httpStatus <= 599
      ? `HTTP ${attributes.httpStatus}` : undefined,
  ].filter(Boolean)
  return [label, ...details].join(' · ')
}

/** 历史和实时日志共用中文摘要，原始行保留用于检索。 */
export function logLineMessage(line) {
  const body = line.replace(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s*/, '').trim()
  if (body.startsWith('{')) {
    try { return eventMessage(JSON.parse(body)) } catch { return undefined }
  }
  if (/^\(node:\d+\) ExperimentalWarning: FFI/.test(body)) return 'Node.js FFI 仍为实验性功能，后续版本可能变更'
  if (/^\(node:\d+\) \[DEP0205\] DeprecationWarning:/.test(body)) return 'Node.js 已弃用 module.register()，请改用 module.registerHooks()'
  if (/^\(Use `node --trace-(?:warnings|deprecation) /.test(body)) return '可启用 Node.js 警告堆栈追踪以定位来源'
}
