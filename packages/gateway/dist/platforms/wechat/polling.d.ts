import { type WechatInboundPayload, type WechatMediaRequirement } from './message.js';
import type { GatewayConnection } from '../../index.js';
import type { createILinkClient } from './client.js';
export interface WechatPollingOptions<File = never> {
    botId: string;
    ownerId: string;
    api: Pick<ReturnType<typeof createILinkClient>, 'getUpdates' | 'notifyStart' | 'notifyStop' | 'close'> & Partial<Pick<ReturnType<typeof createILinkClient>, 'getConfig'>>;
    signal: AbortSignal;
    /** 凭据输入/取消预检在下载前执行；不得通过网络消息中的owner取得权限。 */
    preflight(payload: WechatInboundPayload, pendingMedia: boolean, signal: AbortSignal, items: readonly WechatMediaRequirement[], voiceTranscriptionMissing?: true): Promise<'enqueue' | 'consumed'>;
    /** 返回已暂存的附件 ID，或交给原子收件事务的已下载文件。 */
    materialize(items: readonly WechatMediaRequirement[], payload: WechatInboundPayload, signal: AbortSignal): Promise<readonly string[] | {
        files: readonly File[];
    }>;
    /** 必须原子去重与持久化，失败重读整个response时不可再次启动同一消息。 */
    enqueue(payload: WechatInboundPayload, signal: AbortSignal, files: readonly File[]): Promise<void>;
    prefetchTypingTicket?: boolean;
    cursor?: {
        read(): Promise<string | null>;
        write(value: string): Promise<void>;
    };
    sleep?(ms: number, signal: AbortSignal): Promise<void>;
    report?(event: 'poll-unavailable' | 'start-notify-unavailable' | 'stop-notify-unavailable' | 'typing-ticket-unavailable', error?: unknown): void;
}
/** iLink内存游标按完整响应成功后推进；不替代IM队列和Agent业务。 */
export declare function connectWechatPolling<File = never>(options: WechatPollingOptions<File>): Promise<GatewayConnection>;
