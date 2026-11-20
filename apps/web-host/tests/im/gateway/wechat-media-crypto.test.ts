import assert from 'node:assert/strict'
import test from 'node:test'
import { createCipheriv } from 'node:crypto'
import {
  aesEcbPaddedSize, aeskeyToB64, aeskeyToHex, decryptAesEcb, decryptInboundAesEcb,
  encryptAesEcb, encryptForUpload, genFilekeyHex, md5Hex,
} from '@gugu/gateway/wechat'

const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')

function encryptRaw(block: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(block), cipher.final()])
}

test('微信上传跨块边界和空媒体均加 PKCS7，严格与入站解密恢复原文', () => {
  for (const size of [0, 1, 15, 16, 17, 31, 32, 1_024]) {
    const input = Buffer.alloc(size, 0x41)
    const uploaded = encryptForUpload(input)
    assert.equal(uploaded.aeskey.byteLength, 16)
    assert.equal(uploaded.ciphertext.byteLength, aesEcbPaddedSize(size))
    assert.equal(uploaded.paddedSize, uploaded.ciphertext.byteLength)
    assert.deepEqual(decryptAesEcb(uploaded.ciphertext, uploaded.aeskey), input)
    assert.deepEqual(decryptInboundAesEcb(uploaded.ciphertext, uploaded.aeskey), input)
  }
})

test('微信 AES 固定向量独立验证算法和完整块追加填充', () => {
  const plaintext = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const ciphertext = encryptAesEcb(plaintext, key)
  assert.equal(ciphertext.subarray(0, 16).toString('hex'), '69c4e0d86a7b0430d8cdb78070b4c55a')
  assert.equal(ciphertext.byteLength, 32)
})

test('微信出站协议编码 ASCII hex 密钥，文件校验值保持协议格式', () => {
  assert.equal(aeskeyToHex(key), '000102030405060708090a0b0c0d0e0f')
  assert.equal(Buffer.from(aeskeyToB64(key), 'base64').toString('ascii'), aeskeyToHex(key))
  assert.equal(aeskeyToB64(key).length, 44)
  assert.notEqual(aeskeyToB64(key), key.toString('base64'))
  assert.match(genFilekeyHex(), /^[0-9a-f]{32}$/)
  assert.equal(md5Hex(Buffer.from('abc')), '900150983cd24fb0d6963f7d28e17f72')
})

test('微信入站兼容保留无效填充完整块，严格解密拒绝同一密文', () => {
  const malformed = [Buffer.alloc(16, 0), Buffer.alloc(16, 17), Buffer.from('合成媒体数据X').subarray(0, 16)]
  const mismatched = Buffer.alloc(16, 0x41)
  mismatched[15] = 2
  malformed.push(mismatched)
  for (const raw of malformed) {
    const encrypted = encryptRaw(raw)
    assert.deepEqual(decryptInboundAesEcb(encrypted, key), raw)
    assert.throws(() => decryptAesEcb(encrypted, key), /微信媒体加解密参数或数据无效/)
  }
  assert.deepEqual(decryptInboundAesEcb(Buffer.alloc(0), key), Buffer.alloc(0))
  assert.throws(() => decryptAesEcb(Buffer.alloc(0), key))
})

test('微信入站仅剥离完整有效尾部，媒体中其余填充值不变', () => {
  const raw = Buffer.alloc(16, 2)
  raw[0] = 5
  assert.deepEqual(decryptInboundAesEcb(encryptRaw(raw), key), raw.subarray(0, 14))
  assert.deepEqual(decryptInboundAesEcb(encryptRaw(Buffer.alloc(16, 16)), key), Buffer.alloc(0))
})

test('微信媒体拒绝错误密钥、非整块密文与不安全长度，错误不泄露输入', () => {
  for (const size of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => aesEcbPaddedSize(size), /^Error: 微信媒体加解密参数或数据无效$/)
  }
  assert.equal(aesEcbPaddedSize(Number.MAX_SAFE_INTEGER - 16), Number.MAX_SAFE_INTEGER - 15)
  for (const badKey of [Buffer.alloc(0), Buffer.from('synthetic-secret-key-value'), Buffer.alloc(24), Buffer.alloc(32)]) {
    for (const work of [() => encryptAesEcb(Buffer.from('合成媒体'), badKey), () => decryptAesEcb(Buffer.alloc(16), badKey), () => aeskeyToB64(badKey)]) {
      assert.throws(work, error => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, '微信媒体加解密参数或数据无效')
        assert.equal(error.cause, undefined)
        return true
      })
    }
  }
  for (const size of [1, 15, 17]) {
    assert.throws(() => decryptInboundAesEcb(Buffer.alloc(size), key))
    assert.throws(() => decryptAesEcb(Buffer.alloc(size), key))
  }
})
