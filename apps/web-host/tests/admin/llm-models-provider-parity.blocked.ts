import assert from 'node:assert/strict'
import test from 'node:test'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {providerDiagnosticRequest} from '../../../../packages/core/src/agent/providers/diagnostics.js'

test('模型目录请求与Python实际Provider适配器的地址及鉴权契约一致',()=>{
 const python=process.env.GUGU_WEBUI_TEST_PYTHON;assert.ok(python)
 const cases=[{provider:'openai'},{provider:'anthropic'},{provider:'minimax'},{provider:'qwen',api_format:'responses'},{provider:'qwen',api_format:'dashscope',base_url:'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'},{provider:'deepseek'},{provider:'glm'},{provider:'mimo'},{provider:'ollama'},{provider:'ollama',ollama_api_mode:'openai'},{provider:'local',base_url:'http://127.0.0.1:42424/v1'},{provider:'custom',base_url:'https://custom.example.invalid/v1'}].map(item=>({api_key:'synthetic-key',api_format:'',base_url:'',model:'synthetic',...item}))
 const expected=JSON.parse(execFileSync(python,['-c',`import json,sys
from types import SimpleNamespace
from agent import providers
result=[]
for config in json.load(sys.stdin):
 if config['provider']=='qwen' and config['api_format']=='dashscope':
  if config['base_url']=='https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation':config['base_url']='https://dashscope.aliyuncs.com/compatible-mode/v1'
  config['api_format']='openai'
 ai=SimpleNamespace(**config);adapter=providers.adapter_for(ai);base=adapter.resolve_base_url(ai);request=adapter.models_request(ai)
 result.append({'url':base+request['path'],'headers':{key.lower():value for key,value in request['headers'].items()}})
print(json.dumps(result))`],{encoding:'utf8',input:JSON.stringify(cases),cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-models-provider-parity'}}))
 const actual=cases.map(item=>{
  const config={...item}
  if(config.provider==='qwen'&&config.api_format==='dashscope'){if(config.base_url==='https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')config.base_url='https://dashscope.aliyuncs.com/compatible-mode/v1';config.api_format='openai'}
  const request=providerDiagnosticRequest(config,'models');return {url:request.url,headers:Object.fromEntries(Object.entries(request.headers??{}).map(([key,value])=>[key.toLowerCase(),value]))}
 })
 assert.deepEqual(actual,expected)
})
