import type { GatewayClock, GatewayConnection } from '@gugu/gateway';

export type QqMessageEvent = 'C2C_MESSAGE_CREATE' | 'GROUP_AT_MESSAGE_CREATE' | 'GROUP_MESSAGE_CREATE' | 'INTERACTION_CREATE';
export interface QqSocket {
  /** 工厂必须在 close/取消后终止迭代，不得在此端口输出原始报文日志。 */
  packets: AsyncIterable<unknown>;
  send(packet: Readonly<Record<string, unknown>>): Promise<void>;
  close(): Promise<void>;
}
export interface QqConnectionPorts {
  getAccessToken(signal: AbortSignal): Promise<string>;
  getGateway(token: string, signal: AbortSignal): Promise<string>;
  /** 可信 Host 工厂负责 URL/DNS/TLS、安全目标与取消；该端口本身不代表生产安全网络已接通。 */
  openSocket(url: string, signal: AbortSignal): Promise<QqSocket>;
  onEvent(type: QqMessageEvent, data: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<void>;
  clock?: GatewayClock;
  report?(event: 'connection-failed' | 'event-failed' | 'heartbeat-failed' | 'heartbeat-timeout' | 'cleanup-failed'): void;
}
const intents = (1 << 25) | (1 << 30) | (1 << 12) | (1 << 26);
const reconnectDelays = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const events = new Set<string>(['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE', 'INTERACTION_CREATE']);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const defaultClock: GatewayClock = {
  now: () => performance.now(),
  sleep(ms, signal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(new Error('QQ 连接已取消')); return; }
      const abort = () => { clearTimeout(timer); reject(new Error('QQ 连接已取消')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  },
};

/** QQ raw WebSocket 协议运行时。Token 仅用于内存握手，不进入 URL、公开错误或日志。 */
export function createQqConnection(ports: QqConnectionPorts): GatewayConnection {
  const lifetime = new AbortController();
  const clock = ports.clock ?? defaultClock;
  let socket: QqSocket | undefined;
  let sessionId: string | undefined;
  let lastSeq: number | undefined;
  let attempt = 0;
  let closeSocket: (() => Promise<void>) | undefined;
  let cleanupFailed = false;

  async function run() {
    while (!lifetime.signal.aborted) {
      const connection = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, connection.signal]);
      let heartbeat: Promise<void> | undefined;
      let heartbeatController: AbortController | undefined;
      let current: QqSocket | undefined;
      let lastAck = clock.now();
      let closing: Promise<void> | undefined;
      const close = (): Promise<void> => {
        if (!closing) closing = (async () => {
          try { await current?.close(); } catch { cleanupFailed = true; ports.report?.('cleanup-failed'); }
        })();
        return closing;
      };
      const abort = () => { void close(); };
      try {
        const token = await ports.getAccessToken(signal);
        if (!token) throw new Error();
        const url = await ports.getGateway(token, signal);
        signal.throwIfAborted();
        current = await ports.openSocket(url, signal);
        socket = current; closeSocket = close;
        signal.addEventListener('abort', abort, { once: true });
        signal.throwIfAborted();
        attempt = 0;
        for await (const raw of current.packets) {
          signal.throwIfAborted();
          if (!object(raw) || !Number.isSafeInteger(raw.op)) throw new Error();
          const sequence = typeof raw.s === 'number' && Number.isSafeInteger(raw.s) ? raw.s : undefined;
          const businessDispatch = raw.op === 0 && typeof raw.t === 'string' && events.has(raw.t);
          // 可处理事件必须先可靠接收入队，再提交RESUME水位，避免失败消息被跳过。
          if (!businessDispatch && sequence !== undefined) lastSeq = sequence;
          const data = object(raw.d) ? raw.d : {};
          if (raw.op === 10) {
            heartbeatController?.abort(); await heartbeat;
            heartbeatController = new AbortController();
            const heartbeatSignal = AbortSignal.any([signal, heartbeatController.signal]);
            const interval = typeof data.heartbeat_interval === 'number' && Number.isFinite(data.heartbeat_interval) && data.heartbeat_interval > 0 ? data.heartbeat_interval : 45_000;
            lastAck = clock.now();
            heartbeat = (async () => {
              try {
                while (!heartbeatSignal.aborted) {
                  await clock.sleep(interval, heartbeatSignal);
                  if (heartbeatSignal.aborted) return;
                  if (clock.now() - lastAck >= interval * 2.5) {
                    ports.report?.('heartbeat-timeout'); await close(); connection.abort(); return;
                  }
                  await current!.send({ op: 1, d: lastSeq ?? null });
                }
              } catch {
                if (!heartbeatSignal.aborted) { ports.report?.('heartbeat-failed'); await close(); connection.abort(); }
              }
            })();
            if (sessionId && lastSeq !== undefined) await current.send({ op: 6, d: { token: `QQBot ${token}`, session_id: sessionId, seq: lastSeq } });
            else await current.send({ op: 2, d: { token: `QQBot ${token}`, intents, shard: [0, 1] } });
          } else if (raw.op === 11) lastAck = clock.now();
          else if (raw.op === 0) {
            if (raw.t === 'READY') sessionId = typeof data.session_id === 'string' && data.session_id ? data.session_id : undefined;
            else if (typeof raw.t === 'string' && events.has(raw.t)) {
              try { await ports.onEvent(raw.t as QqMessageEvent, data, signal); }
              catch {
                if (!signal.aborted) ports.report?.('event-failed');
                throw new Error();
              }
              if (sequence !== undefined) lastSeq = sequence;
            }
          } else if (raw.op === 7) break;
          else if (raw.op === 9) { sessionId = undefined; lastSeq = undefined; break; }
        }
      } catch { if (!signal.aborted) ports.report?.('connection-failed'); }
      finally {
        connection.abort(); heartbeatController?.abort();
        signal.removeEventListener('abort', abort);
        await close(); await heartbeat;
        if (socket === current) { socket = undefined; closeSocket = undefined; }
        // 关闭未确认时不能继续建立第二条连接；由可信Host处理清理失败。
        if (cleanupFailed) throw new Error('QQ 连接未能完全停止');
      }
      if (lifetime.signal.aborted) break;
      await clock.sleep(reconnectDelays[Math.min(attempt, reconnectDelays.length - 1)]!, lifetime.signal).catch(() => undefined);
      attempt++;
    }
  }
  const closed = run();
  return { closed, async stop() { lifetime.abort(); await closeSocket?.(); await closed; } };
}
