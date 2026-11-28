import { test, expect } from 'vitest'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { sealAttachmentSnapshot, openAttachmentSnapshot, SNAPSHOT_CHUNK_BYTES, type SnapshotChunk, type SnapshotKeyring } from '../../../src/agent/context/snapshot-codec.js'
const id = { ownerId:'owner', sessionId:'1', runId:'run', messageId:'2' }
const master = randomBytes(32)
const keyring: SnapshotKeyring = {
  currentVersion: () => 1,
  async wrap(_version,key,aad) { const nonce = randomBytes(12), c = createCipheriv('aes-256-gcm',master,nonce); c.setAAD(aad); return Buffer.concat([nonce,c.update(key),c.final(),c.getAuthTag()]) },
  async unwrap(_version,wrapped,aad) { const v = Buffer.from(wrapped), c = createDecipheriv('aes-256-gcm',master,v.subarray(0,12)); c.setAAD(aad); c.setAuthTag(v.subarray(-16)); return Buffer.concat([c.update(v.subarray(12,-16)),c.final()]) },
}
async function create() {
  const chunks: SnapshotChunk[] = []
  const data = Buffer.alloc(SNAPSHOT_CHUNK_BYTES + 11, 42)
  const manifest = await sealAttachmentSnapshot(id, (async function*(){ yield data })(), keyring, async chunk => { chunks.push(chunk) })
  return { data,manifest,chunks }
}
function view(chunks: SnapshotChunk[]) { return { async *readChunks() { for (const chunk of chunks) yield chunk } } }
async function collect(stream: AsyncIterable<Uint8Array>) { const values: Uint8Array[] = []; for await (const x of stream) values.push(x); return Buffer.concat(values) }
test('逐片保存并完整验证后恢复，大小不限制总输入', async () => {
  const { data,manifest,chunks } = await create()
  expect(chunks).toHaveLength(2); expect(chunks[0]!.ciphertext.length).toBe(SNAPSHOT_CHUNK_BYTES + 16)
  expect(await collect(openAttachmentSnapshot(id,manifest,view(chunks),keyring))).toEqual(data)
})
test('缺片、重排、修改 manifest 或身份时，任何明文都不交付', async () => {
  const { manifest,chunks } = await create()
  for (const [identity, item, list] of [[id,manifest,chunks.slice(0,1)], [id,manifest,[...chunks].reverse()], [id,{...manifest,totalBytes:'1'},chunks], [{...id,runId:'other'},manifest,chunks]] as const) {
    let delivered = 0
    await expect((async () => { for await (const _ of openAttachmentSnapshot(identity,item,view(list),keyring)) delivered++ })()).rejects.toThrow()
    expect(delivered).toBe(0)
  }
})
test('取消与密钥失败不会泄露底层异常', async () => {
  const { manifest,chunks } = await create(), controller = new AbortController(); controller.abort()
  await expect(collect(openAttachmentSnapshot(id,manifest,view(chunks),keyring,controller.signal))).rejects.toThrow()
  await expect(collect(openAttachmentSnapshot(id,manifest,view(chunks),{...keyring,async unwrap(){ throw new Error('synthetic-secret') }}))).rejects.not.toThrow('synthetic-secret')
})

test('密钥版本、密文完整性和空内容均受验证', async () => {
  const { manifest,chunks } = await create()
  const tampered = chunks.map(c => ({ ...c, ciphertext: Buffer.from(c.ciphertext) }))
  const firstCiphertext = tampered[0]!.ciphertext as Buffer
  firstCiphertext[0] = firstCiphertext[0]! ^ 1
  let delivered = 0
  await expect((async () => { for await (const _ of openAttachmentSnapshot(id,manifest,view(tampered),keyring)) delivered++ })()).rejects.toThrow()
  expect(delivered).toBe(0)
  await expect(collect(openAttachmentSnapshot(id,{...manifest,keyVersion:2},view(chunks),keyring))).rejects.toThrow()
  const empty = await sealAttachmentSnapshot(id,(async function*(){})(),keyring,async () => { throw new Error('不应写片') })
  expect(await collect(openAttachmentSnapshot(id,empty,view([]),keyring))).toEqual(Buffer.alloc(0))
})

test('损坏的超长或超出 PostgreSQL bigint 的计数在读取分片前拒绝', async () => {
  const { manifest } = await create()
  for (const value of ['9'.repeat(100000), '9223372036854775808', '-1', '01']) {
    let read = false
    const source = { async *readChunks() { read = true } }
    await expect(collect(openAttachmentSnapshot(id,{...manifest,chunkCount:value},source,keyring))).rejects.toThrow()
    await expect(collect(openAttachmentSnapshot(id,{...manifest,totalBytes:value},source,keyring))).rejects.toThrow()
    expect(read).toBe(false)
  }
})

test('不可信 keyring 的超大或错误类型返回在复制前拒绝', async () => {
  const {manifest,chunks} = await create()
  for (const value of [new Uint8Array(4097), 'synthetic-secret']) {
    const bad = {...keyring, async wrap() { return value as Uint8Array }}
    await expect(sealAttachmentSnapshot(id,(async function*(){})(),bad,async () => {})).rejects.not.toThrow('synthetic-secret')
  }
  for (const value of [new Uint8Array(100000), 'synthetic-secret']) {
    const bad = {...keyring, async unwrap() { return value as Uint8Array }}
    await expect(collect(openAttachmentSnapshot(id,manifest,view(chunks),bad))).rejects.not.toThrow('synthetic-secret')
  }
})

test('密钥版本服务异常不暴露原始内容', async () => {
  const bad = { ...keyring, currentVersion() { throw new Error('synthetic-secret') } }
  await expect(sealAttachmentSnapshot(id,(async function*(){})(),bad,async () => {})).rejects.not.toThrow('synthetic-secret')
})

test('损坏分片的非二进制字段与非规范序号不会交付明文', async () => {
  const { manifest,chunks } = await create()
  for (const change of [{nonce:'synthetic-secret'}, {ciphertext:'synthetic-secret'}, {ordinal:0}, {ordinal:'00'}]) {
    const malformed = [{...chunks[0],...change}, ...chunks.slice(1)] as SnapshotChunk[]
    let delivered = 0
    await expect((async () => { for await (const _ of openAttachmentSnapshot(id,manifest,view(malformed),keyring)) delivered++ })()).rejects.not.toThrow('synthetic-secret')
    expect(delivered).toBe(0)
  }
})
