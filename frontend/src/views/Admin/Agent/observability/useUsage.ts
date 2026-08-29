import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useAdminStore } from '@/stores/admin'
import { browserTz } from '@/utils/dateAttribution'

export function useUsage() {
  const adminStore = useAdminStore()
  const usage = ref<any | null>(null)
  const usageLoading = ref(false)
  const activeModel = ref<string | null>(null)
  const activeMetric = ref('calls')
  const hoverIdx = ref(-1)
  const chartWidth = ref(600)
  const CHART_H = 240; const PAD_L = 40; const PAD_R = 12; const PAD_T = 14; const PAD_B = 28
  async function fetchUsage(month?: string, model = activeModel.value) {
    usageLoading.value = true
    try { const params = new URLSearchParams({ timezone: browserTz() }); if (month) params.set('month', month); if (model) params.set('model', model); const res = await adminStore.authFetch(`/api/v1/admin/agent/usage?${params}`); if (!res.ok) throw new Error(`加载失败（${res.status}）`); usage.value = await res.json() }
    finally { usageLoading.value = false }
  }
  function fmtNum(n: number | null | undefined) { if (n == null) return '0'; if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`; if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`; return String(n) }
  const metrics = [{ key: 'calls', label: '对话次数', unit: '次' }, { key: 'tokens_in', label: '输入 tokens', unit: '' }, { key: 'tokens_out', label: '输出 tokens', unit: '' }, { key: 'cache_ratio', label: '缓存命中率', unit: '%' }, { key: 'cache_write', label: '写入缓存', unit: '' }]
  const monthIndex = computed(() => usage.value?.months?.indexOf(usage.value.month) ?? 0)
  const chartPoints = computed(() => { const data = usage.value?.daily || []; const values = data.map((d: any) => d[activeMetric.value] ?? 0); const max = Math.max(...values, 1); const step = (chartWidth.value - PAD_L - PAD_R) / Math.max(values.length - 1, 1); return values.map((value: number, i: number) => ({ x: PAD_L + i * step, y: PAD_T + (1 - value / max) * (CHART_H - PAD_T - PAD_B) })) })
  function smoothPath(points: any[]) { if (points.length < 2) return ''; let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`; for (let i = 1; i < points.length; i++) { const x = ((points[i - 1].x + points[i].x) / 2).toFixed(1); d += ` C ${x} ${points[i - 1].y.toFixed(1)} ${x} ${points[i].y.toFixed(1)} ${points[i].x.toFixed(1)} ${points[i].y.toFixed(1)}` } return d }
  const linePath = computed(() => smoothPath(chartPoints.value))
  const fillPath = computed(() => { const points = chartPoints.value; if (points.length < 2) return ''; const base = CHART_H - PAD_B; return `${smoothPath(points)} L ${points.at(-1).x.toFixed(1)} ${base} L ${points[0].x.toFixed(1)} ${base} Z` })
  const gridYs = computed(() => Array.from({ length: 5 }, (_, i) => PAD_T + i / 4 * (CHART_H - PAD_T - PAD_B)))
  const gridValues = computed(() => { const data = usage.value?.daily || []; const max = Math.max(...data.map((d: any) => d[activeMetric.value] ?? 0), 1); return Array.from({ length: 5 }, (_, i) => Math.round(max * (1 - i / 4))) })
  const xLabels = computed(() => { const points = chartPoints.value; const data = usage.value?.daily || []; const step = Math.ceil(points.length / 7); return points.map((point: any, i: number) => ({ x: point.x, label: data[i]?.date?.slice(8) || '' })).filter((_: any, i: number) => i % step === 0 || i === points.length - 1) })
  const chartRight = computed(() => chartWidth.value - PAD_R)
  const hoverColW = computed(() => chartPoints.value.length > 1 ? (chartWidth.value - PAD_L - PAD_R) / (chartPoints.value.length - 1) : chartWidth.value - PAD_L - PAD_R)
  const tooltipStyle = computed(() => { const point = chartPoints.value[hoverIdx.value]; if (!point) return {}; const pct = (point.x - PAD_L) / (chartWidth.value - PAD_L - PAD_R); return { left: `${Math.min(Math.max(pct * 100, 8), 75)}%`, top: `${Math.max(4, (point.y - PAD_T) / (CHART_H - PAD_T - PAD_B) * 72)}%` } })
  function toggleModel(model: string) { activeModel.value = activeModel.value === model ? null : model; fetchUsage(usage.value?.month, activeModel.value) }
  function switchMonth(direction: number) { const months = usage.value?.months || []; const next = monthIndex.value + direction; if (next >= 0 && next < months.length) return fetchUsage(months[next], activeModel.value) }
  onMounted(() => fetchUsage())
  onUnmounted(() => { hoverIdx.value = -1 })
  return { usage, usageLoading, activeModel, activeMetric, hoverIdx, chartWidth, CHART_H, PAD_L, PAD_R, PAD_T, PAD_B, metrics, monthIndex, chartPoints, linePath, fillPath, gridYs, gridValues, xLabels, chartRight, hoverColW, tooltipStyle, toggleModel, switchMonth, fmtNum }
}
