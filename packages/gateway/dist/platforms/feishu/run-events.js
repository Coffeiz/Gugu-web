import { resolveImToolLabel } from '@gugu/core/im/run-delivery';
import { createImChartParser } from '../../runtime/chart-parser.js';
/** 增量跟踪顶层围栏；源码始终原样透传，渲染失败不能改写canonical正文。 */
export function createFeishuRunEventProjector(options = {}) {
    const parser = createImChartParser({ ...options, renderCharts: options.renderCharts ?? (async () => []) });
    return {
        snapshot: parser.snapshot,
        /** 调用方须按RunEvent顺序await；不执行平台发送，不新增业务事件或Agent循环。 */
        async push(event) {
            const payload = event.payload;
            if (event.type === 'token' && typeof payload.text === 'string')
                return [{ type: 'token', text: payload.text }, ...await parser.append(payload.text)];
            if (event.type === 'tool_call' || event.type === 'tool_done')
                return [{ type: event.type,
                        ...(typeof payload.toolCallId === 'string' ? { toolCallId: payload.toolCallId } : {}),
                        ...(typeof payload.name === 'string' ? { name: payload.name, label: resolveImToolLabel(payload.name, payload.display, undefined, options.toolSummary?.locale) } : {}),
                        ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
                        ...('display' in payload ? { display: payload.display } : {}),
                        ...('result' in payload ? { result: payload.result } : {}),
                    }];
            if (event.type === 'round_end')
                return [{ type: 'round_end' }];
            if (event.type === 'final') {
                const charts = await parser.finish();
                return [...charts, { type: 'final', text: typeof payload.text === 'string' ? payload.text : '', cancelled: payload.status === 'cancelled', hasFiles: Array.isArray(payload.files) && payload.files.length > 0 }];
            }
            return [];
        },
    };
}
