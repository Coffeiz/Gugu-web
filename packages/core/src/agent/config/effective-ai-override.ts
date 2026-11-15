/** Python AISettings 的已知字段；is_byok 是运行时属性，序列化时被排除。 */
const fields = [
  'provider', 'api_key', 'base_url', 'model', 'max_tokens', 'context_tokens', 'thinking',
  'reasoning_effort', 'reasoning_persistence', 'image', 'image_detail', 'video', 'audio',
  'api_format', 'ollama_mode', 'ollama_api_mode', 'ollama_keep_alive', 'deployment_mode',
  'local_runtime', 'capability_overrides', 'capability_checked_at', 'capability_fingerprint',
  'web_search_enabled', 'is_byok',
] as const
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
/** 仅模拟 apply_override 的 AI model_construct 合并，不读取环境或构造 Settings 默认值。
 * base 必须是调用方提供的完整 AISettings model_dump；原样保留历史无效值。 */
export function applyAiOverride(base: unknown, override: unknown): Record<string, unknown> {
  if (!object(base) || !object(override)) throw new TypeError('AI 配置必须是对象')
  const merged: Record<string, unknown> = {}
  for (const key of fields) {
    if (Object.hasOwn(override, key)) merged[key] = override[key]
    else if (Object.hasOwn(base, key)) merged[key] = base[key]
    else if (key === 'is_byok') merged[key] = false
    else throw new TypeError('基础 AI 配置缺少字段')
  }
  return structuredClone(merged)
}
