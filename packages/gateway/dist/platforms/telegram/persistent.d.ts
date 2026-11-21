import type { ImConversationScope } from '../../ir/inbound.js';
import type { ImPlatformProjectionStore } from '../../runtime/projection-store.js';
import { type RunIdentity } from '@gugu/core/agent';
import type { ImDeliveryAcknowledgement, ImRunDeliveryPorts } from '@gugu/core/im/run-delivery';
import type { createTelegramSender, TelegramTarget } from './sender.js';
import type { ImChartRenderer as FeishuChartRenderer } from '../../index.js';
import type { FeishuToolSummaryPolicy } from '../feishu/index.js';
/** 唯一调用者是共享run-delivery；草稿不是正式成功送达事实，不能替代final收据。 */
export interface TelegramProjectionOptions {
    identity: RunIdentity;
    target: TelegramTarget;
    policyVersion: string;
    receipts: Pick<ImRunDeliveryPorts<unknown>['receipts'], 'begin' | 'settle'> & {
        projection?: ImPlatformProjectionStore;
    };
    sender: Pick<ReturnType<typeof createTelegramSender>, 'draft' | 'text' | 'file'>;
    authorize(): Promise<boolean>;
    signal?: AbortSignal;
    acceptedEvidence?: {
        scope: ImConversationScope;
        recipient: string;
        accept(value: {
            platformMessageIds: string[];
            text: string;
        }): Promise<ImDeliveryAcknowledgement>;
    };
    showIntermediateReplies?: boolean;
    toolSummary?: FeishuToolSummaryPolicy;
    renderCharts?: FeishuChartRenderer;
    now?(): number;
}
export declare function createPersistentTelegramProjection(options: TelegramProjectionOptions): NonNullable<ImRunDeliveryPorts<unknown>['stream']> & {
    close(): Promise<void>;
};
