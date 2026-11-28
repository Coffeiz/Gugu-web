/** 完整块仍需追加一整块 PKCS7；拒绝精度溢出，避免媒体长度被静默截断。 */
export declare function aesEcbPaddedSize(plaintextSize: number): number;
export declare function genAesKey(): Buffer;
export declare function aeskeyToHex(key: Uint8Array): string;
/** iLink 要求 base64(ASCII hex)，不能直接编码 16 字节原始密钥。 */
export declare function aeskeyToB64(key: Uint8Array): string;
export declare function encryptAesEcb(plaintext: Uint8Array, key: Uint8Array): Buffer;
/** 严格模式对应 Python media_crypto.decrypt_aes_ecb，拒绝无效 PKCS7。 */
export declare function decryptAesEcb(ciphertext: Uint8Array, key: Uint8Array): Buffer;
/** 入站兼容 Python runtime：仅移除合法 PKCS7，否则保留原始完整块。 */
export declare function decryptInboundAesEcb(ciphertext: Uint8Array, key: Uint8Array): Buffer;
export declare function genFilekeyHex(): string;
/** MD5 是 iLink 上传协议字段，不作为安全签名。 */
export declare function md5Hex(data: Uint8Array): string;
export declare function encryptForUpload(plaintext: Uint8Array): {
    aeskey: Buffer;
    ciphertext: Buffer;
    paddedSize: number;
};
