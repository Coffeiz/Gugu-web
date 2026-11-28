import type { ImConversationScope } from '../../ir/inbound.js';
import type { ImPlatformProjectionStore } from '../../runtime/projection-store.js';
import { type RunIdentity } from '@gugu/core/agent';
import type { ImDeliveryAcknowledgement, ImRunDeliveryPorts } from '@gugu/core/im/run-delivery';
import { type createFeishuClient } from './client.js';
import { type FeishuToolSummaryPolicy } from './presentation.js';
import type { ImChartRenderer as FeishuChartRenderer } from '../../runtime/chart-parser.js';
/** 按顺序投影运行事件，平台操作使用宿主提供的持久回执。 */
export interface FeishuProjectionOptions {
    identity: RunIdentity;
    receiveId: string;
    policyVersion: string;
    receipts: Pick<ImRunDeliveryPorts<unknown>['receipts'], 'begin' | 'settle'> & {
        projection?: ImPlatformProjectionStore;
    };
    client: Pick<ReturnType<typeof createFeishuClient>, 'call'>;
    authorize(): Promise<boolean>;
    signal?: AbortSignal;
    toolSummary?: FeishuToolSummaryPolicy;
    renderCharts?: FeishuChartRenderer;
    acceptedEvidence?: {
        scope: ImConversationScope;
        recipient: string;
        accept(value: {
            platformMessageIds: string[];
            text: string;
        }): Promise<ImDeliveryAcknowledgement>;
    };
    now?(): number;
}
export declare function createPersistentFeishuProjection(options: FeishuProjectionOptions): NonNullable<ImRunDeliveryPorts<unknown>['stream']>;
