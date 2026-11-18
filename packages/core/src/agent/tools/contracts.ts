import type { PreparedToolDefinition, RunIdentity, ToolCall, ToolResult } from '../models.js'
import type { ToolPort } from '../ports.js'

export type ToolScope = Parameters<ToolPort['dispatch']>[1]

/** 定义与实现由可信 Host 装配；参数不包含 owner、授权根或确认凭据。 */
export interface ToolDefinition {
  readonly definition: PreparedToolDefinition
  readonly effect: 'read' | 'write'
  /** 复合工具可按已验证动作区分查询取消与写入结果未知。 */
  effectForInput?(input: unknown): 'read' | 'write'
  /** 危险工具默认关闭，须由可信组合根接入确认门。 */
  readonly destructive?: boolean
  /** 仅作调度分流，不能替代 handler 内的可信交互/确认门。 */
  readonly requiresInteraction?: boolean
  /** 仅确认恢复会重放且已由 Run 收据绑定的交互；handler 仍须验证可信意图/receipt 后才能产生副作用。 */
  readonly confirmationReplay?: boolean
  /** 按字段名禁止数组结构修复；仍允许合法 JSON 数组文本归一。 */
  readonly strictArrayFields?: readonly string[]
  validate(input: unknown): { success: true; data: unknown } | { success: false; error?: unknown }
  execute(input: unknown, scope: ToolScope, call: ToolCall): Promise<ToolResult>
  /** 仅恢复已提交收据；没有领域查询能力时保持unknown。 */
  reconcile?(input: unknown, identity: RunIdentity & { readonly roundId: string }, call: ToolCall): Promise<ToolResult>
}

/** 工具领域分组，不是可供模型按需加载正文的 Skill。 */
export interface ToolGroupDefinition {
  readonly id: string
  readonly name: string
  readonly tools: readonly ToolDefinition[]
}

export interface ToolRegistryConfiguration {
  readonly tools?: Readonly<Record<string, boolean>>
  readonly groups?: Readonly<Record<string, boolean>>
}

export interface ToolRegistryOptions {
  readonly tools?: readonly ToolDefinition[]
  readonly groups?: readonly ToolGroupDefinition[]
  readonly configuration?: ToolRegistryConfiguration
  readonly maxConcurrency?: number
  /** 定时执行等已预先确认的工具，执行器必须在持久认领时再次校验授权。 */
  readonly preauthorizedDestructiveTool?: ToolDefinition
  /** 仅用于缺年份的旧日期输入；未提供时不猜测年份。 */
  normalizationYear?(identity: RunIdentity): number
  /** 每次发现与执行重新判权；可结合平台能力及最新授权状态。 */
  authorize(identity: RunIdentity, name: string): Promise<boolean>
}
