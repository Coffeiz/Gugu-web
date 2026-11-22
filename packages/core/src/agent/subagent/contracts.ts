import type { RunIdentity } from '../models.js'

export interface DelegatedAgentInput {
  task: string
  resourceRefs?: readonly string[]
  allowBackgroundReport?: boolean
}

export interface DelegatedAgentLaunch {
  identity: RunIdentity
  workspaceFingerprint?: string
  childId?: string
  previousRunId?: string
  parent: RunIdentity
  input: DelegatedAgentInput
  modelIdentity: string
}

export type DelegatedAgentOutcome =
  | { status: 'completed' | 'partial'; finalMessage: string; reportRef?: string }
  | { status: 'failed' | 'cancelled'; reasonCode: string }
