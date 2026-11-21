import type { InjectionKey } from 'vue'

type TerminalSize = { cols: number; rows: number }
type LocalPty = {
  open(size: TerminalSize): Promise<void>
  resize(size: TerminalSize): void
  input(data: string): void
  close(): Promise<void>
}

export type CreateLocalPty = (terminalId: string, callbacks: {
  output(data: string): void
  ready(): void
  exit(): void
  error(cause: unknown): void
  foreground(): boolean
}) => LocalPty

export const localPtyAccessKey: InjectionKey<CreateLocalPty> = Symbol('localPtyAccess')
