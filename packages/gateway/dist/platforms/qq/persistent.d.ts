import { type RunIdentity, type RunEvent } from '@gugu/core/agent';
import type { ImRunDeliveryPorts, ImDeliveryAcknowledgement } from '@gugu/core/im/run-delivery';
import { type createQqSender, type QqTarget, type QqReceipt } from './sender.js';
import type { ImConversationScope } from '../../ir/inbound.js';
import type { ImPlatformProjectionStore } from '../../runtime/projection-store.js';
export interface QqChartProjection {
    prepare(events: AsyncIterable<RunEvent>): AsyncIterable<RunEvent>;
    close(): Promise<void>;
    parser(checkpoint?: unknown): {
        snapshot(): unknown;
        push(event: RunEvent): Promise<readonly ({
            type: 'chart_image';
            png: Uint8Array;
        } | {
            type: 'other';
        })[]>;
    };
    send(png: Uint8Array): Promise<QqReceipt>;
}
export interface QqProjectionOptions {
    identity: RunIdentity;
    target: QqTarget;
    legacyMessageId?: string;
    policyVersion: string;
    receipts: Pick<ImRunDeliveryPorts<unknown>['receipts'], 'begin' | 'settle'> & {
        projection?: ImPlatformProjectionStore;
    };
    sender: Pick<ReturnType<typeof createQqSender>, 'privateStream' | 'text' | 'prepareText'>;
    authorize(): Promise<boolean>;
    acceptedEvidence?: {
        scope: ImConversationScope;
        recipient: string;
        accept(input: {
            platformMessageIds: string[];
            text: string;
        }): Promise<ImDeliveryAcknowledgement>;
    };
    observeAcceptedText?(value: {
        platformMessageIds: readonly string[];
        text: string;
    }): Promise<void>;
    now?(): number;
    charts?: QqChartProjection;
}
/** QQ 刷新与 Run 事件共用串行投递队列和持久回执。 */
export declare function createPersistentQqProjection(options: QqProjectionOptions): NonNullable<ImRunDeliveryPorts<unknown>['stream']> & {
    prepare?(events: AsyncIterable<RunEvent>): AsyncIterable<RunEvent>;
    close?(): Promise<void>;
};
