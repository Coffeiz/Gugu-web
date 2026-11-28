import type { AttentionKind, AttentionMode } from './types.js'

/** 可信注意力决策的最小持久事实；不接受模型或平台载荷直接声明。 */
export interface ImAttentionRecord {
  v: 1
  disposition: 'run' | 'passive' | 'pending'
  mode: AttentionMode
  configVersion: number
  subjectEventId: string | null
  sourceAttentionKind: string | null
  proactive: boolean
  replyChoice: 'pending' | 'reply'
}
const kinds: Partial<Record<AttentionKind, string>> = {
  DIRECT: 'DIRECT', CONTINUE: 'member_CONTINUE', CAPABILITY_ACTION: 'CAPABILITY_ACTION',
  MEMBER_ACTIVE: 'member_ACTIVE', PROACTIVE: 'proactive', ALLOW_RUN: 'autonomous',
}
export function attentionSourceKind(kind: AttentionKind | undefined): string | null { return kind ? kinds[kind] ?? null : null }
export function isAttentionSourceKind(value: unknown): value is string {
  return typeof value === 'string' && Object.values(kinds).includes(value)
}
export function parseImAttentionRecord(value: unknown): ImAttentionRecord {
  const fail = () => { throw new TypeError('IM 注意力事实无效') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const r = value as Record<string, unknown>
  const fields = ['v', 'disposition', 'mode', 'configVersion', 'subjectEventId', 'sourceAttentionKind', 'proactive', 'replyChoice']
  if (Object.keys(r).length !== fields.length || Object.keys(r).some(k => !fields.includes(k)) || r.v !== 1
    || !['run', 'passive', 'pending'].includes(String(r.disposition)) || !['quiet', 'natural', 'active', 'autonomous'].includes(String(r.mode))
    || !Number.isSafeInteger(r.configVersion) || Number(r.configVersion) < 0
    || !(r.subjectEventId === null || typeof r.subjectEventId === 'string' && /^\d+-\d+$/u.test(r.subjectEventId))
    || !(r.sourceAttentionKind === null || Object.values(kinds).includes(String(r.sourceAttentionKind)))
    || typeof r.proactive !== 'boolean' || !['pending', 'reply'].includes(String(r.replyChoice))
    || r.proactive !== (r.sourceAttentionKind === 'proactive')
    || r.disposition === 'run' && (!r.subjectEventId || !r.sourceAttentionKind || r.replyChoice !== 'pending')
    || r.disposition !== 'run' && r.replyChoice !== 'reply') return fail()
  return { ...r } as unknown as ImAttentionRecord
}
