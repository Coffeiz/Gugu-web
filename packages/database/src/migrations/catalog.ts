import { agentChatReceipts } from './0050_agent_chat_receipts.js'
import { conversationRoleSequence } from './0049_conversation_role_sequence.js'

import { ragSnapshotGeneration } from './0051_rag_snapshot_generation.js'

import { contactAddress } from './0052_contact_address.js'

import { scheduledShellGrants } from './0053_scheduled_shell_grants.js'

export const logicalMigrations = [conversationRoleSequence, agentChatReceipts, ragSnapshotGeneration, contactAddress, scheduledShellGrants] as const
