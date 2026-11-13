import { describe, expect, it } from 'vitest'
import type { ProviderConfig, ProviderProtocol } from '../../../../src/agent/providers/contracts.js'
import { deepseekPolicy, glmPolicy, glmCodingPolicy, localPolicy, minimaxPolicy, mimoPolicy, ollamaNativeBaseUrl, ollamaPolicy, qwenPolicy, validateLocalBaseUrl, vendorPolicies } from '../../../../src/agent/providers/vendors/policies.js'
import { DEFAULT_MEDIA_LIMITS, MINIMAX_M3_MEDIA_LIMITS, prepareMiniMaxVideo, uploadMiniMaxVideo, validateVendorImage } from '../../../../src/agent/providers/vendors/media.js'
import { dashscopeAsrEndpoint, dashscopeAsrTranscript, minimaxAsrEndpoint, transcribeCompatibleAsr, transcribeMiniMax, MINIMAX_ASR_MAX_DURATION_SECONDS, MINIMAX_ASR_MAX_FILE_BYTES } from '../../../../src/agent/providers/vendors/asr.js'
import { minimaxErrorDetails } from '../../../../src/agent/providers/vendors/minimax-errors.js'
import { fakeDependencies, fakeResponse, invocation, readRequestBody, requestJsonBody } from './fixtures.js'
import { adapterFor, capabilitySnapshot, providerSelection } from '../../../../src/agent/providers/registry.js'
import { genericThinkingParams } from '../../../../src/agent/providers/base.js'
import { listProviderModels, providerDiagnosticRequest } from '../../../../src/agent/providers/diagnostics.js'
import { streamWithRetry } from '../../../../src/agent/providers/retry.js'

const config = (provider: string, model: string, more: Partial<ProviderConfig> = {}): ProviderConfig => ({ provider, model, ...more })
describe('厂商模型和协议能力不互相冒用', () => {
  it.each(['deepseek-flash', 'deepseek-v4-flash-vision-exp'])('DeepSeek仅明确视觉模型%s声明图片，显式缓存保持关闭', model => {
    expect(deepseekPolicy.capabilities(config('deepseek', model))).toMatchObject({ image: true, cache_mode: 'active' })
    expect(deepseekPolicy.capabilities(config('deepseek', 'deepseek-chat')).image).toBe(false)
    expect(deepseekPolicy.explicitCache(config('deepseek', model))).toBe(false)
  })
  it.each([['minimal', 'low'], ['medium', 'high'], ['xhigh', 'high'], ['max', 'max']])('DeepSeek推理档位%s在Chat与Responses都映射%s', (selected, expected) => {
    const ai = config('deepseek', 'deepseek-v4-flash', { thinking: 'adaptive', reasoning_effort: selected })
    expect(deepseekPolicy.parameters(ai, 'openai', 'chat')).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: expected })
    expect(deepseekPolicy.parameters(ai, 'responses', 'chat')).toEqual({ reasoning: { effort: expected } })
    expect(deepseekPolicy.parameters({ ...ai, thinking: 'disabled' }, 'responses', 'chat')).toEqual({ reasoning: { effort: 'none' } })
    expect(deepseekPolicy.parameters({ ...ai, thinking: 'disabled' }, 'anthropic', 'chat')).toEqual({ reasoning: { effort: 'none' } })
  })
  it('旧DeepSeek模型不接收新thinking，Anthropic端点按协议而非URL关键字选择', () => {
    expect(deepseekPolicy.parameters(config('deepseek', 'deepseek-chat', { thinking: 'adaptive' }), 'openai', 'chat')).toEqual({})
    expect(deepseekPolicy.baseUrl(config('deepseek', 'deepseek-flash', { api_format: 'anthropic' }))).toBe('https://api.deepseek.com/anthropic')
    expect(deepseekPolicy.protocol(config('deepseek', 'deepseek-flash', { base_url: 'https://model.example/anthropic' }))).toBe('openai')
  })
  it.each([['minimal', 'none'], ['low', 'high'], ['medium', 'high'], ['xhigh', 'max']])('GLM5.3档位%s仅Responses映射%s，Chat不臆造thinking', (selected, expected) => {
    const ai = config('glm', 'glm-5.3-flash', { thinking: 'adaptive', reasoning_effort: selected })
    expect(glmPolicy.parameters(ai, 'responses', 'chat')).toEqual({ reasoning: { effort: expected } })
    expect(glmPolicy.parameters(ai, 'openai', 'chat')).toEqual({})
    expect(glmPolicy.reasoningCapabilities(ai, 'anthropic').modes).toEqual([])
  })
  it.each(['openai', 'responses', 'anthropic'] as ProviderProtocol[])('GLM的%s端点与Coding Plan身份分开，Coding不宣称视觉', format => {
    const ai = config('glm', 'glm-5.3', { api_format: format })
    expect(glmPolicy.baseUrl(ai)).toBe(format === 'responses' ? 'https://open.bigmodel.cn/api/v1' : format === 'anthropic' ? 'https://open.bigmodel.cn/api/anthropic' : 'https://open.bigmodel.cn/api/paas/v4')
    expect(glmCodingPolicy.baseUrl(ai)).toBe(format === 'openai' ? 'https://open.bigmodel.cn/api/coding/paas/v4' : glmPolicy.baseUrl(ai))
    expect(glmCodingPolicy.capabilities(config('glm-coding', 'glm-5v')).image).toBe(false)
  })
  it('GLM旧思考模型按自己的Chat参数，视觉不由厂商名一概打开', () => {
    expect(glmPolicy.parameters(config('glm', 'glm-4.6', { thinking: 'adaptive' }), 'openai', 'chat')).toEqual({ thinking: { type: 'enabled' } })
    expect(glmPolicy.capabilities(config('glm', 'glm-4.1v')).image).toBe(true)
    expect(glmPolicy.capabilities(config('glm', 'glm-5.2')).image).toBe(false)
  })
  it('Qwen旧型号不继承Qwen3思考或JSON，Anthropic只列已支持型号', () => {
    const ai = config('qwen', 'qwen-max', { thinking: 'adaptive' })
    expect(qwenPolicy.capabilities(ai)).toMatchObject({ thinking: false, structured_json: false, structured_schema: false })
    expect(qwenPolicy.parameters(ai, 'openai', 'chat')).toEqual({})
    expect(qwenPolicy.structuredOutput(ai)).toEqual({})
    expect(qwenPolicy.supportedApiFormats(ai)).toEqual(['openai', 'responses'])
    expect(qwenPolicy.supportedApiFormats({ ...ai, model: 'qwen3.8-max-preview' })).toContain('anthropic')
  })
  it.each([['high', 'xhigh'], ['max', 'xhigh'], ['minimal', 'low']])('Qwen3.8的%s档位按协议映射%s，旧Qwen3无同名档位', (selected, expected) => {
    const ai = config('qwen', 'qwen3.8-max', { thinking: 'adaptive', reasoning_effort: selected })
    expect(qwenPolicy.parameters(ai, 'openai', 'chat')).toEqual({ preserve_thinking: true, reasoning_effort: expected })
    expect(qwenPolicy.parameters(ai, 'anthropic', 'chat')).toEqual({ thinking: { type: 'enabled' }, output_config: { effort: expected } })
    expect(qwenPolicy.parameters(ai, 'responses', 'chat')).toEqual({ reasoning: { effort: expected } })
    expect(qwenPolicy.reasoningCapabilities({ ...ai, model: 'qwen3.6-flash' }, 'openai').efforts).toEqual([])
  })
  it('Qwen disabled和none显式关思考，结构Schema包装与cache单锚点独立', () => {
    const ai = config('qwen', 'qwen3.8-max', { thinking: 'disabled' })
    expect(qwenPolicy.parameters(ai, 'openai', 'chat')).toEqual({ enable_thinking: false })
    expect(qwenPolicy.parameters({ ...ai, thinking: 'adaptive', reasoning_effort: 'none' }, 'openai', 'chat')).toEqual({ enable_thinking: false })
    expect(qwenPolicy.structuredOutput(ai, { type: 'object' })).toEqual({ response_format: { type: 'json_schema', json_schema: { name: 'gugu_output', schema: { type: 'object' } } } })
    expect(qwenPolicy.singleHistoryCacheAnchor(ai)).toBe(true)
    expect(qwenPolicy.responsesStore({ ...ai, api_format: 'responses' })).toBe(false)
  })
  it('MiniMax三代型号与三协议分别保留真实推理开关和档位', () => {
    const ai = config('minimax', 'MiniMax-M3.1-Flash-Preview', { thinking: 'adaptive', reasoning_effort: 'xhigh' })
    expect(minimaxPolicy.parameters(ai, 'anthropic', 'chat')).toEqual({ output_config: { effort: 'xhigh' } })
    expect(minimaxPolicy.parameters(ai, 'openai', 'chat')).toEqual({ thinking: { type: 'adaptive' }, reasoning_effort: 'xhigh' })
    expect(minimaxPolicy.parameters(ai, 'responses', 'chat')).toEqual({ reasoning: { effort: 'xhigh' } })
    expect(minimaxPolicy.parameters({ ...ai, model: 'MiniMax-M3', reasoning_effort: 'max' }, 'responses', 'chat')).toEqual({ reasoning: { effort: 'high' } })
    expect(minimaxPolicy.parameters({ ...ai, model: 'MiniMax-M3', thinking: 'disabled' }, 'responses', 'chat')).toEqual({})
    expect(minimaxPolicy.parameters({ ...ai, model: 'MiniMax-M2.7' }, 'responses', 'chat')).toEqual({})
    expect(minimaxPolicy.reasoningCapabilities({ ...ai, model: 'MiniMax-M3' }, 'openai').supports_adaptive_thinking).toBe(true)
    expect(minimaxPolicy.reasoningCapabilities(ai, 'openai').supports_adaptive_thinking).toBe(false)
  })
  it('MiniMax能力与媒体规格保持M2/M3边界，Responses不虚报音视频', () => {
    const ai = config('minimax', 'MiniMax-M3.1-Flash-Preview', { image: true, audio: true, video: true, api_format: 'responses' })
    expect(minimaxPolicy.capabilities(ai)).toMatchObject({ image: true, video: true, audio: false, cache_mode: 'active' })
    expect(minimaxPolicy.mediaLimits(ai)).toEqual(MINIMAX_M3_MEDIA_LIMITS)
    expect(minimaxPolicy.mediaLimits({ ...ai, model: 'MiniMax-M2.7' })).toEqual(DEFAULT_MEDIA_LIMITS)
    expect(minimaxPolicy.responsesInputCapabilities(ai)).toEqual({ image: true, audio_formats: [], video: false })
    expect(minimaxPolicy.responsesPromptCacheKey(ai)).toBe(true)
    expect(minimaxPolicy.baseUrl(ai)).toBe('https://api.minimax.cn/v1')
    expect(minimaxPolicy.parameters(ai, 'anthropic', 'chat')).not.toHaveProperty('temperature')
  })
  it('公开媒体规格使用通用默认和M3官方数值，ASR声明50MiB与500秒限制', () => {
    expect(adapterFor({ provider: 'openai', model: 'gpt-test' }).mediaLimits({ model: 'gpt-test' })).toMatchObject({ audio_max_bytes: 36 * 1024 * 1024, max_duration_s: 120, max_size_bytes: 90 * 1024 * 1024, transcode_video: true })
    expect(minimaxPolicy.mediaLimits({ model: 'abab6.5s-chat' })).toEqual(DEFAULT_MEDIA_LIMITS)
    expect(minimaxPolicy.mediaLimits({ model: 'MiniMax-M3' })).toMatchObject({ video_source_max_bytes: 512_000_000, max_size_bytes: 512_000_000, max_duration_s: 1800, duration_limit_inclusive: false, image_max_bytes: 10_000_000, image_mimes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], image_extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'], preserve_image_source: true, transcode_video: false, transcode_video_mimes: [], video_mimes: ['video/mp4', 'video/x-msvideo', 'video/quicktime', 'video/x-matroska'], base64_max: 4 * 1024 * 1024, prefer_file_upload: true })
    expect(MINIMAX_ASR_MAX_FILE_BYTES).toBe(50 * 1024 * 1024); expect(MINIMAX_ASR_MAX_DURATION_SECONDS).toBe(500)
    for (const policy of [...Object.values(vendorPolicies), adapterFor({ provider: 'anthropic', model: '' }), adapterFor({ provider: 'openai', model: '' })]) {
      const limits = policy.mediaLimits({ model: '' })
      expect(limits.max_duration_s === null || typeof limits.max_duration_s === 'number' && limits.max_duration_s > 0).toBe(true)
    }
  })
  it('MiMo专用认证、原生音视频格式及Responses思考仅由自身声明', () => {
    const ai = config('mimo', 'mimo-v2.6-pro', { api_key: 'synthetic-key', audio: true, video: true, thinking: 'adaptive' })
    expect(mimoPolicy.headers(ai)).toEqual({ 'api-key': 'synthetic-key' })
    expect(mimoPolicy.responsesInputCapabilities(ai)).toEqual({ image: false, audio_formats: ['mp3', 'wav', 'flac', 'm4a', 'ogg'], video: true })
    expect(mimoPolicy.parameters(ai, 'responses', 'chat')).toEqual({ reasoning: { effort: 'medium' } })
    expect(mimoPolicy.parameters({ ...ai, thinking: 'disabled' }, 'responses', 'chat')).toEqual({ reasoning: { effort: 'none' } })
    expect(mimoPolicy.baseUrl({ ...ai, api_format: 'anthropic' })).toBe('https://api.xiaomimimo.com/anthropic')
  })
})

describe('本地与Ollama配置保持显式边界', () => {
  it.each(['file:///private/model', 'ftp://model.example', 'http://user:secret@model.example/v1', 'https://model.example/v1#fragment'])('本地地址%s拒绝非HTTP、凭据或fragment', value => {
    expect(() => validateLocalBaseUrl(value)).toThrow()
  })
  it('Local不因运行时名称宣称工具能力，llama.cpp缓存不冒充主动计费缓存', () => {
    const ai = config('local', 'local-model', { local_runtime: 'llama.cpp' })
    expect(localPolicy.capabilities(ai)).toMatchObject({ tools: false, cache_mode: 'none' })
    expect(localPolicy.parameters(ai, 'openai', 'chat')).toEqual({ cache_prompt: true })
    expect(localPolicy.baseUrl(ai)).toBe('http://127.0.0.1:8080/v1')
  })
  it.each([['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/api'], ['https://ollama.com/api', 'https://ollama.com/api'], ['https://model.example/proxy', 'https://model.example/proxy/api']])('Ollama原生基址%s只补一次api为%s', (base, expected) => {
    expect(ollamaNativeBaseUrl(config('ollama', 'qwen3:8b', { base_url: base }))).toBe(expected)
  })
  it('Ollama原生和OpenAI模式不自动互换，显式推理档位仅用于兼容模式', () => {
    const ai = config('ollama', 'qwen3:8b', { thinking: 'adaptive', reasoning_effort: 'max' })
    expect(ollamaPolicy.protocol(ai)).toBe('ollama')
    expect(ollamaPolicy.parameters(ai, 'openai', 'chat')).toEqual({})
    // 生产驱动对兼容端点使用通用开关，不能把旧SDK辅助方法的档位误当最终请求。
    expect(ollamaPolicy.parameters({ ...ai, ollama_api_mode: 'openai' }, 'openai', 'chat')).toEqual({ reasoning_effort: 'high' })
    expect(ollamaPolicy.baseUrl({ ...ai, ollama_mode: 'cloud' })).toBe('https://ollama.com/api')
    expect(ollamaPolicy.baseUrl({ ...ai, ollama_mode: 'cloud', ollama_api_mode: 'openai' })).toBe('https://ollama.com/v1')
  })
})

describe('公开选择、诊断与兼容协议的旧行为组合', () => {
  it('注册优先显式Provider，历史URL仅用于兼容选择且不改变原配置', () => {
    const cases = [
      [{ provider: 'minimax', base_url: 'https://foreign-deepseek.example' }, 'minimax'],
      [{ base_url: 'https://xiaomimimo.example/v1' }, 'mimo'],
      [{ base_url: 'https://api.deepseek.com' }, 'deepseek'],
      [{ base_url: 'https://open.bigmodel.cn/api/paas/v4' }, 'glm'],
      [{ provider: 'glm', base_url: 'https://open.bigmodel.cn/api/coding/paas/v4' }, 'glm-coding'],
      [{ base_url: 'http://127.0.0.1:11434/v1' }, 'ollama'],
      [{ provider: 'some-compatible-provider', base_url: 'https://model.example/v1' }, 'unknown'],
    ] as const
    for (const [values, expected] of cases) {
      const ai = { model: 'synthetic-model', ...values }, original = structuredClone(ai)
      expect(adapterFor(ai).name).toBe(expected)
      expect(ai).toEqual(original)
    }
  })
  it('公开能力快照保留Local/Ollama选择、协议默认URL与未知模型无思考档位，凭据和探测不进入DTO', () => {
    const local = capabilitySnapshot({ provider: 'local', model: 'custom-model', api_format: 'responses', local_runtime: 'vllm', api_key: 'synthetic-secret-key', capability_overrides: { tools: true, structured_json: true, foreign_flag: true } })
    expect(local).toMatchObject({ provider: 'local', tools: true, structured_json: true, api_format_source: 'user_selectable', default_api_format: 'openai', supported_api_formats: ['openai', 'responses', 'anthropic'], selectable_api_formats: ['openai', 'responses', 'anthropic'], default_base_urls: { openai: 'http://127.0.0.1:8000/v1', responses: 'http://127.0.0.1:8000/v1', anthropic: 'http://127.0.0.1:8000/v1' }, overrides: { tools: true, structured_json: true } })
    const ollama = capabilitySnapshot({ provider: 'ollama', model: 'qwen3:8b', ollama_api_mode: 'native' })
    expect(ollama).toMatchObject({ api_format_source: 'user_selectable', default_api_format: 'native', selectable_api_formats: ['native', 'openai', 'responses', 'anthropic'], default_base_urls: { native: 'http://127.0.0.1:11434/api', anthropic: 'http://127.0.0.1:11434/v1' } })
    expect(capabilitySnapshot({ provider: 'qwen', model: 'qwen-max' })).toMatchObject({ api_format_source: 'provider_declared', reasoning_modes: [], reasoning_efforts: [], supported_api_formats: ['openai', 'responses'], default_base_urls: { responses: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } })
    expect(local).not.toHaveProperty('api_key'); expect(local).not.toHaveProperty('probe'); expect(local.overrides).not.toHaveProperty('foreign_flag'); expect(JSON.stringify(local)).not.toContain('synthetic-secret-key')
  })
  it('公开能力矩阵按厂商和模型分别声明缓存、工具和媒体，MiniMax M2/M3均有自动缓存', () => {
    const cases = [
      ['anthropic', '', { api_format: 'anthropic', cache_mode: 'active', tools: true }],
      ['qwen', '', { api_format: 'openai', cache_mode: 'active', thinking: false, structured_json: false, tools: true }],
      ['minimax', 'MiniMax-M3', { api_format: 'anthropic', cache_mode: 'active', tools: true }],
      ['mimo', '', { api_format: 'openai', cache_mode: 'none', thinking: true, structured_json: true, audio: true, video: true }],
      ['deepseek', '', { api_format: 'openai', cache_mode: 'active', thinking: false, structured_json: true, tools: true }],
      ['ollama', '', { api_format: 'openai', cache_mode: 'none', tools: true }],
    ] as const
    for (const [provider, model, expected] of cases) expect(capabilitySnapshot({ provider, model })).toMatchObject(expected)
    for (const model of ['MiniMax-M2.7', 'MiniMax-M3']) expect(minimaxPolicy.capabilities({ model }).cache_mode).toBe('active')
    expect(adapterFor({ provider: 'custom', model: '' }).capabilities({ model: '' }).cache_mode).toBe('active')
    expect(adapterFor({ provider: 'custom', model: '' }).explicitCache({ model: '' })).toBe(true)
  })
  it('厂商协议声明和模型边界覆盖空型号、历史别名、禁用思考与专属媒体', () => {
    expect(qwenPolicy.protocol({ provider: 'qwen', model: 'qwen-max', base_url: 'https://model.example/anthropic' })).toBe('openai')
    expect(qwenPolicy.capabilities({ provider: 'qwen', model: 'qwen-max' }).cache_mode).toBe('active')
    expect(adapterFor({ provider: 'openai', model: 'gpt-test' }).protocol({ provider: 'openai', model: 'gpt-test', base_url: 'https://model.example/anthropic' })).toBe('openai')
    expect(qwenPolicy.responsesPromptCacheKey({ model: 'qwen3.8-max', api_format: 'responses' })).toBe(false)
    const qwen = { model: 'qwen3.8-max', api_format: 'anthropic', thinking: 'adaptive', reasoning_effort: 'high' }
    expect(qwenPolicy.baseUrl(qwen)).toBe('https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/apps/anthropic')
    expect(providerDiagnosticRequest({ ...qwen, provider: 'qwen', api_key: 'synthetic-key', base_url: 'https://workspace.cn-beijing.maas.aliyuncs.com/apps/anthropic' })).toMatchObject({ url: 'https://workspace.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages', headers: { 'x-api-key': 'synthetic-key' } })
    expect(qwenPolicy.parameters(qwen, 'anthropic', 'chat')).toEqual({ thinking: { type: 'enabled' }, output_config: { effort: 'xhigh' } })
    expect(qwenPolicy.parameters({ ...qwen, thinking: 'disabled' }, 'anthropic', 'chat')).toEqual({ thinking: { type: 'disabled' } })
    expect(mimoPolicy.headers({ model: '' })).toEqual({ 'api-key': '' })
    expect(mimoPolicy.supportedApiFormats({ model: '' })).toEqual(['openai', 'responses', 'anthropic'])
    expect(mimoPolicy.parameters({ model: 'mimo-v2.6-pro', thinking: 'adaptive' }, 'anthropic', 'chat')).toEqual({ thinking: { type: 'enabled' } })
    expect(mimoPolicy.structuredOutput({ model: '' })).toEqual({ response_format: { type: 'json_object' } })
    expect(glmPolicy.capabilities({ model: 'glm-5.2' }).cache_mode).toBe('none')
    expect(glmPolicy.parameters({ model: 'glm-5.2', thinking: 'disabled' }, 'openai', 'chat')).toEqual({ thinking: { type: 'disabled' } })
    expect(glmPolicy.parameters({ model: 'glm-4-air', thinking: 'adaptive' }, 'openai', 'chat')).toEqual({})
    expect(deepseekPolicy.capabilities({ model: 'deepseek-v4-flash' }).image).toBe(false)
    expect(minimaxPolicy.supportedApiFormats({ model: '' })).toEqual(['anthropic', 'openai', 'responses'])
    expect(minimaxPolicy.sanitizerMarkers({ model: '' })).toEqual([']<]minimax', '[e~['])
    expect(ollamaPolicy.structuredOutput({ model: '' })).toEqual({ response_format: { type: 'json_object' } })
    expect(adapterFor({ provider: 'anthropic', model: '' }).name).toBe('anthropic')
  })
  it('公开推理DTO与最终参数按模型和官方端点隔离，MiniMax跨协议不虚报adaptive', () => {
    const minimax = { provider: 'minimax', model: 'MiniMax-M3.1-Flash-Preview', api_format: 'anthropic', thinking: 'adaptive', reasoning_effort: 'xhigh' }
    expect(capabilitySnapshot(minimax)).toMatchObject({ selected_api_format: 'anthropic', default_api_format: 'anthropic', default_base_url: 'https://api.minimaxi.com/anthropic', supported_api_formats: ['anthropic', 'openai', 'responses'], reasoning_modes: ['adaptive'], reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supports_adaptive_thinking: false })
    expect(minimaxPolicy.parameters({ ...minimax, reasoning_effort: 'minimal' }, 'anthropic', 'chat')).toEqual({})
    expect(capabilitySnapshot({ provider: 'minimax', model: 'MiniMax-M3', api_format: 'openai' }).supports_adaptive_thinking).toBe(true)
    expect(capabilitySnapshot({ provider: 'minimax', model: 'MiniMax-M3', api_format: 'responses' }).supports_adaptive_thinking).toBe(false)
    const native = { provider: 'anthropic', model: 'claude-opus-4-8', api_format: 'anthropic', thinking: 'adaptive', reasoning_effort: 'xhigh' }
    const selected = providerSelection(native)
    expect(selected.policy.parameters(selected.config, 'anthropic', 'chat')).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } })
    expect(capabilitySnapshot(native).supports_adaptive_thinking).toBe(true)
    const proxy = providerSelection({ ...native, base_url: 'https://proxy.example/v1' })
    expect(proxy.policy.reasoningCapabilities(proxy.config, 'anthropic').modes).toEqual([])
    expect(proxy.config).toMatchObject({ thinking: 'adaptive', reasoning_effort: '' })
    expect(capabilitySnapshot({ ...native, base_url: 'https://proxy.example/v1' }).supports_adaptive_thinking).toBe(false)
    const old = providerSelection({ ...native, model: 'claude-sonnet-4-5', reasoning_effort: 'high' })
    expect(old.policy.parameters(old.config, 'anthropic', 'chat')).toEqual({})
    const openai = providerSelection({ provider: 'openai', model: 'gpt-5.6-sol', reasoning_effort: 'max' })
    expect(openai.policy.parameters(openai.config, 'openai', 'chat')).toEqual({ reasoning_effort: 'max' })
    expect(openai.policy.parameters(openai.config, 'responses', 'chat')).toEqual({ reasoning: { effort: 'max' } })
    expect(openai.policy.reasoningCapabilities({ provider: 'openai', model: 'gpt-5.5-pro' }, 'openai').efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(openai.policy.parameters({ provider: 'openai', model: 'gpt-4o', reasoning_effort: 'high' }, 'responses', 'chat')).toEqual({})
    const compatibleOpenai = providerSelection({ provider: 'openai', model: 'gpt-5.6-sol', base_url: 'https://gateway.example/v1', thinking: 'adaptive', reasoning_effort: 'high' })
    expect(compatibleOpenai.policy.reasoningCapabilities(compatibleOpenai.config, 'openai').efforts).toEqual([])
    expect(compatibleOpenai.config).toMatchObject({ thinking: 'adaptive', reasoning_effort: '' })
  })
  it.each(['minimax', 'anthropic'])('%s配置残留采样字段也不向Anthropic最终请求发送temperature或top_p', async provider => {
    const selected = providerSelection({ provider, model: provider === 'minimax' ? 'MiniMax-M3' : 'claude-opus-4-8', temperature: 0.7, top_p: 0.4 })
    const f = fakeDependencies([fakeResponse({ type: 'message', content: [{ type: 'text', text: '完成' }], stop_reason: 'end_turn' })])
    await selected.driver.complete(invocation(selected.policy, selected.config), f.dependencies)
    expect(requestJsonBody(f.requests[0]!)).not.toHaveProperty('temperature')
    expect(requestJsonBody(f.requests[0]!)).not.toHaveProperty('top_p')
  })
  it('MiniMax已知缺块尚无输出时恢复一次，普通JS异常不扩散成可重试厂商故障', async () => {
    const selected = providerSelection({ provider: 'minimax', model: 'MiniMax-M3' })
    // SDK只有message_start后的缺块属于IndexError/KeyError恢复边界；缺start是独立顺序错误。
    const f = fakeDependencies([fakeResponse(null, { raw: 'event: message_start\ndata: {"type":"message_start","message":{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' }), fakeResponse({ type: 'message', content: [{ type: 'text', text: '恢复完成' }], stop_reason: 'end_turn' })])
    const events = []
    for await (const event of selected.driver.stream(invocation(selected.policy, selected.config), f.dependencies)) events.push(event)
    expect(events.at(-1)).toMatchObject({ type: 'complete', text: '恢复完成' }); expect(f.requests).toHaveLength(2)
    let attempts = 0, sleeps = 0
    const stream = streamWithRetry(() => (async function* () { attempts++; throw new TypeError('synthetic-private-upstream-body') })(), new AbortController().signal, { maxRetries: 5, clock: { now: () => 0, sleep: async () => { sleeps++ } } })
    await expect((async () => { for await (const _event of stream) { /* 只观察终态，不暴露正文。 */ } })()).rejects.toMatchObject({ code: 'upstream', options: { retryable: false } })
    expect(attempts).toBe(1); expect(sleeps).toBe(0)
  })
  it.each([['https://api.openai.com/v1', true], ['https://gateway.example/v1', false]] as const)('Responses只有官方端点%s的显式续接可请求加密reasoning=%s', async (base_url, expected) => {
    const selected = providerSelection({ provider: 'openai', model: 'gpt-5.6-sol', api_format: 'responses', base_url, reasoning_persistence: 'continuation' })
    const f = fakeDependencies([fakeResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }] })])
    await selected.driver.complete(invocation(selected.policy, selected.config, { purpose: 'chat', history: [{ role: 'user', content: '合成问题' }] }), f.dependencies)
    expect(requestJsonBody(f.requests[0]!).include).toEqual(expected ? ['reasoning.encrypted_content'] : undefined)
  })
  it('禁用思考会在配置副本去掉档位，不污染原值或让DeepSeek禁用请求带effort', () => {
    const ai = config('deepseek', 'deepseek-v4-flash', { thinking: 'disabled', reasoning_effort: 'high' })
    const selected = providerSelection(ai)
    expect(selected.config.reasoning_effort).toBe(''); expect(ai.reasoning_effort).toBe('high')
    expect(selected.policy.parameters(selected.config, 'openai', 'chat')).toEqual({ thinking: { type: 'disabled' } })
  })
  it('通用兼容开关不覆盖官方OpenAI或专属Qwen策略，默认状态不发送字段', () => {
    expect(genericThinkingParams({ provider: 'openai', model: 'gpt-6-sol', thinking: 'adaptive', base_url: 'https://api.openai.com/v1' }, 'openai')).toEqual({})
    expect(genericThinkingParams({ provider: 'qwen', model: 'qwen3.8-max', thinking: 'adaptive' }, 'openai')).toEqual({})
    expect(genericThinkingParams({ provider: 'custom', model: 'private', thinking: '' }, 'openai')).toEqual({})
    const original = { provider: 'custom', model: 'private', thinking: 'adaptive', reasoning_effort: 'high', base_url: 'https://model.example/v1' }
    const selected = providerSelection(original)
    expect(selected.config).toMatchObject({ thinking: 'adaptive', reasoning_effort: '' }); expect(original.reasoning_effort).toBe('high')
  })
  it.each(['local', 'ollama'].flatMap(provider => ['openai', 'responses', 'anthropic'].flatMap(format => [true, false].map(enabled => ({ provider, format: format as ProviderProtocol, enabled })))))('兼容$provider的$format显式思考$enabled经过真实选择和HTTP构造，llama缓存仅Chat发送', async ({ provider, format, enabled }) => {
    const selected = providerSelection({ provider, model: 'private-model', api_format: format, base_url: 'https://model.example/v1', ollama_api_mode: 'openai', local_runtime: 'llama.cpp', thinking: enabled ? 'adaptive' : 'disabled', reasoning_effort: 'high' })
    const payload = format === 'openai' ? { choices: [{ message: { content: '完成' }, finish_reason: 'stop' }] }
      : format === 'responses' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }] }
        : { type: 'message', content: [{ type: 'text', text: '完成' }], stop_reason: 'end_turn' }
    const f = fakeDependencies([fakeResponse(payload)])
    await selected.driver.complete(invocation(selected.policy, selected.config, { purpose: 'standalone', history: [{ role: 'user', content: '合成兼容协议问题' }] }), f.dependencies)
    expect(requestJsonBody(f.requests[0]!)).toMatchObject(format === 'openai' ? { reasoning_effort: enabled ? 'high' : 'none' } : format === 'responses' ? { reasoning: { effort: enabled ? 'medium' : 'none' } } : { thinking: { type: enabled ? 'adaptive' : 'disabled' } })
    if (format === 'openai' && provider === 'local') expect(requestJsonBody(f.requests[0]!)).toHaveProperty('cache_prompt', true)
    else expect(requestJsonBody(f.requests[0]!)).not.toHaveProperty('cache_prompt')
  })
  it('诊断与模型列表保持协议路径和厂商认证，Qwen展开思考字段而非额外SDK包装', () => {
    expect(providerDiagnosticRequest({ provider: 'ollama', model: 'qwen3:8b', ollama_api_mode: 'native' })).toMatchObject({ url: 'http://127.0.0.1:11434/api/chat', body: { think: false, stream: false } })
    expect(providerDiagnosticRequest({ provider: 'ollama', model: 'qwen3:8b', ollama_api_mode: 'native' }, 'models')).toMatchObject({ method: 'GET', url: 'http://127.0.0.1:11434/api/tags' })
    const mimo = providerDiagnosticRequest({ provider: 'mimo', model: 'mimo-v2', api_key: 'synthetic-key' })
    expect(mimo).toMatchObject({ url: 'https://api.xiaomimimo.com/v1/chat/completions', headers: { 'api-key': 'synthetic-key' } }); expect(mimo.headers).not.toHaveProperty('Authorization')
    expect(providerDiagnosticRequest({ provider: 'qwen', model: 'qwen3.8-max', thinking: 'disabled', api_key: 'synthetic-key' })).toMatchObject({ body: { enable_thinking: false } })
    expect(providerDiagnosticRequest({ provider: 'anthropic', model: 'claude-test', base_url: 'https://api.anthropic.com', api_key: 'synthetic-key' }, 'models')).toMatchObject({ url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': 'synthetic-key' } })
  })
  it('模型列表鉴权失败给安全认证分类，上游错误正文和密钥只允许进入受限诊断', async () => {
    const f = fakeDependencies([fakeResponse({ error: { message: 'synthetic-private-upstream-body' } }, { status: 401 })])
    try {
      await listProviderModels({ provider: 'local', model: 'local-model', api_key: 'synthetic-secret-key', base_url: 'https://model.example/v1' }, f.dependencies, new AbortController().signal)
      throw new Error('合成请求应失败')
    } catch (error) {
      expect(error).toHaveProperty('code', 'authentication')
      expect(String(error)).not.toContain('synthetic-private-upstream-body')
      expect(JSON.stringify(error)).not.toContain('synthetic-secret-key')
    }
  })
})

describe('MiniMax媒体规格、流式上传和ASR', () => {
  const videoConfig = config('minimax', 'MiniMax-M3', { api_key: 'synthetic-key', base_url: 'https://api.minimaxi.com/anthropic' })
  const source = (duration?: number) => ({ name: '合成视频.mp4', mime: 'video/mp4', size: 4, bytes: new Uint8Array([1, 2, 3, 4]), ...(duration === undefined ? {} : { duration }) })
  const signal = () => new AbortController().signal
  it.each([1800, 1799.9])('M3视频%s秒保留原件base64，正好1800秒不误拒', async duration => {
    const f = fakeDependencies([])
    await expect(prepareMiniMaxVideo(source(duration), videoConfig, f.dependencies, signal())).resolves.toEqual({ mode: 'base64', mime: 'video/mp4', data: 'AQIDBA==' })
    expect(f.requests).toEqual([])
  })
  it.each([1800.1, 4119.105, NaN, 0])('M3视频时长%s非法或超限时在任何上传之前拒绝', async duration => {
    const f = fakeDependencies([])
    await expect(prepareMiniMaxVideo(source(duration), videoConfig, f.dependencies, signal())).rejects.toHaveProperty('code', 'input_rejected')
    expect(f.requests).toEqual([])
  })
  it('未知视频时长必须探测，探测缺失不传文件，取消后不启动上传', async () => {
    const f = fakeDependencies([]), controller = new AbortController()
    await expect(prepareMiniMaxVideo(source(), videoConfig, f.dependencies, signal())).rejects.toHaveProperty('code', 'input_rejected')
    await expect(prepareMiniMaxVideo(source(), videoConfig, { ...f.dependencies, probeVideo: async () => { controller.abort(); return { duration: 1 } } }, controller.signal)).rejects.toThrow()
    expect(f.requests).toEqual([])
  })
  it('可信已知视频时长跳过重复探测，缺少时只调用一次注入探测并在读数据前拒绝超长文件', async () => {
    let probes = 0, reads = 0
    const f = fakeDependencies([]), dependencies = { ...f.dependencies, probeVideo: async () => { probes++; return { duration: 2000 } } }
    await expect(prepareMiniMaxVideo(source(1), videoConfig, dependencies, signal())).resolves.toHaveProperty('mode', 'base64')
    expect(probes).toBe(0)
    await expect(prepareMiniMaxVideo({ name: '合成长视频.mp4', mime: 'video/mp4', size: 4, stream: () => (async function* () { reads++; yield new Uint8Array([1, 2, 3, 4]) })() }, videoConfig, dependencies, signal())).rejects.toThrow('1800')
    expect(probes).toBe(1); expect(reads).toBe(0); expect(f.requests).toEqual([])
  })
  it('大视频以原始异步源multipart分块上传，返回稳定file_id而非复制base64', async () => {
    let piecesRead = 0, uploaded = ''
    const chunk = new Uint8Array(1024 * 1024).fill(65)
    const f = fakeDependencies(async request => { expect(request.body).not.toBeInstanceOf(Uint8Array); uploaded = await readRequestBody(request); return fakeResponse({ file: { file_id: 12345 } }) })
    const result = await prepareMiniMaxVideo({ name: 'v.mp4', mime: 'video/mp4', size: 5 * chunk.length, duration: 1800,
      stream: () => (async function* () { for (let i = 0; i < 5; i++) { piecesRead++; yield chunk } })() }, videoConfig, f.dependencies, signal())
    expect(result).toEqual({ mode: 'file', mime: 'video/mp4', fileId: '12345', uri: 'mm_file://12345' })
    expect(piecesRead).toBe(5)
    expect(f.requests[0]).toMatchObject({ url: 'https://api.minimaxi.com/v1/files/upload', headers: { Authorization: 'Bearer synthetic-key' } })
    expect(uploaded).toContain('name="purpose"\r\n\r\nvideo_understanding'); expect(uploaded).toContain('filename="v.mp4"')
  })
  it('上传缺配置不联网，失败状态或缺file_id返回null并清理响应', async () => {
    const f = fakeDependencies([])
    await expect(uploadMiniMaxVideo(source(1), { ...videoConfig, api_key: '' }, f.dependencies, signal())).resolves.toBeNull()
    expect(f.requests).toEqual([])
    for (const response of [fakeResponse({}, { status: 500 }), fakeResponse({ file: {} })]) {
      const failed = fakeDependencies([response])
      await expect(uploadMiniMaxVideo(source(1), videoConfig, failed.dependencies, signal())).resolves.toBeNull()
      expect(response.closed).toBe(true)
    }
  })
  it('M3图片规格按十进制10MB和原生MIME提前拒绝，M2不继承M3媒体', () => {
    expect(() => validateVendorImage(10_000_000, 'image/png', MINIMAX_M3_MEDIA_LIMITS)).not.toThrow()
    expect(() => validateVendorImage(10_000_001, 'image/png', MINIMAX_M3_MEDIA_LIMITS)).toThrow()
    expect(() => validateVendorImage(10, 'image/bmp', MINIMAX_M3_MEDIA_LIMITS)).toThrow()
    expect(minimaxPolicy.capabilities({ ...videoConfig, model: 'MiniMax-M2.7' })).toMatchObject({ image: false, video: false })
  })
  it.each([['audio/wav', 'wav'], ['audio/mpeg', 'mp3'], ['audio/ogg', 'ogg']])('ASR缺ext时%s推导%s供探测和multipart文件名', async (mime, ext) => {
    const probes: unknown[] = []; let body = ''
    const f = fakeDependencies(async request => { body = await readRequestBody(request); return fakeResponse({ text: ' 识别成功 ' }) })
    const result = await transcribeMiniMax([{ type: 'audio', mime, raw: new Uint8Array([1, 2, 3]) }], config('minimax', 'asr-1.0', { api_key: 'synthetic-key' }), {
      ...f.dependencies, probeAudioDuration: async (_raw, extension) => { probes.push(extension); return 1 }, toWav: async () => { throw new Error('受支持格式不应转码') },
    }, signal(), { raiseErrors: true })
    expect(result).toBe('识别成功'); expect(probes).toEqual([ext]); expect(body).toContain(`filename="audio.${ext}"`)
    expect(f.requests[0]).toMatchObject({ url: 'https://api.minimax.cn/v1/speech_to_text' })
  })
  it.each([null, 500.001])('ASR时长%s未知或超过500秒在任何请求前拒绝', async duration => {
    const f = fakeDependencies([])
    await expect(transcribeMiniMax([{ type: 'audio', mime: 'audio/wav', raw: new Uint8Array([1]) }], config('minimax', 'asr-1.0', { api_key: 'synthetic-key' }), {
      ...f.dependencies, probeAudioDuration: async () => duration, toWav: async () => null,
    }, signal(), { raiseErrors: true })).rejects.toHaveProperty('code', 'input_rejected')
    expect(f.requests).toEqual([])
  })
  it('ASR未知容器转为wav且再查大小，PCM和非法base64不能送往服务', async () => {
    let body = '', conversions = 0
    const f = fakeDependencies(async request => { body = await readRequestBody(request); return fakeResponse({ text: '成功' }) })
    const dependencies = { ...f.dependencies, probeAudioDuration: async () => 500, toWav: async () => { conversions++; return new Uint8Array([9]) } }
    await expect(transcribeMiniMax([{ type: 'audio', mime: 'application/unknown', raw: new Uint8Array([1]), ext: 'unknown' }], config('minimax', 'asr-1.0', { api_key: 'synthetic-key' }), dependencies, signal())).resolves.toBe('成功')
    expect(body).toContain('filename="audio.wav"'); expect(conversions).toBe(1)
    for (const item of [{ type: 'audio', mime: 'audio/pcm', raw: new Uint8Array([1]) }, { type: 'audio', mime: 'audio/wav', b64: '%%%invalid' }]) {
      await expect(transcribeMiniMax([item], config('minimax', 'asr-1.0', { api_key: 'synthetic-key' }), dependencies, signal())).rejects.toThrow()
    }
    expect(f.requests).toHaveLength(1)
  })
  it('ASR原始文件超过50MiB在探测与网络前拒绝，错误保留明确限额且不含文件正文', async () => {
    let probes = 0
    const f = fakeDependencies([])
    await expect(transcribeMiniMax([{ type: 'audio', mime: 'audio/wav', raw: new Uint8Array(50 * 1024 * 1024 + 1) }], config('minimax', 'asr-1.0', { api_key: 'synthetic-key' }), { ...f.dependencies, probeAudioDuration: async () => { probes++; return 1 }, toWav: async () => null }, signal())).rejects.toThrow('50 MB')
    expect(probes).toBe(0); expect(f.requests).toEqual([])
  })
  it.each(['https://foreign.example/v1', 'https://api.minimax.cn:444/v1', 'https://user:secret@api.minimax.cn', 'https://api.minimax.cn/v1?key=secret', 'https://api.minimax.cn/v2'])('ASR地址%s不能把密钥发往非官方端点', value => {
    expect(() => minimaxAsrEndpoint(value)).toThrow()
  })
  it('ASR上游失败可选择空文本或安全异常，错误内容仅交受限诊断', async () => {
    for (const raiseErrors of [false, true]) {
      const f = fakeDependencies([fakeResponse({ base_resp: { status_code: 1004 }, text: '不应当成功' })])
      const promise = transcribeMiniMax([{ type: 'audio', mime: 'audio/wav', duration: 1, raw: new Uint8Array([1]) }], config('minimax', 'asr-1.0', { api_key: 'synthetic-key' }), { ...f.dependencies, probeAudioDuration: async () => 1, toWav: async () => null }, signal(), { raiseErrors })
      if (raiseErrors) await expect(promise).rejects.toHaveProperty('code', 'upstream')
      else await expect(promise).resolves.toBe('')
      expect(f.diagnostics[0]?.code).toBe('minimax_asr_failed')
    }
  })
})

describe('MiniMax错误只暴露白名单语义', () => {
  it.each([['invalid params, context window exceeds limit (2013)', true], ['invalid params, thinking requires adaptive thinking (2013)', false], ['request entity too large (2013)', false]])('同2013错误按真实上下文语义分类：%s', (message, overflow) => {
    const result = minimaxErrorDetails({ body: { error: { type: 'invalid_request_error', message }, base_resp: { status_code: 2013 }, request_id: 'req-2013-001' }, status: 400 })
    expect(result).toMatchObject({ code: '2013', context_overflow: overflow, description_key: overflow ? 'chatUi.minimaxErrorCodes.contextOverflow' : 'chatUi.minimaxErrorCodes.code2013' })
    expect(JSON.stringify(result)).not.toContain(message)
  })
  it('瞬时码须同时具备api_error类型，密钥和上游正文不得进详情', () => {
    const body = { error: { type: 'api_error', code: 1033, message: 'synthetic-secret-user-body' }, request_id: 'req\r\nprivate<>id', base_resp: { status_code: 1033 } }
    expect(minimaxErrorDetails({ body })).toMatchObject({ code: '1033', retryable: true, request_id: 'reqprivateid' })
    expect(minimaxErrorDetails({ body: { ...body, error: { ...body.error, type: 'invalid_request_error' } } })?.retryable).toBe(false)
    expect(JSON.stringify(minimaxErrorDetails({ body }))).not.toContain('synthetic-secret-user-body')
    expect(minimaxErrorDetails({ body: { message: '本地组装失败' } })).toBeNull()
  })
  it('SDK错误body的访问器、循环和BigInt不会执行或遮蔽原分类', () => {
    let accessed = 0
    const body: Record<string, unknown> = { base_resp: { status_code: 2013 }, code: 1n }
    body.circular = body
    Object.defineProperty(body, 'error', { enumerable: true, get() { accessed++; throw new Error('合成访问器不能执行') } })
    expect(minimaxErrorDetails({ body })).toMatchObject({ code: '2013', context_overflow: false })
    expect(accessed).toBe(0)
  })
})


describe('兼容及DashScope ASR独立网络契约', () => {
  const raw = new Uint8Array([1, 2, 3])
  const media = [{ type: 'audio', mime: 'audio/wav', raw }]
  const nativeUrl = 'https://voice.example/api/v1/services/aigc/multimodal-generation/generation'
  const ai = (format = 'openai', more: Partial<ProviderConfig> = {}): ProviderConfig => config('qwen', 'synthetic-asr', { api_format: format, api_key: 'synthetic-key', base_url: format === 'dashscope' ? nativeUrl : 'https://voice.example/v1', ...more })
  const complete = (value = '识别结果') => ({ choices: [{ message: { content: value } }] })
  const signal = () => new AbortController().signal
  const toWav = async () => new Uint8Array([4, 5, 6])

  it('兼容ASR实际请求只含音频和ITN参数，不复用聊天thinking生成参数且输入不变', async () => {
    const response = fakeResponse(complete('  合成转写  ')), f = fakeDependencies([response])
    const cfg = ai('openai', { thinking: 'adaptive', reasoning_effort: 'high', temperature: 0.8, max_tokens: 7, timeout_ms: 1234 })
    const original = structuredClone({ cfg, media })
    expect(await transcribeCompatibleAsr(media, cfg, { ...f.dependencies, toWav }, signal(), { raiseErrors: true })).toBe('合成转写')
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]).toMatchObject({ url: 'https://voice.example/v1/chat/completions', method: 'POST', headers: { Authorization: 'Bearer synthetic-key' }, timeoutMs: 1234, allowLocal: false })
    expect(requestJsonBody(f.requests[0]!)).toEqual({ model: 'synthetic-asr', messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,AQID' } }] }], asr_options: { enable_itn: false } })
    expect({ cfg, media }).toEqual(original); expect(response.closed).toBe(true)
  })
  it.each(['qwen3-asr', 'qwen-audio', 'fun-asr'])('DashScope产品线%s实际发送各自原生body，不从模型名推协议', async service => {
    const response = fakeResponse({ output: { sentence: { text: '  原生转写  ' } } }), f = fakeDependencies([response])
    const cfg = ai('dashscope', { model: 'mimo-v2.5-asr', dashscope_service: service, thinking: 'adaptive', base_url: nativeUrl + '/?workspace=synthetic#fragment' })
    expect(await transcribeCompatibleAsr(media, cfg, { ...f.dependencies, toWav }, signal())).toBe('原生转写')
    expect(f.requests[0]).toMatchObject({ url: nativeUrl + '?workspace=synthetic', headers: { Authorization: 'Bearer synthetic-key', 'X-DashScope-SSE': 'disable' } })
    const content = service === 'qwen3-asr' ? [{ audio: 'data:audio/wav;base64,AQID' }] : [{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,AQID' } }]
    expect(requestJsonBody(f.requests[0]!)).toEqual({ model: 'mimo-v2.5-asr', input: { messages: [{ role: 'user', content }] }, parameters: service === 'qwen3-asr' ? { asr_options: { enable_itn: false } } : { format: 'wav', sample_rate: 16000 } })
    expect(response.closed).toBe(true)
  })
  it('显式qwen-audio产品线压过qwen3模型名前缀，实际请求仍是input_audio', async () => {
    const f = fakeDependencies([fakeResponse({ output: { text: 'ok' } })])
    expect(await transcribeCompatibleAsr(media, ai('dashscope', { model: 'qwen3-asr-flash-custom', dashscope_service: 'qwen-audio' }), { ...f.dependencies, toWav }, signal())).toBe('ok')
    expect(requestJsonBody(f.requests[0]!)).toEqual({ model: 'qwen3-asr-flash-custom', input: { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,AQID' } }] }] }, parameters: { format: 'wav', sample_rate: 16000 } })
  })
  it('原生端点只接受完整路径，Workspace前缀保留且兼容模式地址不会被自动补齐', () => {
    expect(dashscopeAsrEndpoint('https://voice.example/workspaces/synthetic/api/v1/services/aigc/multimodal-generation/generation/')).toBe('https://voice.example/workspaces/synthetic/api/v1/services/aigc/multimodal-generation/generation')
    for (const url of ['', 'https://voice.example/compatible-mode/v1', 'https://user:secret@voice.example' + new URL(nativeUrl).pathname, 'file:///api/v1/services/aigc/multimodal-generation/generation']) expect(() => dashscopeAsrEndpoint(url)).toThrow()
  })
  it('原生ASR凭据query在自定义transport之前拒绝，普通region和workspace仍保留', async () => {
    const f = fakeDependencies([])
    for (const key of ['api_key', 'api-key', 'APIKEY', 'x-api-key', 'key', 'token', 'access_token', 'access-token', 'secret', 'authorization', 'auth', 'api%5Fkey']) {
      await expect(transcribeCompatibleAsr(media, ai('dashscope', { base_url: nativeUrl + `?${key}=synthetic-secret` }), { ...f.dependencies, toWav }, signal())).rejects.toMatchObject({ code: 'input_rejected', message: '模型拒绝了当前输入' })
    }
    expect(f.requests).toEqual([])
    expect(dashscopeAsrEndpoint(nativeUrl + '?region=synthetic&workspace=synthetic')).toBe(nativeUrl + '?region=synthetic&workspace=synthetic')
  })
  it.each([
    [{ output: { text: '  文本  ', sentence: { text: '不应覆盖' } } }, '文本'],
    [{ output: { sentence: { text: '  句子  ' } } }, '句子'],
    [{ output: { choices: [{ message: { content: '  字符串  ' } }] } }, '字符串'],
    [{ output: { choices: [{ message: { content: [{ text: ' 分段' }, { audio: '忽略音频' }, { text: '文本 ' }] } }] } }, '分段文本'],
    [{ output: {} }, ''],
  ])('原生ASR响应%j提取结果%s，不把非文本块拼进转写', async (payload, expected) => {
    const f = fakeDependencies([fakeResponse(payload)])
    expect(dashscopeAsrTranscript(payload)).toBe(expected)
    expect(await transcribeCompatibleAsr(media, ai('dashscope'), { ...f.dependencies, toWav }, signal())).toBe(expected)
  })
  it.each(['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3'])('兼容ASR容器%s直传，不调用转码或时长探测', async mime => {
    let converted = 0
    const f = fakeDependencies([fakeResponse(complete())])
    await transcribeCompatibleAsr([{ type: 'audio', mime, b64: 'AQID' }], ai(), { ...f.dependencies, toWav: async () => { converted++; return null } }, signal())
    expect(converted).toBe(0)
    expect(JSON.stringify(requestJsonBody(f.requests[0]!))).toContain(`data:${mime};base64,AQID`)
  })
  it('不支持容器通过注入转WAV，失败项和视频不发送，原始音频大块编码不截断', async () => {
    const converted: number[] = [], f = fakeDependencies([fakeResponse(complete())])
    await transcribeCompatibleAsr([{ type: 'video', raw }, { type: 'audio', mime: 'audio/webm', raw }, { type: 'audio', mime: 'audio/mp4', raw: new Uint8Array([9]) }], ai(), { ...f.dependencies, toWav: async value => { converted.push(value[0]!); return value[0] === 9 ? null : new Uint8Array([4, 5, 6]) } }, signal())
    expect(converted).toEqual([1, 9])
    expect(requestJsonBody(f.requests[0]!)).toEqual({ model: 'synthetic-asr', messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,BAUG' } }] }], asr_options: { enable_itn: false } })
    const big = new Uint8Array(70_000).fill(65), large = fakeDependencies([fakeResponse(complete())])
    await transcribeCompatibleAsr([{ type: 'audio', raw: big }], ai(), { ...large.dependencies, toWav }, signal())
    const body = requestJsonBody(large.requests[0]!), encoded = ((body.messages as { content: { input_audio: { data: string } }[] }[])[0]!.content[0]!.input_audio.data).split(',')[1]!
    expect(atob(encoded)).toBe('A'.repeat(70_000))
  })
  it('无音频或转码均失败时不联网，不读取主模型或替换配置', async () => {
    const f = fakeDependencies([])
    expect(await transcribeCompatibleAsr([{ type: 'video', raw }], ai(), { ...f.dependencies, toWav }, signal())).toBe('')
    expect(await transcribeCompatibleAsr([{ type: 'audio', raw, mime: 'audio/webm' }], ai(), { ...f.dependencies, toWav: async () => null }, signal())).toBe('')
    expect(f.requests).toEqual([])
  })
  it('转码端口异常只跳过该音频，退避端口异常不会泄漏路径或误发下一请求', async () => {
    const f = fakeDependencies([])
    expect(await transcribeCompatibleAsr([{ type: 'audio', raw, mime: 'audio/webm' }], ai(), { ...f.dependencies, toWav: async () => { throw new Error('synthetic-private-conversion-path') } }, signal())).toBe('')
    await expect(transcribeCompatibleAsr([{ type: 'audio', raw, mime: 'audio/webm' }], ai(), { ...f.dependencies, toWav: async () => { throw new Error('synthetic-private-conversion-path') } }, signal(), { raiseErrors: true })).rejects.toMatchObject({ code: 'upstream', message: '模型服务请求失败' })
    expect(f.requests).toEqual([])
    const backoff = fakeDependencies([fakeResponse({}, { status: 503 })])
    await expect(transcribeCompatibleAsr(media, ai(), { ...backoff.dependencies, toWav, sleep: async () => { throw new Error('synthetic-private-clock-path') } }, signal(), { raiseErrors: true })).rejects.toMatchObject({ code: 'upstream', message: '模型服务请求失败' })
    expect(backoff.requests).toHaveLength(1)
  })
  it('非法base64、协议或原生产品线在请求前拒绝，不能偷偷换聊天协议', async () => {
    const f = fakeDependencies([]), deps = { ...f.dependencies, toWav }
    await expect(transcribeCompatibleAsr([{ type: 'audio', b64: '@@@', mime: 'audio/wav' }], ai(), deps, signal())).rejects.toHaveProperty('code', 'input_rejected')
    await expect(transcribeCompatibleAsr(media, ai('responses'), deps, signal())).rejects.toHaveProperty('code', 'unsupported')
    for (const service of ['guess-from-model', '   ', 7]) await expect(transcribeCompatibleAsr(media, ai('dashscope', { dashscope_service: service }), deps, signal())).rejects.toHaveProperty('code', 'unsupported')
    await expect(transcribeCompatibleAsr(media, ai('dashscope', { api_key: '合成非ASCII' }), deps, signal())).rejects.toHaveProperty('code', 'input_rejected')
    expect(f.requests).toEqual([])
  })
  it.each(['openai', 'dashscope'])('%s ASR仅瞬时429和5xx退避1秒2秒，第三次成功且每次响应关闭', async format => {
    const responses = [fakeResponse({ error: '上游私有错误' }, { status: 429 }), fakeResponse({}, { status: 503 }), fakeResponse(format === 'dashscope' ? { output: { text: '重试成功' } } : complete('重试成功'))]
    const originalResponses = [...responses], f = fakeDependencies(responses), pauses: number[] = []
    expect(await transcribeCompatibleAsr(media, ai(format), { ...f.dependencies, toWav, sleep: async milliseconds => { pauses.push(milliseconds) } }, signal(), { raiseErrors: true })).toBe('重试成功')
    expect(pauses).toEqual([1000, 2000]); expect(f.requests).toHaveLength(3); expect(originalResponses.every(response => response.closed)).toBe(true)
    expect(f.requests.map(requestJsonBody)).toEqual([requestJsonBody(f.requests[0]!), requestJsonBody(f.requests[0]!), requestJsonBody(f.requests[0]!)])
  })
  it.each([400, 401, 403, 404, 422])('HTTP%s为永久失败，两种协议只请求一次且不泄漏上游正文', async status => {
    for (const format of ['openai', 'dashscope']) {
      const f = fakeDependencies([fakeResponse({ error: { message: 'synthetic-private-upstream-body' } }, { status })]), pauses: number[] = []
      const deps = { ...f.dependencies, toWav, sleep: async (milliseconds: number) => { pauses.push(milliseconds) } }
      await expect(transcribeCompatibleAsr(media, ai(format), deps, signal(), { raiseErrors: true })).rejects.not.toThrow('synthetic-private-upstream-body')
      expect(f.requests).toHaveLength(1); expect(pauses).toEqual([])
    }
  })
  it('兼容ASR超时后只退避一次并第二次成功，未知内部错误不重试', async () => {
    let calls = 0
    const f = fakeDependencies(async () => { if (++calls === 1) throw Object.assign(new Error('合成超时'), { code: 'ETIMEDOUT' }); return fakeResponse(complete('第二次成功')) }), pauses: number[] = []
    expect(await transcribeCompatibleAsr(media, ai(), { ...f.dependencies, toWav, sleep: async ms => { pauses.push(ms) } }, signal())).toBe('第二次成功')
    expect(f.requests).toHaveLength(2); expect(pauses).toEqual([1000])
    const permanent = fakeDependencies(async () => { throw new Error('synthetic-private-key-error') })
    expect(await transcribeCompatibleAsr(media, ai(), { ...permanent.dependencies, toWav, sleep: async () => { throw new Error('不应重试') } }, signal())).toBe('')
    expect(permanent.requests).toHaveLength(1)
  })
  it.each(['openai', 'dashscope'])('%s网络重试最多三次，默认空串与显式安全异常分别保留', async format => {
    for (const raiseErrors of [false, true]) {
      const f = fakeDependencies(async () => { throw Object.assign(new Error('synthetic-private-network-body'), { code: 'ECONNRESET' }) }), pauses: number[] = []
      const result = transcribeCompatibleAsr(media, ai(format), { ...f.dependencies, toWav, sleep: async milliseconds => { pauses.push(milliseconds) } }, signal(), { raiseErrors })
      if (raiseErrors) await expect(result).rejects.toMatchObject({ code: 'network', message: '模型网络请求失败' })
      else expect(await result).toBe('')
      expect(f.requests).toHaveLength(3); expect(pauses).toEqual([1000, 2000])
    }
  })
  it('响应结构错误不按网络失败重试，空转写保持空串', async () => {
    const malformed = fakeDependencies([fakeResponse({ choices: [] })])
    await expect(transcribeCompatibleAsr(media, ai(), { ...malformed.dependencies, toWav }, signal(), { raiseErrors: true })).rejects.toHaveProperty('code', 'protocol')
    expect(malformed.requests).toHaveLength(1)
    const empty = fakeDependencies([fakeResponse({ choices: [{ message: { content: null } }] })])
    expect(await transcribeCompatibleAsr(media, ai(), { ...empty.dependencies, toWav }, signal())).toBe('')
  })
  it.each(['转换', '网络', '退避'])('ASR%s期间取消立即终止，不继续发请求或泄漏取消原因', async phase => {
    const controller = new AbortController()
    const f = fakeDependencies(async () => { if (phase === '网络') controller.abort(new Error('synthetic-private-cancel')); throw Object.assign(new Error('合成瞬时故障'), { code: 'ETIMEDOUT' }) })
    const result = transcribeCompatibleAsr([{ type: 'audio', raw, mime: phase === '转换' ? 'audio/webm' : 'audio/wav' }], ai(), { ...f.dependencies,
      toWav: async () => { controller.abort(new Error('synthetic-private-cancel')); return raw },
      sleep: async () => { controller.abort(new Error('synthetic-private-cancel')) },
    }, controller.signal)
    await expect(result).rejects.toMatchObject({ code: 'cancelled', message: '模型请求已取消' })
    expect(f.requests).toHaveLength(phase === '转换' ? 0 : 1)
  })
  it.each(['local', 'ollama', 'unknown'])('ASR本地授权只认显式%s配置，不继承URL推断身份', async provider => {
    const f = fakeDependencies([fakeResponse(complete())])
    await transcribeCompatibleAsr(media, ai('openai', { provider, base_url: 'http://127.0.0.1:11434/v1' }), { ...f.dependencies, toWav }, signal())
    expect(f.requests[0]!.allowLocal).toBe(provider !== 'unknown')
  })
})
