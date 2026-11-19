import type { CoreHost } from '../core-host.js'

export type IpcHost = Pick<CoreHost, 'request'>
export type IpcHandlers = Record<string, (...args: unknown[]) => Promise<unknown>>
