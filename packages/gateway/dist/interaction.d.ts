type Payload = Record<string, unknown>;
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
