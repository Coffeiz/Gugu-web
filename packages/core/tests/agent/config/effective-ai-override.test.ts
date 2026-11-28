import { expect, test } from 'vitest'
import { applyAiOverride } from '../../../src/agent/config/effective-ai-override.js'
// Python AISettings().model_dump() 的合成默认快照；不读取用户配置。
const base = { provider:'qwen',api_key:'',base_url:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen-max',max_tokens:25600,context_tokens:128000,thinking:'',reasoning_effort:'',reasoning_persistence:'off',image:false,image_detail:'auto',video:false,audio:false,api_format:'',ollama_mode:'local',ollama_api_mode:'native',ollama_keep_alive:'5m',deployment_mode:'cloud',local_runtime:'other',capability_overrides:{},capability_checked_at:'',capability_fingerprint:'',web_search_enabled:false }
test('与 Python model_construct 对照：有效字段浅覆盖、未知字段忽略', () => {
  const result = applyAiOverride(base, { model:'synthetic',capability_overrides:{video:true},unknown:'x' })
  expect(result).toEqual({...base, model:'synthetic', capability_overrides:{video:true}, is_byok:false})
  expect(base.capability_overrides).toEqual({})
})
test('与 Python model_construct 对照：保留旧版无效预算、类型及内部属性', () => {
  expect(applyAiOverride(base, {max_tokens:200000,image:'legacy',is_byok:true})).toEqual({...base,max_tokens:200000,image:'legacy',is_byok:true})
  expect(applyAiOverride(base, {api_key:null,context_tokens:0})).toEqual({...base,api_key:null,context_tokens:0,is_byok:false})
})
