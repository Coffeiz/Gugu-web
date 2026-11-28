declare module 'unzipper' {
  export const Open: {
    file(path: string, options?: { tailSize: number }): Promise<{ files: Array<{
      path: string
      flags: number
      compressionMethod: number
      externalFileAttributes: number
      compressedSize: number
      uncompressedSize: number
      stream(): import('node:stream').Readable
    }> }>
    buffer(data: Buffer, options?: { tailSize: number }): ReturnType<typeof Open.file>
  }
}
