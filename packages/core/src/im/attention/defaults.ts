import { ATTENTION_ALGORITHM_VERSION, ATTENTION_THRESHOLDS, MEMBER_ACTIVE_TTL_MS } from './types.js'

export interface AttentionDefaults {
  algorithm_version: string
  thresholds: { quiet: number; natural: number; active: number }
  topic_ttl_seconds: number
  topic_half_life_seconds: number
  member_active_ttl_seconds: number
}

/** Python dev-attention defaults shared with the Web sandbox. */
export function getAttentionDefaults(): AttentionDefaults {
  return {
    algorithm_version: ATTENTION_ALGORITHM_VERSION,
    thresholds: { ...ATTENTION_THRESHOLDS },
    topic_ttl_seconds: 600,
    topic_half_life_seconds: 360,
    member_active_ttl_seconds: MEMBER_ACTIVE_TTL_MS / 1_000,
  }
}
