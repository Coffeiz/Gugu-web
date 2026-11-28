export interface FileLogPolicy {
  readonly maxBytes: number
  readonly backups: number
}

export function isLogArchive(path: string, name: string): boolean
export function createLogWriter(path: string, policy: FileLogPolicy): (line: string) => void
