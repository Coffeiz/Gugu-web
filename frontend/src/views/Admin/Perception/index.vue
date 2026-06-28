<template>
  <div class="perc-page">
    <div class="perc-head">
      <div>
        <h2 class="perc-title">感知诊断</h2>
        <p class="perc-sub">咕咕「读懂用户需求」的整体健康度——需求类型分布 / 误判率 / 异常。数据来自对话后反思（零延迟遥测）</p>
      </div>
      <div class="perc-head-right">
        <select v-model.number="hours" @change="load(true)" class="perc-sel">
          <option :value="24">近 24h</option>
          <option :value="168">近 7 天</option>
          <option :value="720">近 30 天</option>
          <option :value="0">全部</option>
        </select>
        <button class="perc-refresh" @click="load(true)" :disabled="loading">{{ loading ? '加载中…' : '刷新' }}</button>
      </div>
    </div>

    <div v-if="err" class="perc-err">{{ err }}</div>

    <!-- 异常标红 -->
    <div v-if="data.flags && data.flags.length" class="perc-flags">
      <div class="perc-flag" v-for="(f, i) in data.flags" :key="i">⚠️ {{ f }}</div>
    </div>
    <div v-else-if="data.perc_total" class="perc-ok">✅ 暂无异常（{{ data.perc_total }} 条观察）</div>

    <!-- 总览指标卡 -->
    <div class="perc-cards">
      <div class="perc-card"><b>{{ data.perc_total ?? '—' }}</b><i>观察数 (perc)</i></div>
      <div class="perc-card"><b>{{ data.misperc_total ?? '—' }}</b><i>纠正数 (misperc)</i></div>
      <div class="perc-card" :class="rateClass(data.overall_misperc_rate)"><b>{{ pct(data.overall_misperc_rate) }}</b><i>总误判率</i></div>
      <div class="perc-card" :class="{ warn: data.avg_ambiguity > 60 }"><b>{{ data.avg_ambiguity ?? '—' }}</b><i>平均歧义度</i></div>
      <div class="perc-card"><b>{{ data.avg_emo_strength ?? '—' }}</b><i>平均情绪强度</i></div>
    </div>

    <div class="perc-sec-title">需求类型分布 & 误判率<span class="perc-hint">误判率 = 被用户下一句纠正的比例（按相邻配对）</span></div>
    <div v-if="!intents.length" class="perc-empty">暂无数据——发生几轮对话后再来看</div>
    <table v-else class="perc-table">
      <thead><tr><th>需求类型</th><th class="w">占比</th><th>条数</th><th>纠正</th><th>误判率</th></tr></thead>
      <tbody>
        <tr v-for="r in intents" :key="r.intent">
          <td class="perc-intent">{{ r.intent }}</td>
          <td class="perc-bar-cell">
            <div class="perc-bar-wrap"><div class="perc-bar" :style="{ width: r.pct + '%' }"></div></div>
            <span class="perc-pct">{{ r.pct }}%</span>
          </td>
          <td>{{ r.count }}</td>
          <td>{{ r.misperc }}</td>
          <td :class="rateClass(r.misperc_rate)">{{ pct(r.misperc_rate) }}</td>
        </tr>
      </tbody>
    </table>

    <template v-if="data.by_model && data.by_model.length">
      <div class="perc-sec-title">按模型</div>
      <table class="perc-table">
        <thead><tr><th>模型</th><th>条数</th><th>纠正</th><th>误判率</th></tr></thead>
        <tbody>
          <tr v-for="r in data.by_model" :key="r.model">
            <td class="perc-intent">{{ r.model }}</td>
            <td>{{ r.count }}</td>
            <td>{{ r.misperc }}</td>
            <td :class="rateClass(r.misperc_rate)">{{ pct(r.misperc_rate) }}</td>
          </tr>
        </tbody>
      </table>
    </template>

    <template v-if="data.emotion_distribution && data.emotion_distribution.length">
      <div class="perc-sec-title">情绪分布</div>
      <div class="perc-emos">
        <span v-for="e in data.emotion_distribution" :key="e.emotion" class="perc-emo">{{ e.emotion }} · {{ e.count }}</span>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useAdminStore } from '@/stores/admin'

const adminStore = useAdminStore()
const data = ref({})
const hours = ref(168)
const loading = ref(false)
const err = ref('')

const intents = computed(() => data.value.intent_distribution || [])

async function load(manual = false) {
  if (manual) loading.value = true
  try {
    const res = await adminStore.authFetch(`/api/v1/admin/perception?hours=${hours.value}`)
    if (!res.ok) throw new Error(`加载失败 (${res.status})`)
    data.value = await res.json()
    err.value = ''
  } catch (e) { err.value = e.message } finally { loading.value = false }
}

function pct(v) { return v == null ? '—' : (v * 100).toFixed(0) + '%' }
// >25% 标红、>15% 标黄（与后端异常阈值对齐）
function rateClass(v) { return v != null && v > 0.25 ? 'bad' : (v != null && v > 0.15 ? 'warn' : '') }

onMounted(() => load())
</script>

<style scoped>
.perc-page { padding: 4px 2px; }
.perc-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 16px; }
.perc-title { font-size: 19px; font-weight: 600; color: #2a2c3a; margin: 0; }
.perc-sub { font-size: 12.5px; color: #9296ad; margin: 4px 0 0; max-width: 560px; }
.perc-head-right { display: flex; gap: 8px; flex-shrink: 0; }
.perc-sel, .perc-refresh { font-size: 13px; padding: 6px 12px; border-radius: 8px; border: 1px solid #e2e2ef; background: #fff; color: #4a4d63; cursor: pointer; }
.perc-refresh:disabled { opacity: .5; cursor: default; }
.perc-err { background: #fdecea; color: #b23b1d; padding: 8px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 12px; }

.perc-flags { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
.perc-flag { background: #fdecea; color: #b23b1d; border: 1px solid #f5ccc2; padding: 8px 12px; border-radius: 8px; font-size: 13px; }
.perc-ok { background: #eaf7f0; color: #18794e; padding: 8px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; }

.perc-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 22px; }
.perc-card { background: #fff; border: 1px solid #ececf5; border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; }
.perc-card b { font-size: 24px; font-weight: 700; color: #2a2c3a; line-height: 1; }
.perc-card i { font-size: 12px; color: #9296ad; font-style: normal; }
.perc-card.warn b { color: #9a6a00; }
.perc-card.warn { background: #fdf6e7; border-color: #f0e0b8; }
.perc-card.bad b { color: #b23b1d; }
.perc-card.bad { background: #fdecea; border-color: #f5ccc2; }

.perc-sec-title { font-size: 14px; font-weight: 600; color: #3a3c4e; margin: 18px 0 8px; display: flex; align-items: baseline; gap: 10px; }
.perc-hint { font-size: 11.5px; font-weight: 400; color: #a8abc0; }
.perc-empty { color: #9296ad; font-size: 13px; padding: 10px 0; }

.perc-table { width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; border: 1px solid #ececf5; border-radius: 12px; overflow: hidden; }
.perc-table th { text-align: left; color: #9296ad; font-weight: 500; font-size: 12px; padding: 9px 14px; background: #fafafe; border-bottom: 1px solid #ececf5; }
.perc-table th.w { width: 38%; }
.perc-table td { padding: 9px 14px; border-bottom: 1px solid #f3f3fa; color: #4a4d63; }
.perc-table tr:last-child td { border-bottom: none; }
.perc-intent { font-weight: 600; color: #2a2c3a; }
.perc-bar-cell { display: flex; align-items: center; gap: 8px; }
.perc-bar-wrap { flex: 1; height: 7px; background: #f0f0f8; border-radius: 4px; overflow: hidden; max-width: 200px; }
.perc-bar { height: 100%; background: linear-gradient(90deg, #8186bd, #9590c4); border-radius: 4px; }
.perc-pct { font-size: 12px; color: #9296ad; min-width: 34px; }
.perc-table td.warn { color: #9a6a00; font-weight: 600; }
.perc-table td.bad { color: #b23b1d; font-weight: 700; }

.perc-emos { display: flex; flex-wrap: wrap; gap: 8px; }
.perc-emo { background: #f3f3fa; color: #5a5d75; border-radius: 8px; padding: 5px 11px; font-size: 12.5px; }
</style>
