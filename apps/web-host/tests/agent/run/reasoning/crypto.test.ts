import { decryptByokCredential } from '../../../../src/modules/byok/crypto.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { decryptReasoningPayload, encryptReasoningPayload } from '../../../../src/modules/agent/run/reasoning/crypto.js'

test('推理状态信封兼容既有 BYOK 解密器，密文损坏或错误密钥均拒绝', () => {
  const plain = '{"synthetic":"私有数据"}', key = 'synthetic-key', sealed = encryptReasoningPayload(plain, key, 1)
  assert.equal(decryptReasoningPayload(sealed, () => key), plain)
  assert.equal(decryptByokCredential({ encrypted_value: sealed.encryptedPayload, nonce: sealed.payloadNonce,
    encrypted_data_key: sealed.encryptedDataKey, key_version: sealed.keyVersion } as never, () => key), plain)
  assert.equal(JSON.stringify(sealed).includes('私有数据'), false)
  assert.throws(() => decryptReasoningPayload(sealed, () => 'other'), /无法安全解密/)
  assert.throws(() => decryptReasoningPayload({ ...sealed, payloadDigest: '0'.repeat(64) }, () => key), /无法安全解密/)
})

test('Python 与 Node 双向解密合成推理状态信封', { skip: !process.env.GUGU_REASONING_TEST_PYTHON && '需要显式提供带 cryptography 的测试 Python' }, async () => {
  const { spawnSync } = await import('node:child_process')
  const { createHash } = await import('node:crypto')
  const { fileURLToPath } = await import('node:url')
  const cryptoPath = fileURLToPath(new URL('../../../../../../backend/app/byok/crypto.py', import.meta.url))
  const payload = '{"reasoning_items":[{"id":"synthetic","type":"reasoning"}]}'
  const sealed = encryptReasoningPayload(payload, 'synthetic-master-key', 1)
  const script = `import json,os,sys,types,runpy
m=types.ModuleType('app.core.config'); m.get_settings=lambda:None; sys.modules['app.core.config']=m
os.environ['CREDENTIALS_MASTER_KEY']='synthetic-master-key'; os.environ['CREDENTIALS_MASTER_KEY_VERSION']='1'
c=runpy.run_path(sys.argv[1]); d=json.load(sys.stdin)
p=c['decrypt_envelope'](d['encryptedPayload'],d['payloadNonce'],d['encryptedDataKey'],key_version=1)
a,b,e=c['encrypt_envelope'](p,key_version=1)
print(json.dumps({'plain':p,'encryptedPayload':a,'payloadNonce':b,'encryptedDataKey':e}))`
  const child = spawnSync(process.env.GUGU_REASONING_TEST_PYTHON!, ['-c', script, cryptoPath], {
    input: JSON.stringify(sealed), encoding: 'utf8', env: { PATH: process.env.PATH ?? '' },
  })
  assert.equal(child.status, 0, '合成 Python 信封执行失败')
  const result = JSON.parse(child.stdout) as { plain: string; encryptedPayload: string; payloadNonce: string; encryptedDataKey: string }
  assert.equal(result.plain, payload)
  assert.equal(decryptReasoningPayload({ ...result, keyVersion: 1,
    payloadDigest: createHash('sha256').update(payload).digest('hex'), payloadSize: Buffer.byteLength(payload) }, () => 'synthetic-master-key'), payload)
})
