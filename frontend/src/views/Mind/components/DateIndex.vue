<template>
  <!-- 日期刻度杆（iiiiiliiii）：一天一根刻度，当前列的刻度加高加粗；hover 微升并浮出日期，
       点击横向跳到对应列。只列有便签的日期（与列一一对应），左新右旧与列序一致。 -->
  <nav ref="stripRef" class="date-scrub">
    <button
      v-for="g in groups" :key="g.date"
      class="dsb-tick" :class="{ on: g.date === active }"
      :data-date="g.date"
      :title="`${fmtLabel(g.date)} · ${g.count} 条`"
      @click="emit('jump', g.date)"
    >
      <span class="dsb-bar"></span>
      <span class="dsb-tip">{{ fmtLabel(g.date) }}</span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  groups: { date: string; count: number }[]
  active: string
}>()
const emit = defineEmits<{ (e: 'jump', date: string): void }>()

const stripRef = ref<HTMLElement | null>(null)

// 高亮刻度跟着滚动跑出可视区时，把它带回来（天数多时刻度杆自身也会溢出）
watch(() => props.active, (d) => {
  stripRef.value?.querySelector<HTMLElement>(`.dsb-tick[data-date="${d}"]`)
    ?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
})

const _today = new Date().toISOString().slice(0, 10)

function fmtLabel(iso: string) {
  const [y, m, d] = iso.split('-')
  return y === _today.slice(0, 4) ? `${+m}月${+d}日` : `${y}年${+m}月${+d}日`
}
</script>

<style scoped>
.date-scrub {
  display: flex; align-items: flex-end; gap: 3px;
  /* safe center：天数少时居中，多到溢出时回退成可滚动的 start（普通 center 会把左端裁到够不着） */
  justify-content: safe center;
  flex-shrink: 0; overflow-x: auto; padding: 4px 12px 12px;
  scrollbar-width: none;
}
.date-scrub::-webkit-scrollbar { display: none; }

/* 每根刻度给 10px 宽的透明点击区，视觉上只露中间 3px 的杆 */
.dsb-tick {
  position: relative; flex-shrink: 0;
  display: flex; align-items: flex-end; justify-content: center;
  width: 10px; height: 22px; padding: 0;
  border: none; background: none; cursor: pointer;
}
.dsb-bar {
  width: 3px; height: 12px; border-radius: 99px;
  background: rgba(123,127,178,0.32);
  transition: height 0.15s ease, background 0.15s ease, width 0.15s ease;
}
.dsb-tick:hover .dsb-bar { height: 17px; background: rgba(123,127,178,0.55); }
.dsb-tick.on .dsb-bar { width: 4px; height: 22px; background: var(--color-primary); }

/* hover 浮出日期小签（当前刻度常显） */
.dsb-tip {
  position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
  margin-top: 3px; font-size: 10px; white-space: nowrap;
  color: var(--text-secondary); opacity: 0; pointer-events: none;
  transition: opacity 0.15s ease;
}
.dsb-tick:hover .dsb-tip { opacity: 1; }
.dsb-tick.on .dsb-tip { opacity: 1; color: #5a5e86; font-weight: 600; }
</style>
