export type AttentionMode = 'quiet' | 'natural' | 'active' | 'autonomous'

export interface AttentionInput {
  text: string
  anchor_text: string
  before_anchor: string[]
  after_anchor: string[]
  gap_seconds: number
  member_active_age_seconds?: number | null
  aliases: string[]
  mode: AttentionMode
  snapshot_complete: boolean
}

export interface AttentionDefaults {
  algorithm_version: string
  thresholds: Record<'quiet' | 'natural' | 'active', number>
  topic_ttl_seconds: number
  topic_half_life_seconds: number
  member_active_ttl_seconds: number
}

export interface AttentionResult {
  algorithm_version: string
  kind: 'ALLOW_RUN' | 'DIRECT' | 'CONTINUE' | 'CAPABILITY_ACTION' | 'MEMBER_ACTIVE' | 'PROACTIVE' | 'EXCLUDED' | 'PASSIVE'
  score: number | null
  threshold: number | null
  state: 'COLD' | 'TOPIC' | 'MEMBER_ACTIVE' | 'CAPABILITY_ACTION' | null
  scene_type: 'CALL' | 'ASK' | null
  scene_score: number
  ask_raw_score: number
  ask_position_weight: number
  ask_punctuation_weight: number
  ask_adjusted_score: number
  ask_span_start: number | null
  ask_span_end: number | null
  capability_strength: 'strong' | 'weak' | null
  capability_span_start: number | null
  capability_span_end: number | null
  capability_position_weight: number | null
  topic_score: number
  topic_raw_score: number
  reasons: string[]
  score_breakdown: { rule: string; weight: number }[]
  matched_span_lengths: [number, number] | null
  snapshot_complete: boolean
}
