import type { ProviderHttpRequest } from '@gugu/core/providers'
import type { ProxyEndpoint } from '@gugu/core/providers/node'

export type PollRequest = Pick<ProviderHttpRequest, 'url' | 'method' | 'headers' | 'timeoutMs'> & { body?: Uint8Array }
export type GatewayWork =
  | { kind: 'poll'; request: PollRequest; proxy?: ProxyEndpoint }
  | { kind: 'feishu'; appId: string; appSecret: string; readyTimeoutMs?: number; proxy?: ProxyEndpoint }
export type HostMessage =
  | { kind: 'start'; work: GatewayWork }
  | { kind: 'stop' }
  | { kind: 'answer'; id: number; ok: boolean; value?: unknown }
export type ChildMessage =
  | { kind: 'result'; value?: unknown }
  | { kind: 'event'; id: number; card: boolean; data: unknown }
  | { kind: 'cancel'; id: number }
  | { kind: 'diagnostic'; code: 'feishu-sdk-error' | 'feishu-sdk-warning' | 'feishu-connection-failed' | 'feishu-cleanup-failed' }
  | { kind: 'failure' }

export type PollResult = { status: number; headers: Readonly<Record<string, string>>; bytes: Uint8Array }
