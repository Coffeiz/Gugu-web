import { createCipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'

export const dataImportMaxUploadBytes = 5 * 1024 ** 3
const chunkSize = 1024 * 1024
const magic = Buffer.from('GUGUPV1\0')
const footer = Buffer.from('GGPEND1\0')
const keyInfo = Buffer.from('gugu-data-portability-envelope-v1')

export interface EncryptedUploadStats {
  plaintextSize: number
  archiveSha256: string | null
}

export class DataImportUploadError extends Error {
  constructor(readonly statusCode: 400 | 413, message: string) { super(message) }
}

function encrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}

/** 以 Python EncryptedArchiveWriter 的 GUGUPV1 分块格式加密原始上传流。 */
export async function* encryptDataImportUpload(
  source: AsyncIterable<Uint8Array>,
  secretKey: string,
  context: string,
  stats: EncryptedUploadStats,
  maxBytes = dataImportMaxUploadBytes,
): AsyncGenerator<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('上传大小限制无效')
  const contextHash = createHash('sha256').update(context, 'utf8').digest()
  const salt = randomBytes(16)
  const wrapNonce = randomBytes(12)
  const key = randomBytes(32)
  const noncePrefix = randomBytes(4)
  const hash = createHash('sha256')
  const prefix = Buffer.concat([magic, contextHash, salt, wrapNonce])
  const master = Buffer.from(hkdfSync('sha256', Buffer.from(secretKey, 'utf8'), salt, keyInfo, 32))
  let plaintextSize = 0
  let blockIndex = 0n
  let pending = Buffer.alloc(0)
  try {
    const wrappedKey = encrypt(master, wrapNonce, key, prefix)
    yield Buffer.concat([prefix, wrappedKey, noncePrefix])
    for await (const chunk of source) {
      const bytes = Buffer.from(chunk)
      plaintextSize += bytes.byteLength
      if (plaintextSize > maxBytes) throw new DataImportUploadError(413, '上传归档超过大小限制')
      hash.update(bytes)
      let offset = 0
      while (offset < bytes.length) {
        const count = Math.min(chunkSize - pending.length, bytes.length - offset)
        pending = pending.length ? Buffer.concat([pending, bytes.subarray(offset, offset + count)]) : bytes.subarray(offset, offset + count)
        offset += count
        if (pending.length === chunkSize) {
          yield encryptBlock(pending, contextHash, noncePrefix, key, blockIndex)
          blockIndex += 1n
          pending = Buffer.alloc(0)
        }
      }
    }
    if (plaintextSize === 0) throw new DataImportUploadError(400, '上传归档为空')
    if (pending.length) yield encryptBlock(pending, contextHash, noncePrefix, key, blockIndex)
    const end = Buffer.alloc(16)
    footer.copy(end, 0)
    end.writeBigUInt64BE(BigInt(plaintextSize), 8)
    yield end
    stats.plaintextSize = plaintextSize
    stats.archiveSha256 = hash.digest('hex')
  } finally {
    key.fill(0)
    master.fill(0)
    pending.fill(0)
  }
}

function encryptBlock(plaintext: Uint8Array, contextHash: Buffer, noncePrefix: Buffer, key: Buffer, index: bigint): Buffer {
  const indexBytes = Buffer.alloc(8)
  indexBytes.writeBigUInt64BE(index)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(plaintext.byteLength)
  const nonce = Buffer.concat([noncePrefix, indexBytes])
  const aad = Buffer.concat([contextHash, indexBytes, length])
  return Buffer.concat([length, encrypt(key, nonce, plaintext, aad)])
}
