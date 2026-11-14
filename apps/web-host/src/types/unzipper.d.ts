declare module 'unzipper' {
  export const Open: {
    file(path: string): Promise<{ files: Array<{
      path: string
      type: string
      vars: { flags: number; uncompressedSize: number; externalFileAttributes?: number }
      stream(): import('node:stream').Readable
    }> }>
  }
}
