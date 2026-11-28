import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
const AES_BLOCK_BYTES = 16;
function invalid() {
    // 不携带密钥、媒体内容或底层 OpenSSL 异常。
    throw new Error('微信媒体加解密参数或数据无效');
}
function requireKey(key) {
    if (!(key instanceof Uint8Array) || key.byteLength !== AES_BLOCK_BYTES)
        invalid();
}
/** 完整块仍需追加一整块 PKCS7；拒绝精度溢出，避免媒体长度被静默截断。 */
export function aesEcbPaddedSize(plaintextSize) {
    if (!Number.isSafeInteger(plaintextSize) || plaintextSize < 0)
        invalid();
    const size = plaintextSize + AES_BLOCK_BYTES - plaintextSize % AES_BLOCK_BYTES;
    if (!Number.isSafeInteger(size))
        invalid();
    return size;
}
export function genAesKey() {
    return randomBytes(AES_BLOCK_BYTES);
}
export function aeskeyToHex(key) {
    requireKey(key);
    return Buffer.from(key).toString('hex');
}
/** iLink 要求 base64(ASCII hex)，不能直接编码 16 字节原始密钥。 */
export function aeskeyToB64(key) {
    return Buffer.from(aeskeyToHex(key), 'ascii').toString('base64');
}
export function encryptAesEcb(plaintext, key) {
    requireKey(key);
    if (!(plaintext instanceof Uint8Array))
        invalid();
    aesEcbPaddedSize(plaintext.byteLength);
    try {
        const cipher = createCipheriv('aes-128-ecb', key, null);
        return Buffer.concat([cipher.update(plaintext), cipher.final()]);
    }
    catch {
        return invalid();
    }
}
/** 严格模式对应 Python media_crypto.decrypt_aes_ecb，拒绝无效 PKCS7。 */
export function decryptAesEcb(ciphertext, key) {
    return decrypt(ciphertext, key, false);
}
/** 入站兼容 Python runtime：仅移除合法 PKCS7，否则保留原始完整块。 */
export function decryptInboundAesEcb(ciphertext, key) {
    return decrypt(ciphertext, key, true);
}
function decrypt(ciphertext, key, inbound) {
    requireKey(key);
    if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength % AES_BLOCK_BYTES !== 0)
        invalid();
    try {
        const cipher = createDecipheriv('aes-128-ecb', key, null);
        cipher.setAutoPadding(false);
        const padded = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
        const pad = padded.at(-1) ?? 0;
        if (pad >= 1 && pad <= AES_BLOCK_BYTES && padded.subarray(-pad).every(byte => byte === pad)) {
            return padded.subarray(0, padded.byteLength - pad);
        }
        if (inbound)
            return padded;
    }
    catch {
        return invalid();
    }
    return invalid();
}
export function genFilekeyHex() {
    return randomBytes(AES_BLOCK_BYTES).toString('hex');
}
/** MD5 是 iLink 上传协议字段，不作为安全签名。 */
export function md5Hex(data) {
    if (!(data instanceof Uint8Array))
        invalid();
    return createHash('md5').update(data).digest('hex');
}
export function encryptForUpload(plaintext) {
    const aeskey = genAesKey();
    const ciphertext = encryptAesEcb(plaintext, aeskey);
    return { aeskey, ciphertext, paddedSize: ciphertext.byteLength };
}
