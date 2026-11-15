import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mcpConfigDigestPayload} from '../../../../packages/core/src/mcp/config-digest.js'
test('MCP配置摘要保留顺序并与Python的ASCII JSON编码一致',()=>{
 const payload=mcpConfigDigestPayload([{id:'00000000-0000-4000-8000-000000000001',name:'合成',transport:'http',updated_at:'2026-01-01T00:00:00+00:00',allowlist:['查找','read']}])
 assert.equal(payload,'[{"allowlist":["\\u67e5\\u627e","read"],"id":"00000000-0000-4000-8000-000000000001","name":"\\u5408\\u6210","transport":"http","updated_at":"2026-01-01T00:00:00+00:00"}]')
 assert.equal(createHash('sha256').update(payload).digest('hex').length,64)
})
