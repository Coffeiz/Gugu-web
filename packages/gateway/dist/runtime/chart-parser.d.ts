type ChartRequest = {
    charts: Array<{
        type: 'mermaid' | 'math';
        source: string;
    }>;
    theme?: {
        theme?: 'light' | 'dark' | 'system';
        themeFamily?: 'glass' | 'mono';
        palette?: 'cafe' | 'neutral' | 'red' | 'blue' | 'green';
    };
};
export type ImChartRenderer = (request: ChartRequest, signal?: AbortSignal) => Promise<readonly (Uint8Array | null)[]>;
type ImChartImage = {
    type: 'chart_image';
    source: string;
    png: Uint8Array;
};
export declare const validImChartPng: (bytes: Uint8Array) => boolean;
/** 增量跟踪顶层围栏；源码始终原样透传，渲染失败不能改写canonical正文。 */
export declare function createImChartParser(options: {
    renderCharts: ImChartRenderer;
    theme?: ChartRequest['theme'];
    signal?: AbortSignal;
    checkpoint?: unknown;
}): {
    snapshot(): unknown;
    append(text: string): Promise<ImChartImage[]>;
    finish(): Promise<ImChartImage[]>;
};
export {};
