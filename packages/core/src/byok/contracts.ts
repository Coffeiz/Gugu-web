import { z } from 'zod'

export const byokCapability = z.enum(['llm', 'embedding', 'speech_to_text', 'deep_research', 'similar_image_search'])
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const fields = z.object({
  provider: z.string().trim().min(1).max(64),
  api_format: z.string().max(32),
  base_url: z.string().max(500),
  model: z.string().max(200),
})
const secret = z.string().max(20_000)
export const byokSummary = fields.extend({
  id,
  capability: byokCapability,
  enabled: z.boolean(),
  has_value: z.boolean(),
})
export const byokList = z.object({
  enabled: z.literal(true),
  status: z.enum(['ready', 'needs_reconfigure']),
  items: z.array(byokSummary),
})
export const byokTest = z.object({ ok: z.boolean() })
export const byokCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('create'), input: fields.extend({ capability: byokCapability, value: secret }) }),
  z.object({ action: z.literal('update'), id, input: fields.extend({ value: secret }).partial() }),
  z.object({ action: z.literal('test'), id }),
  z.object({ action: z.literal('bind'), id }),
  z.object({ action: z.literal('delete'), id }),
])

export const byokTarget = z.object({ origin: z.string().max(2048), accountId: z.string().uuid() })
export type ByokTarget = z.infer<typeof byokTarget>
export type ByokSummary = z.infer<typeof byokSummary>
export type ByokCommand = z.infer<typeof byokCommand>
export type ByokResult = z.infer<typeof byokList> | ByokSummary | z.infer<typeof byokTest> | null

const desktopAuxiliaryCapability = z.enum(['embedding', 'speech_to_text'])
const desktopAuxiliaryDestination = fields.extend({
  local_runtime: z.enum(['llama.cpp', 'vllm', 'other']).optional(),
  ollama_mode: z.enum(['local', 'cloud']).optional(),
})
const desktopAuxiliaryFields = desktopAuxiliaryDestination.extend({
  capability: desktopAuxiliaryCapability,
  dimensions: z.number().int().min(0).max(2_147_483_647).nullish(),
})
const desktopAuxiliaryDraft = desktopAuxiliaryFields.extend({ value: secret })
export const desktopAuxiliaryModelCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('create'), input: desktopAuxiliaryDraft }),
  z.object({ action: z.literal('update'), id, input: desktopAuxiliaryDraft.omit({ capability: true }).partial().extend({ enabled: z.boolean().optional() }) }),
  z.object({ action: z.literal('delete'), id }),
  z.object({ action: z.literal('test'), id }),
  z.object({ action: z.literal('preview'), input: desktopAuxiliaryDraft.extend({ credential_id: id.nullish() }) }),
  z.object({ action: z.literal('models'), input: desktopAuxiliaryDestination.extend({ api_key: secret, credential_id: id.nullish() }).partial({ model: true }) }),
])
export const desktopAuxiliaryModelStorage = z.object({
  nextId: id,
  items: z.array(desktopAuxiliaryDraft.extend({ id, enabled: z.boolean() })),
})
export type DesktopAuxiliaryModelDraft = z.infer<typeof desktopAuxiliaryDraft>
export type DesktopAuxiliaryModelCommand = z.infer<typeof desktopAuxiliaryModelCommand>
export type DesktopAuxiliaryModelSummary = Omit<DesktopAuxiliaryModelDraft, 'value'> & { id: number; enabled: boolean; has_value: boolean }
export type DesktopAuxiliaryModelResult =
  | { enabled: true; items: DesktopAuxiliaryModelSummary[] }
  | DesktopAuxiliaryModelSummary
  | { ok: boolean; message: string }
  | { models: string[] }
  | null

/** MiniMax 国内 Anthropic 官方入口迁移时，已保存的 Key 可以随配置迁移。 */
export function isMiniMaxAnthropicEndpointMigration(
  previous: { provider: string; apiFormat: string; baseUrl: string },
  next: { provider: string; apiFormat: string; baseUrl: string },
): boolean {
  function host(value: typeof previous): string | null {
    if (value.provider !== 'minimax' || value.apiFormat !== 'anthropic') return null
    try {
      const url = new URL(value.baseUrl)
      if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash
        || !/^\/anthropic(?:\/v1)?\/?$/.test(url.pathname)) return null
      return ['api.minimaxi.com', 'api.minimax.cn'].includes(url.hostname) ? url.hostname : null
    } catch { return null }
  }
  const before = host(previous), after = host(next)
  return before !== null && after !== null && before !== after
}
