export type ChartType = 'mermaid' | 'math'
export type ChartRequest = {
  charts: Array<{ type: ChartType; source: string }>
  theme?: {
    theme?: 'light' | 'dark' | 'system'
    themeFamily?: 'glass' | 'mono'
    palette?: 'cafe' | 'neutral' | 'red' | 'blue' | 'green'
  }
}
export class ChartRenderError extends Error {
  readonly code: string
}
export function renderCharts(request: ChartRequest, options?: { signal?: AbortSignal }): Promise<Array<Buffer | null>>
