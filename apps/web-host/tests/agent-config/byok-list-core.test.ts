import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createByokListService, type ByokListRow } from '@gugu/core/agent/config'
import { decryptByokCredential } from '../../src/modules/agent/model-config/byok.js'

test('Core 凭据列表使用 Python 合成信封校验状态且不返回密文或明文', async () => {
  const owner = randomUUID()
  // 由 Python encrypt_envelope 使用合成主密钥生成的既有 fixture。
  const row: ByokListRow = { id:1,provider:'deepseek',api_format:'openai',capability:'llm',base_url:'',model:'synthetic-model',max_tokens:null,dimensions:null,context_tokens:null,thinking:null,reasoning_effort:null,reasoning_persistence:'off',web_search_enabled:false,image:false,video:false,audio:false,image_detail:'auto',enabled:true,last_verified_at:null,created_at:'2026-01-01',updated_at:'2026-01-01',
    encrypted_value:'b28BIEMMt2EEUk8AfZISjWaMbGTJweRfK2xHX0St4BuJepS5',nonce:'KJmwyIxzHZA1ap7X',encrypted_data_key:'VqpGMca4Bh1aKiN75EBsRVueoIszq2DLrSy03Jwt+4WtwfArJFpn+L9dr40+8JCGjcHzWb2pcAPzneyb',key_version:1 }
  const list = (master: string) => createByokListService({ enabled: () => true, readOwned: async id => id === owner ? [row] : [], verifyEnvelope: envelope => { decryptByokCredential(envelope, () => master) } })
  const ready = await list('synthetic-master')(owner), failed = await list('wrong-synthetic-master')(owner)
  assert.equal(ready.status, 'ready'); assert.equal(failed.status, 'needs_reconfigure')
  assert.equal(ready.items[0]?.has_value, true)
  for (const result of [ready, failed]) for (const value of [row.encrypted_value, row.nonce, row.encrypted_data_key, 'synthetic-python-key']) assert.equal(JSON.stringify(result).includes(value!), false)
  assert.equal((await list('wrong-synthetic-master')(randomUUID())).status, 'ready')
})
