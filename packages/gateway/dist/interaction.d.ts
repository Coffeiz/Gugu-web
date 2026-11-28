type Payload = Record<string, unknown>;
/** QQ 协议 ACK 只依赖事件 ID，旧按钮参数仍由业务入口独立校验。 */
export declare function qqInteractionEventId(data: Payload): string;
interface Parsed {
    promptId: number;
    token: string;
    operator: string;
    eventId: string;
    messageId: string | null;
    chatId: string;
    chatType?: 'c2c' | 'group';
}
export declare function parseGatewayInteraction(platform: string, data: Payload): Parsed;
export {};
