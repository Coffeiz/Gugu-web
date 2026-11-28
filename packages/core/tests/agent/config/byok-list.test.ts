import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { createByokListService, type ByokListRow } from '../../../src/agent/config/byok.js'

it('列表不开启时拒绝，空列表不检查主密钥，失败不暴露信封', async () => {
  const owner = randomUUID(), secret = 'synthetic-cipher-secret'
  let enabled = false, checked = 0
  const row: ByokListRow = { id:1,provider:'synthetic',api_format:'openai',capability:'embedding',base_url:'https://example.test',model:'model',max_tokens:null,dimensions:1024,context_tokens:null,thinking:null,reasoning_effort:null,reasoning_persistence:'off',web_search_enabled:false,image:false,video:false,audio:false,image_detail:'auto',enabled:false,last_verified_at:null,created_at:'2026-01-01',updated_at:'2026-01-01',encrypted_value:secret,nonce:'nonce-secret',encrypted_data_key:'wrap-secret',key_version:1 }
  let rows: ByokListRow[] = []
  const list = createByokListService({ enabled: () => enabled, readOwned: async id => { expect(id).toBe(owner); return rows }, verifyEnvelope: () => { checked++; throw new Error(secret) } })
  await expect(list(owner)).rejects.toMatchObject({statusCode:403,message:'用户 BYOK 未开放'})
  enabled = true
  expect(await list(owner)).toEqual({enabled:true,status:'ready',items:[]}); expect(checked).toBe(0)
  rows = [row]
  const result = await list(owner)
  expect(result.status).toBe('needs_reconfigure'); expect(result.items[0]).toMatchObject({dimensions:1024,enabled:false,has_value:true})
  expect(JSON.stringify(result)).not.toContain(secret); expect(JSON.stringify(result)).not.toContain('nonce-secret'); expect(JSON.stringify(result)).not.toContain('wrap-secret')
  rows = [{...row,encrypted_value:''}]
  expect((await list(owner)).items[0]?.has_value).toBe(false); expect(checked).toBe(2)
})
