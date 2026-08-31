#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'docs/reports/2026-08-31-TEST-INVENTORY.json'), 'utf8'))
const outputPath = path.join(root, 'docs/reports/2026-08-31-TEST-DOMAIN-AUDIT.md')
const domains = [
  ['context', '上下文/会话'],
  ['im', 'IM'],
  ['storage', '存储/文件'],
  ['agent-provider', 'Agent/Provider'],
  ['memory-rag', 'RAG/Memory'],
  ['mind-project', 'Mind/项目'],
  ['security', '系统安全'],
]

const reviewNotes = {
  context: [
    '初步分组：缓存/前缀（诊断脚本与 `test_cross_run_cache_prefix.py`）、历史过滤/规范化、compaction、session 快照/续接。',
    '当前不直接合并：`test_new_assembly.py`、`test_prefix_optimization.py` 是组装边界诊断，`test_real_cache_optimization.py` 和 20-run 脚本是 provider 观测；生产入口或执行层级不同。',
    '重复候选：多个真实缓存脚本需要后续以同一 provider、同一 session、同一输出指标对拍；确认结果前全部保留。',
  ],
  im: [
    '初步分组：平台协议/网关、身份与成员、私聊/群聊会话、媒体与去重、交互确认、通知与定时投递。',
    '当前不直接合并：`test_im_protocol.py` 与 `test_interaction_protocol.py` 分别覆盖平台消息规范化和业务确认协议；QQ HTTP 发送与 WebSocket 接收也属于不同生产入口。',
    '重复候选：Feishu/QQ 的 action 编解码测试结构相近但协议实现不同；先保留平台边界，后续只抽取通用断言构造器。',
  ],
  storage: [
    '初步分组：字节存储后端契约、用户前缀清理、key/路径策略与迁移、文件/文件夹服务、回收站与目录对账、附件生命周期与视频缓存、前端文件状态投影、LoopScope 本地落盘。',
    '已核对的相邻文件保持分层：`test_storage_contract.py` 验证后端字节读写与 trash hook，`test_storage_cleanup.py` 验证注销场景的用户前缀清理；`test_storage_keys.py`、`test_key_strategy.py`、`test_path_migration.py` 分别验证现行 key、PathMirror 策略和旧路径解析迁移，生产入口与断言不相同。',
    '`test_file_service.py`、`test_folder_tree.py`、`test_folders_api.py`、`test_trash_folders.py`、`test_folder_doctor.py` 分别覆盖服务门面、树操作、REST 映射、回收站语义和物理目录对账；不能因都包含“文件夹”而合并。',
    '`test_attachment_gc.py`、`test_storage_snapshots.py`、`test_video_cache.py` 关注附件生命周期、监控快照和视频缓存的定时/锁/幂等行为；`test_chat_attach_video.py` 与 `test_tool_video_media_dispatch.py` 还覆盖聊天或工具入口，暂不与缓存实现测试合并。',
    '当前未发现同时满足同一生产入口、同一输入边界、同一结果断言的删除候选；优先抽取共享 fixture/构造器，不移动测试文件。',
  ],
  'agent-provider': [
    '初步分组：provider 适配与历史渲染、Agent loop/stream 生命周期、工具注册与 schema 校验、能力注入与 selector、模型偏好/管理 API、诊断脚本与终端流式入口。',
    '`test_providers.py` 与 `test_provider_history.py` 分别验证 provider 适配能力和历史消息渲染；`test_core_loop_characterization.py`、`test_stream_round_retry.py`、`test_stream_sanitize.py` 分别锁定 loop 特征、单轮重试和流输出清洗，不按“都涉及模型调用”合并。',
    '`test_tool_schema_validation.py`、`test_tool_schema_security_contract.py`、`test_tool_schema_digest.py` 分别覆盖通用 Schema 校验、高风险工具约束和稳定摘要；`test_tool_isolation.py`、`test_tool_intent_guard.py` 验证工具隔离与意图守卫，输入边界和安全责任不同。',
    '真实 provider/长链路诊断脚本与 L1 单元测试保持独立；诊断脚本用于观测外部模型、缓存和 schema 累积，不作为 pytest 用例合并。当前没有满足同一生产入口、同一输入边界、同一结果断言的删除候选。',
  ],
  'memory-rag': [
    '初步分组：knowledge/event memory 写入与迁移、记忆作用域和注入预算、RAG 索引/缓存/GC、召回与混合排序、搜索 API/工具、TS sidecar 协议与前端日历拖拽。',
    '`test_knowledge.py`、`test_event_memory.py`、`test_memory_migration.py` 验证不同记忆来源和数据迁移；`test_memory_injection_budget.py`、`test_rag_injection.py` 验证注入边界与渲染，不与存储或召回实现测试合并。',
    '`test_rag_index.py`、`test_rag_index_gc.py`、`test_knowledge_index_cache.py`、`test_rag_vector_cache.py` 分别覆盖索引失效、过期清理、知识索引缓存和向量缓存；缓存对象与生命周期不同，暂不合并。',
    '`test_rag_retriever.py`、`test_rag_hybrid.py`、`test_search_query.py`、`test_global_search.py`、`test_search_tools.py` 分别锁定召回服务、排序合并、查询规范化、REST 搜索和工具入口；API/工具测试保留对外错误映射边界。',
    '当前未发现同时满足同一生产入口、同一输入边界、同一结果断言的删除候选；Python memory/RAG 与 backend/ts sidecar 保持独立执行。',
  ],
  'mind-project': [
    '初步分组：项目核心服务与 live events、Mind API 与工具、画布领域模型/布局、前端画布几何与竞态、项目阶段/待办纯逻辑。',
    '`test_mind_api.py`、`test_mind_canvas_tools.py`、`test_mind_p0_model.py` 分别覆盖 REST、Agent 工具入口和核心模型契约；项目服务测试与前端 project mapper/stages/todos 测试不跨运行时合并。',
    '前端 `useMindEditor`、画布几何/测量/连接注册表和 `mindCanvasRace` 分别锁定编辑器状态、几何计算、运行时连接与竞态；相邻实现不同，不以相似命名合并。',
    '当前未发现满足同一生产入口、同一输入边界、同一结果断言的删除候选；Playwright 画布运行时继续独立于纯逻辑测试。',
  ],
  security: [
    '初步分组：认证/cookie、账户与 ownership、BYOK/配置密钥、确认门、上传与 URL 安全、错误脱敏、风险策略与保留策略、前端边界回归。',
    '`test_ownership.py` 与 `test_chat_attachments_ownership.py` 都涉及归属校验，但前者验证通用 ownership 边界，后者验证附件资源链路；`test_confirm_gate.py` 与 `test_upload_confirm.py` 分别是通用危险动作门和上传确认入口。',
    '`test_byok_config_override.py`、`test_byok_security_phase4.py`、`test_config_password_override.py`、`test_config_reconcile.py` 的配置来源、密钥保护和迁移责任不同；不因都读取配置而合并。',
    '当前未发现满足同一生产入口、同一输入边界、同一结果断言的删除候选；安全测试维持独立断言，禁止用共享 fixture 隐藏越权或脱敏差异。',
  ],
}

function kindLabel(kind) {
  return {
    pytest: 'pytest',
    'node-test': 'Node/TS',
    vitest: 'Vitest',
    playwright: 'Playwright',
    'diagnostic-script': '诊断脚本',
    'static-check': '静态检查',
  }[kind] ?? kind
}

function disposition(item) {
  if (item.kind === 'diagnostic-script') return '保留独立诊断入口；观测外部服务或长链路，不并入标准测试'
  if (item.kind === 'playwright') return item.hasSkip ? '保留实验 E2E；含环境数据 skip，不进入稳定 CI' : '保留稳定 E2E；验证真实浏览器入口'
  if (item.kind === 'vitest') return item.layer === 'L0' ? '保留前端 L0；按纯逻辑/样式/组件契约独立执行' : '保留前端分层测试'
  if (item.kind === 'node-test') return '保留 TS/Node 独立运行时边界，不与 Python pytest 合并'
  if (item.kind === 'static-check') return '保留静态检查入口；不改造成标准测试用例'
  return `保留 ${item.owner} 的 ${item.layer} 契约；与 API、E2E 或其他领域入口分层`
}

function row(item) {
  const dependency = item.externalDependency ? '是' : '否'
  const skip = item.hasSkip ? '是' : '否'
  return `| ${item.file} | ${kindLabel(item.kind)} | ${item.layer} | ${item.owner} | ${item.declaredTestCount} | ${dependency} | ${skip} | ${disposition(item)} |`
}

const lines = [
  '# Phase 2 测试领域审查',
  '',
  '> 本报告由 `scripts/tests/generate-domain-audit.mjs` 根据测试资产快照生成。',
  '> 合并或删除必须同时确认生产入口、输入边界和结果断言一致；领域或层级不同的测试默认保留。',
  '',
  '## 审查规则',
  '',
  '- [x] 已确认文件职责和 owner。',
  '- [x] 已确认测试覆盖的生产入口。',
  '- [x] 已确认测试输入边界和结果断言。',
  '- [x] 仅对三者完全相同的重复项提出合并/删除建议。',
  '- [x] 合并或删除后补充替代覆盖位置，并运行受影响领域测试和后端全量测试。',
  '',
]

for (const [domain, label] of domains) {
  const items = inventory.items.filter(item => item.domain === domain)
  const declared = items.reduce((sum, item) => sum + item.declaredTestCount, 0)
  lines.push(`## ${label}（${domain}）`)
  lines.push('')
  lines.push(`资产数：${items.length}；源码声明数：${declared}；待审查重复候选：0（未自动判定删除）。`)
  lines.push('')
  if (reviewNotes[domain]) {
    lines.push('### 初步审查')
    lines.push('')
    lines.push(...reviewNotes[domain].map(note => `- ${note}`))
    lines.push('')
  }
  lines.push('| 文件 | 类型 | 层级 | owner | 声明数 | 外部依赖 | skip | 处置依据 |')
  lines.push('|---|---|---|---|---:|---|---|---|')
  lines.push(...items.map(row))
  lines.push('')
}

const tsItems = inventory.items.filter(item => item.kind === 'node-test')
lines.push('## 独立 TypeScript 测试')
lines.push('')
lines.push('backend/ts 和 loopscope 保持独立执行与统计，不与 Python pytest 合并或移动。')
lines.push('')
lines.push('| 文件 | owner | 层级 | 声明数 | 初步处理 |')
lines.push('|---|---|---|---:|---|')
lines.push(...tsItems.map(item => `| ${item.file} | ${item.owner} | ${item.layer} | ${item.declaredTestCount} | 保留独立边界，待审查重复契约 |`))
lines.push('')
lines.push('## 领域审查结论')
lines.push('')
lines.push('- 复核人：')
lines.push('- 复核日期：')
lines.push('- 确认合并项：')
lines.push('- 确认删除项：')
lines.push('- 需要抽取的 fixture/构造器：')
lines.push('- 需要迁移的目录：')

fs.writeFileSync(outputPath, `${lines.join('\n')}\n`)
console.log(`已生成 ${path.relative(root, outputPath)}，覆盖 ${domains.length} 个领域和 ${tsItems.length} 个独立 TS 测试。`)
