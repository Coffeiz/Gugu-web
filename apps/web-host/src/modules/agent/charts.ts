import { renderCharts, type ChartRequest } from '@gugu/charts/render'

/** Node Host 的受限图像渲染入口；实际 Mermaid/MathJax 工作留在隔离子进程。 */
export function renderAgentCharts(request: ChartRequest, signal?: AbortSignal) {
  return renderCharts(request, { signal })
}
