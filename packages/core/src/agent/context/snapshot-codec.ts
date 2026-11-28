import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

export interface SnapshotIdentity { ownerId: string; sessionId: string; runId: string; messageId: string }
export interface SnapshotKeyring {
  currentVersion(): number
  wrap(version: number, key: Uint8Array, associatedData: Uint8Array): Promise<Uint8Array>
  unwrap(version: number, wrapped: Uint8Array, associatedData: Uint8Array): Promise<Uint8Array>
}
export interface SnapshotChunk { ordinal: string; nonce: Uint8Array; ciphertext: Uint8Array }
export interface SnapshotManifest { codecVersion: 1; keyVersion: number; wrappedKey: Uint8Array; chunkCount: string; totalBytes: string; mac: Uint8Array }
/** 两次读取必须来自同一不可变视图（例如同一 PostgreSQL REPEATABLE READ 事务），不能传普通实时查询。 */
export interface StableSnapshotView { readChunks(): AsyncIterable<SnapshotChunk> }
export const SNAPSHOT_CHUNK_BYTES = 256 * 1024
const enc = (x: unknown) => Buffer.from(JSON.stringify(x), 'utf8')
function identityValue(identity: SnapshotIdentity) {
  if (!identity.ownerId || !identity.runId || !/^[1-9]\d*$/.test(identity.sessionId) || !/^[1-9]\d*$/.test(identity.messageId)) throw new TypeError('附件快照身份无效')
  return [identity.ownerId, identity.sessionId, identity.runId, identity.messageId]
}
function keyAad(identity: SnapshotIdentity, version: number) { return enc(['gugu-attachment-wrap-v1', identityValue(identity), version]) }
function chunkAad(identity: SnapshotIdentity, ordinal: string) { return enc(['gugu-attachment-chunk-v1', identityValue(identity), ordinal]) }
function derive(key: Uint8Array, purpose: string): Buffer { return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), Buffer.from(purpose), 32)) }
function initialMac(key: Uint8Array, identity: SnapshotIdentity) { return createHmac('sha256', derive(key, 'gugu-attachment-manifest-v1')).update(enc(['gugu-attachment-manifest-v1', identityValue(identity)])) }
function addChunk(mac: ReturnType<typeof createHmac>, chunk: SnapshotChunk) {
  const lengths = Buffer.alloc(8); lengths.writeUInt32BE(chunk.nonce.length, 0); lengths.writeUInt32BE(chunk.ciphertext.length, 4)
  mac.update(enc(chunk.ordinal)).update(lengths).update(chunk.nonce).update(chunk.ciphertext)
}
function finalMac(mac: ReturnType<typeof createHmac>, manifest: Omit<SnapshotManifest, 'mac'>): Buffer {
  return mac.update(enc([manifest.codecVersion, manifest.keyVersion, Buffer.from(manifest.wrappedKey).toString('base64'), manifest.chunkCount, manifest.totalBytes])).digest()
}
function parseCount(value: string): bigint {
  if (typeof value !== 'string' || value.length > 19 || !/^(0|[1-9]\d*)$/.test(value) || (value.length === 19 && value > '9223372036854775807')) throw new Error('附件快照格式无效')
  return BigInt(value)
}
function decryptChunk(key: Uint8Array, identity: SnapshotIdentity, chunk: SnapshotChunk): Buffer {
  if (typeof chunk.ordinal !== 'string' || !/^(0|[1-9]\d*)$/.test(chunk.ordinal) || !(chunk.nonce instanceof Uint8Array) || !(chunk.ciphertext instanceof Uint8Array) || chunk.nonce.length !== 12 || chunk.ciphertext.length < 16 || chunk.ciphertext.length > SNAPSHOT_CHUNK_BYTES + 16) throw new Error('附件快照格式无效')
  try {
    const data = Buffer.from(chunk.ciphertext), cipher = createDecipheriv('aes-256-gcm', key, chunk.nonce)
    cipher.setAAD(chunkAad(identity, chunk.ordinal)); cipher.setAuthTag(data.subarray(-16))
    return Buffer.concat([cipher.update(data.subarray(0,-16)), cipher.final()])
  } catch { throw new Error('附件快照认证失败') }
}
/** 保存回调必须与 manifest 持久化同事务；失败或取消时调用方须回滚。 */
export async function sealAttachmentSnapshot(identity: SnapshotIdentity, source: AsyncIterable<Uint8Array>, keyring: SnapshotKeyring, store: (chunk: SnapshotChunk) => Promise<void>, signal?: AbortSignal): Promise<SnapshotManifest> {
  const bound = { ...identity }; identityValue(bound); signal?.throwIfAborted()
  let version: number
  try { version = keyring.currentVersion() } catch { throw new Error('附件快照密钥不可用') }
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('附件快照密钥不可用')
  const key = randomBytes(32)
  try {
    let wrappedKey: Buffer
    try {
      const wrapped = await keyring.wrap(version, key, keyAad(bound, version))
      if (!(wrapped instanceof Uint8Array) || wrapped.length < 1 || wrapped.length > 4096) throw new Error()
      wrappedKey = Buffer.from(wrapped)
    } catch { throw new Error('附件快照密钥不可用') }
    if (!wrappedKey.length || wrappedKey.length > 4096) throw new Error('附件快照密钥不可用')
    const mac = initialMac(key, bound); let ordinal = 0n, total = 0n
    for await (const input of source) {
      signal?.throwIfAborted()
      if (!(input instanceof Uint8Array)) throw new TypeError('附件快照数据无效')
      for (let offset = 0; offset < input.length; offset += SNAPSHOT_CHUNK_BYTES) {
        signal?.throwIfAborted()
        const part = input.subarray(offset, offset + SNAPSHOT_CHUNK_BYTES), nonce = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(chunkAad(bound, ordinal.toString()))
        const chunk = { ordinal: ordinal.toString(), nonce, ciphertext: Buffer.concat([cipher.update(part), cipher.final(), cipher.getAuthTag()]) }
        await store(chunk); signal?.throwIfAborted(); addChunk(mac, chunk); ordinal++; total += BigInt(part.length)
      }
    }
    const fields = { codecVersion: 1 as const, keyVersion: version, wrappedKey, chunkCount: ordinal.toString(), totalBytes: total.toString() }
    return { ...fields, mac: finalMac(mac, fields) }
  } finally { key.fill(0) }
}
/** 只有视图保证两遍读取完全一致时安全：先验证全部内容，再逐片交付；消费前调用方须验证消息归属。 */
export async function* openAttachmentSnapshot(identity: SnapshotIdentity, manifest: SnapshotManifest, view: StableSnapshotView, keyring: SnapshotKeyring, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const bound = { ...identity }; identityValue(bound); signal?.throwIfAborted()
  if (!(manifest.wrappedKey instanceof Uint8Array) || manifest.wrappedKey.length > 4096 || !(manifest.mac instanceof Uint8Array) || manifest.mac.length !== 32) throw new Error('附件快照格式无效')
  manifest = { ...manifest, wrappedKey: Buffer.from(manifest.wrappedKey), mac: Buffer.from(manifest.mac) }
  const count = parseCount(manifest.chunkCount), total = parseCount(manifest.totalBytes)
  if (manifest.codecVersion !== 1 || !Number.isSafeInteger(manifest.keyVersion) || manifest.keyVersion < 1 || manifest.mac.length !== 32 || !manifest.wrappedKey.length || manifest.wrappedKey.length > 4096) throw new Error('附件快照格式无效')
  let key: Buffer
  try {
    const unwrapped = await keyring.unwrap(manifest.keyVersion, manifest.wrappedKey, keyAad(bound, manifest.keyVersion))
    if (!(unwrapped instanceof Uint8Array) || unwrapped.length !== 32) throw new Error()
    key = Buffer.from(unwrapped)
  } catch { throw new Error('附件快照密钥不可用') }
  if (key.length !== 32) { key.fill(0); throw new Error('附件快照密钥无效') }
  try {
    const mac = initialMac(key, bound); let seen = 0n, bytes = 0n
    for await (const chunk of view.readChunks()) {
      signal?.throwIfAborted()
      if (chunk.ordinal !== seen.toString()) throw new Error('附件快照顺序无效')
      const plain = decryptChunk(key, bound, chunk); bytes += BigInt(plain.length); plain.fill(0)
      addChunk(mac, chunk); seen++
    }
    if (seen !== count || bytes !== total || !timingSafeEqual(finalMac(mac, manifest), Buffer.from(manifest.mac))) throw new Error('附件快照认证失败')
    signal?.throwIfAborted()
    let ordinal = 0n
    for await (const chunk of view.readChunks()) {
      signal?.throwIfAborted()
      if (chunk.ordinal !== ordinal.toString()) throw new Error('附件快照顺序无效')
      const plain = decryptChunk(key, bound, chunk); ordinal++
      yield plain
    }
    if (ordinal !== count) throw new Error('附件快照顺序无效')
  } finally { key.fill(0) }
}
