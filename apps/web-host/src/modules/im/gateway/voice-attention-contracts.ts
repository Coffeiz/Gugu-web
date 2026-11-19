import type { RunIdentity } from '@gugu/core/agent'
import type { ImActor } from '@gugu/core/im/access'
import type { ImAudioInput } from './message-materializer.js'
import type { ImAttachmentScope } from './attachment-ingress.js'
import type { ImAttentionCandidate } from './attention-runtime.js'
import type { ImPendingAskScope } from './pending-ask.js'

/** 只含永久消息/附件身份；原生平台消息ID与正文不进入明文ASR收据。 */
export interface ImAttentionVoiceIdentity {
  ownerId: string; platform: ImAttachmentScope['platform']; botId: string
  sessionId: string; messageId: string; attachId: string; scopeHash: string; eventHash: string; eventId: string
}
/** 只能由可信Host源构造。assertCurrent重验started/passive段、密封事实、附件及当前账户/Bot。 */
export interface ImAttentionVoiceSource {
  identity: Readonly<ImAttentionVoiceIdentity>
  input: Readonly<ImAudioInput>
  /** passive只允许读已完成收据；不能在pending恢复时重新发起ASR。 */
  mayRequest: boolean
  assertCurrent(signal: AbortSignal): Promise<void>
}
export interface ImAttentionVoiceReadInput {
  scope: ImPendingAskScope; sessionId: number; candidates: readonly ImAttentionCandidate[]
}
/** Run复用仍需完整已派发消息证明，不能只凭模型/载荷给出的attach_id读取。 */
export interface ImVoiceRunProof {
  identity: RunIdentity; actor: ImActor; scope: ImAttachmentScope
  payload: Readonly<Record<string, unknown>>; messageIds: readonly string[]
  authorize(signal?: AbortSignal): Promise<boolean>
}
export interface ImAttentionVoiceResult {
  eventId: string; attachId: string; text: string | null
}
