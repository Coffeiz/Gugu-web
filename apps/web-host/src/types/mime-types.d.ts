declare module 'mime-types' {
  export function lookup(path: string): string | false
  export function extension(mimeType: string): string | false
}
