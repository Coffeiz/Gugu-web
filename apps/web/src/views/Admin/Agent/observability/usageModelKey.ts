export function usageModelKey(model: { model: string; provider: string | null }) {
  return JSON.stringify([model.provider, model.model])
}
