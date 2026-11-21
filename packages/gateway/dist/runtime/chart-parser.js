const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
export const validImChartPng = (bytes) => bytes instanceof Uint8Array && bytes.byteLength >= 8 && bytes.byteLength <= 3 * 1024 * 1024 && pngSignature.every((byte, index) => bytes[index] === byte);
/** 增量跟踪顶层围栏；源码始终原样透传，渲染失败不能改写canonical正文。 */
export function createImChartParser(options) {
    let line = '', outer = null;
    let chart = null;
    if (options.checkpoint !== undefined) {
        const raw = options.checkpoint;
        if (!raw || typeof raw !== 'object' || raw.v !== 1 || typeof raw.line !== 'string'
            || raw.outer !== null && (!raw.outer || typeof raw.outer !== 'object' || !['`', '~'].includes(String(raw.outer.marker)) || !Number.isSafeInteger(raw.outer.size) || Number(raw.outer.size) < 3)
            || raw.chart !== null && (!raw.chart || typeof raw.chart !== 'object' || !['mermaid', 'math'].includes(String(raw.chart.type))
                || typeof raw.chart.body !== 'string' || typeof raw.chart.source !== 'string'))
            throw new Error('即时通讯图表投影状态无效');
        line = raw.line;
        outer = structuredClone(raw.outer);
        chart = structuredClone(raw.chart);
    }
    async function completedLine(value, terminated) {
        const content = value.replace(/\r?\n$/, ''), fence = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(content);
        if (chart) {
            if (fence && fence[1][0] === '`' && fence[1].length >= 3 && !fence[2].trim()) {
                const completed = chart;
                chart = null;
                const source = completed.source + content;
                if (!completed.body || [...completed.body].length > 20000)
                    return [];
                try {
                    const bytes = (await options.renderCharts({ charts: [{ type: completed.type, source: completed.body }], ...(options.theme ? { theme: options.theme } : {}) }, options.signal))[0];
                    return bytes && validImChartPng(bytes) ? [{ type: 'chart_image', source, png: bytes }] : [];
                }
                catch {
                    return [];
                } // 渲染错误仅保留原文，不传播含源码或环境信息的异常。
            }
            chart.source += value;
            chart.body += value;
            // 超限源码保持普通代码围栏，后续内部示例不能被误识别。
            if (chart.body.length > 80000) {
                chart = null;
                outer = { marker: '`', size: 3 };
            }
            return [];
        }
        if (!fence)
            return [];
        const marker = fence[1][0], size = fence[1].length, info = fence[2].trim();
        if (outer) {
            if (marker === outer.marker && size >= outer.size && !info)
                outer = null;
            return [];
        }
        const language = info.split(/\s+/)[0].toLowerCase();
        if (terminated && marker === '`' && size === 3 && ['mermaid', 'tex', 'latex'].includes(language))
            chart = { type: language === 'mermaid' ? 'mermaid' : 'math', body: '', source: value };
        else
            outer = { marker, size };
        return [];
    }
    return {
        snapshot() { return { v: 1, line, outer, chart }; },
        async append(text) {
            const result = [];
            line += text;
            let newline;
            while ((newline = line.indexOf('\n')) >= 0) {
                const complete = line.slice(0, newline + 1);
                line = line.slice(newline + 1);
                result.push(...await completedLine(complete, true));
            }
            return result;
        },
        async finish() {
            const charts = line ? await completedLine(line, false) : [];
            line = '';
            return charts;
        },
    };
}
