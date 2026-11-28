import type { ProviderTransport } from '@gugu/core/providers';
import type { ParsedQqMessage } from './message.js';
type Value = Record<string, unknown>;
interface QFaceAsset {
    url: string;
    filename: string;
    mime: 'image/png';
}
/** Python QFace选择顺序；只接受固定公共资源目录，不能由索引注入远程目标。 */
export declare function selectQqFaceAsset(index: readonly Value[], faceId: string): QFaceAsset | null;
export declare function createQqFaceResolver(options: {
    transport: Pick<ProviderTransport, 'request'>;
    now?(): number;
    report?(code: 'qface-unavailable'): void;
}): {
    appendAssets: (parsed: ParsedQqMessage, signal: AbortSignal) => Promise<void>;
    close(): Promise<void>;
};
export {};
