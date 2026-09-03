/** 通用图表工具：折线图 options 工厂 + token 缩略格式化。
 *  所有 canvas 图表颜色必须走设计令牌（见 agentskills/design/SKILL.md 令牌陷阱一节），
 *  chart.js 不继承 CSS 颜色，用 cssVar() 运行时解析。 */
import { computed } from 'vue'
import { useTheme } from '@/composables/core/useTheme'

/** 主题/调色板信号：options 工厂读取它建立响应式依赖，主题或调色板切换时
 *  依赖它的 computed/渲染会重新求值，canvas 颜色随之刷新（cssVar 本身是一次性求值）。 */
export const chartThemeKey = computed(() => {
  const { resolved, palette, family } = useTheme()
  return `${resolved.value}/${palette.value}/${family.value}`
})

/** token 数缩略显示：≥1M 显示 x.xM，≥1K 显示 x.xK，其余原样。 */
export function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

/** 读取设计 token 的计算值（SSR / 环境异常时退回 fallback）。 */
export function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

// tooltip 采用内置 canvas 绘制：与数据点的间距 = caretSize + caretPadding
// （源码 getBackgroundPoint），margin 不参与该距离。内置 tooltip 受画布高度限制，
// 多行 tooltip 需要足够图高才能放在数据点上方（容器高度参考 AdminLineChart 的 180px+）。

export type LineChartOptionsInput = {
  /** Y 轴刻度用 token 缩略（fmtTok）；false 时显示原始数字。 */
  isTok?: boolean
  /** 自定义 tooltip 每行文案；缺省按 dataset 原始值输出。 */
  tooltipLabel?: (ctx: any) => string
  /** tooltip 主体之后的附加行（如输入/输出拆分）。 */
  afterBody?: (items: any[]) => string[]
  /** 多 dataset 时显示底部图例。 */
  showLegend?: boolean
}

/** 折线图统一 options：令牌配色、首尾点贴合边缘、DOM tooltip 浮于容器之上。 */
export function lineChartOptions(input: LineChartOptionsInput = {}) {
  void chartThemeKey.value   // 建立主题响应式依赖：主题切换时重新求值配色
  const isTok = input.isTok ?? false
  const grid = cssVar('--chart-grid-line', 'rgba(255,255,255,0.04)')
  const tick = cssVar('--chart-tick', 'rgba(255,255,255,0.25)')
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    interaction: { mode: 'index' as const, intersect: false },
    layout: { padding: { top: 4, left: 8, right: 8 } },
    plugins: {
      legend: {
        display: input.showLegend ?? false,
        position: 'bottom' as const,
        labels: { color: tick, boxWidth: 10, font: { size: 11 } },
      },
      tooltip: {
        mode: 'index' as const,
        intersect: false,
        displayColors: false,
        caretSize: 6,
        caretPadding: 10,
        backgroundColor: cssVar('--surface-floating', 'rgba(10,10,22,0.92)'),
        borderColor: cssVar('--border-subtle', 'rgba(255,255,255,0.08)'),
        borderWidth: 1,
        titleColor: tick,
        bodyColor: cssVar('--content-primary', 'rgba(255,255,255,0.85)'),
        padding: 10,
        callbacks: {
          label: input.tooltipLabel ?? ((ctx: any) => (isTok ? fmtTok(ctx.raw) : String(ctx.raw))),
          ...(input.afterBody ? { afterBody: input.afterBody } : {}),
        },
      },
    },
    scales: {
      x: {
        // 不用 offset：首尾数据点贴合图表左右边缘；边缘刻度文字由 layout.padding 留白承接。
        grid: { color: grid },
        border: { color: 'transparent' },
        ticks: { color: tick, font: { size: 10 }, maxTicksLimit: 8 },
      },
      y: {
        grid: { color: grid },
        border: { color: 'transparent' },
        ticks: {
          color: tick, font: { size: 10 }, maxTicksLimit: 4,
          callback: isTok ? (v: any) => fmtTok(v) : undefined,
        },
        beginAtZero: true,
        // 顶部留 5% 余量：峰值不贴顶。
        grace: '5%',
      },
    },
  }
}

export type BarChartOptionsInput = {
  /** tooltip 每行文案定制。 */
  tooltipLabel?: (ctx: any) => string
}

/** 纵向柱状图统一 options：令牌配色（x 为分类轴无网格，y 为数值轴）。 */
export function barChartOptions(input: BarChartOptionsInput = {}) {
  void chartThemeKey.value   // 建立主题响应式依赖：主题切换时重新求值配色
  const grid = cssVar('--chart-grid-line', 'rgba(255,255,255,0.04)')
  const tick = cssVar('--chart-tick', 'rgba(255,255,255,0.25)')
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    plugins: {
      legend: { display: false },
      tooltip: {
        displayColors: false,
        caretPadding: 10,
        backgroundColor: cssVar('--surface-floating', 'rgba(10,10,22,0.92)'),
        borderColor: cssVar('--border-subtle', 'rgba(255,255,255,0.08)'),
        borderWidth: 1,
        titleColor: tick,
        bodyColor: cssVar('--content-primary', 'rgba(255,255,255,0.85)'),
        padding: 10,
        callbacks: {
          label: input.tooltipLabel ?? ((ctx: any) => String(ctx.raw)),
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: 'transparent' },
        ticks: { color: tick, font: { size: 11 } },
      },
      y: {
        grid: { color: grid },
        border: { color: 'transparent' },
        ticks: { color: tick, font: { size: 10 }, precision: 0 },
        beginAtZero: true,
      },
    },
  }
}
