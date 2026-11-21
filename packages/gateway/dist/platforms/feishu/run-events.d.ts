import type { RunEvent } from '@gugu/core/agent';
import { createImChartParser, type ImChartRenderer } from '../../runtime/chart-parser.js';
import type { FeishuToolEvent } from './presentation.js';
export interface FeishuStreamFinal {
    type: 'final';
    text: string;
    cancelled?: boolean;
    hasFiles?: boolean;
}
export type FeishuStreamEvent = {
    type: 'token';
    text: string;
} | FeishuStreamFinal | FeishuToolEvent | {
    type: 'round_end';
} | {
    type: 'chart_image';
    source: string;
    png: Uint8Array;
};
/** 增量跟踪顶层围栏；源码始终原样透传，渲染失败不能改写canonical正文。 */
export declare function createFeishuRunEventProjector(options?: {
    renderCharts?: ImChartRenderer;
    theme?: Parameters<typeof createImChartParser>[0]['theme'];
    signal?: AbortSignal;
    checkpoint?: unknown;
}): {
    snapshot: () => unknown;
    /** 调用方须按RunEvent顺序await；不执行平台发送，不新增业务事件或Agent循环。 */
    push(event: RunEvent): Promise<FeishuStreamEvent[]>;
};
