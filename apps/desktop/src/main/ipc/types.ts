import type { CoreHost } from '../core-host.js'

export type IpcHost = Pick<CoreHost, 'request'> & Partial<Pick<CoreHost, 'onAgentRunChanged'>>
export type IpcHandlers = Record<string, (...args: unknown[]) => Promise<unknown>>
