import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'

/** 每次在内存生成合成证书，测试不保存或复用任何真实私钥。 */
export function syntheticCertificate() {
  const der = (tag: number, value: Uint8Array) => {
    const body = Buffer.from(value), size: number[] = []
    if (body.length < 128) size.push(body.length)
    else { let length = body.length; while (length) { size.unshift(length & 255); length >>>= 8 }; size.unshift(0x80 | size.length) }
    return Buffer.concat([Buffer.from([tag, ...size]), body])
  }
  const sequence = (...values: Uint8Array[]) => der(0x30, Buffer.concat(values))
  const oid = (value: string) => Buffer.from(value, 'hex')
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const algorithm = sequence(oid('06092a864886f70d01010b'), Buffer.from([5, 0]))
  const name = sequence(der(0x31, sequence(oid('0603550403'), der(0x0c, Buffer.from('provider.example')))))
  const extensions = der(0xa3, sequence(
    sequence(oid('0603551d13'), Buffer.from([1, 1, 0xff]), der(4, sequence(Buffer.from([1, 1, 0xff])))),
    sequence(oid('0603551d11'), der(4, sequence(der(0x82, Buffer.from('provider.example')), der(0x82, Buffer.from('proxy.example'))))),
  ))
  const tbs = sequence(der(0xa0, Buffer.from([2, 1, 2])), der(2, Buffer.concat([Buffer.from([1]), randomBytes(15)])), algorithm, name,
    sequence(der(0x17, Buffer.from('200101000000Z')), der(0x17, Buffer.from('400101000000Z'))), name,
    keys.publicKey.export({ format: 'der', type: 'spki' }), extensions)
  const certificate = sequence(tbs, algorithm, der(3, Buffer.concat([Buffer.from([0]), sign('RSA-SHA256', tbs, keys.privateKey)])))
  return { key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n` }
}
