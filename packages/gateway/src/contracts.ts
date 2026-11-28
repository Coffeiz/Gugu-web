/** Host 配置监督器；配置读取、通知连接及平台生命周期由生产装配显式注入。 */
export interface GatewayBotSpec {
  key: string;
  /** 可信配置版本，必须随影响连接的字段改变；不可使用凭据作为公开版本。 */
  revision: string;
}
export interface GatewayConnection {
  /** 仅在资源全部释放时resolve；reject表示清理未知，监督器不得替代启动。 */
  closed: Promise<void>;
  /** 必须中断连接并等待所有入站任务退出。 */
  stop(): Promise<void>;
}
/** 首次连接尚未交付，但底层资源释放未知；不能按普通握手失败启动替代消费者。 */
export class GatewayConnectionCleanupError extends Error {
  constructor() { super('网关初始连接资源清理未完成'); }
}
export interface GatewaySubscription {
  disconnected: Promise<void>;
  close(): Promise<void>;
}
export interface GatewayClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
export interface GatewaySupervisorPorts<S extends GatewayBotSpec> {
  read(): Promise<readonly S[]>;
  subscribe(notify: () => void, signal: AbortSignal): Promise<GatewaySubscription>;
  connect(spec: S, signal: AbortSignal): Promise<GatewayConnection>;
  clock?: GatewayClock;
  /** 只发送固定事件码，不传播凭据、用户输入或异常文本。 */
  report?(event: 'config-unavailable' | 'listener-unavailable' | 'connection-failed' | 'cleanup-failed', error?: unknown): void;
}
