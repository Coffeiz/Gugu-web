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

export { createGreetingScene, createGreetingGenerator } from './greeting/index.js'
export { assembleScheduledTaskContext, createScheduledTaskRunToolPorts } from './task/index.js'
export { assembleOwnerReflectionInput } from './reflection/index.js'
