import type { ToolDefinition } from '../tools/contracts.js'
import { imAllowsPrompt, imChannelInstruction } from './im/context.js'
import { imAllowsTool } from './im/tools.js'

export type AgentScene = 'default' | 'im'
const sceneVersions = { default: 1, im: 2 } as const

export function agentSceneFingerprint(scene: AgentScene = 'default') {
  return [scene, sceneVersions[scene]] as const
}

export function sceneAllowsPrompt(scene: AgentScene, block: string): boolean {
  return scene !== 'im' || imAllowsPrompt(block)
}

export function sceneAllowsTool(scene: AgentScene, name: string, delivery?: 'app_card' | 'native'): boolean {
  return scene !== 'im' || imAllowsTool(name, delivery)
}

export function sceneChannelPrompt(scene: AgentScene, smartView?: string): string | undefined {
  return scene === 'im' ? imChannelInstruction : smartView?.trim()
}

const imDeliveryChannels = new Set(['im', 'qq', 'wechat', 'feishu', 'telegram'])

/** 调度目的地决定呈现场景。身份和工具授权仍由运行入口复核。 */
export function selectScheduledAgentScene(channels: readonly string[] = [], groupChat = false): AgentScene {
  return groupChat || channels.some(channel => imDeliveryChannels.has(channel)) ? 'im' : 'default'
}

/** 后台使用同一业务工具目录；需要交互的操作由各自的持久确认端口接入。 */
export function sceneAllowsBackgroundTool(scene: AgentScene, tool: ToolDefinition, groupChat: boolean, hasPersistentConfirmation = false): boolean {
  return sceneAllowsTool(scene, tool.definition.name)
    && (!tool.destructive || hasPersistentConfirmation) && !tool.requiresInteraction && !tool.effectForInput
    && (!groupChat || tool.effect === 'read')
}
