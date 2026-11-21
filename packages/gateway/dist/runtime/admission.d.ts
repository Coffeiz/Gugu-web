import type { ImConversationScope } from '../ir/inbound.js';
export type ImAdmissionScope = ImConversationScope & {
    readonly eventId: string;
};
export declare class ImGatewayAdmissionError extends Error {
    readonly code: 'invalid_input' | 'unauthorized' | 'conflict' | 'pending' | 'unknown' | 'unavailable';
    constructor(code: ImGatewayAdmissionError['code']);
}
export declare function requireImAdmissionId(value: unknown, max?: number): string;
/** 宿主提供带域隔离的摘要函数，避免把平台原生标识保存为可见键。 */
export declare function imAdmissionKeys(scope: ImAdmissionScope, digest: (value: unknown) => string): {
    scopeHash: string;
    eventHash: string;
};
