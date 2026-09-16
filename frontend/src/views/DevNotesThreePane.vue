<template>
  <!-- dev 专用：三栏板式笔记页预览壳。复刻 Mind/index.vue 的顶栏（胶囊 Tabs + 日历 + 筛选），
       正文换成 NotesThreePaneView——将来板式定稿后，替换动作 = Mind/index.vue 的 RouterView
       里 NotesView.vue → NotesThreePaneView.vue，本壳即废弃。
       「载入样例数据」只在本地无后端时看板式用：只写 pinia 内存态，绝不落库；已有真实数据
       时拒绝注入。样例便签 id 一律为负，视图层对负 id 跳过一切写操作。 -->
  <div class="dntp-page">
    <div class="dntp-bar">
      <div class="dntp-side"></div>
      <SegmentedControl class="dntp-tabs" :active-index="0" style="--pill-radius: 999px">
        <RouterLink to="/dev/notes-three-pane" class="dntp-tab on">
          <PhNotePencil :size="16" weight="bold" />
          {{ t('mind.notes') }}
        </RouterLink>
        <RouterLink to="/mind/canvases" class="dntp-tab">
          <PhGraph :size="16" weight="bold" />
          {{ t('mind.canvases') }}
        </RouterLink>
      </SegmentedControl>
      <div class="dntp-side right">
        <span class="dntp-badge">DEV</span>
        <button class="dntp-seed" @click="seedSample">{{ t('mindThreePane.seed') }}</button>
        <!-- 类名沿用 Mind/index.vue 的 mind-cal-picker / mind-filter：主题 paint 在
             adoption/mind.css 里按这两个类名全局生效，换名就会丢掉玻璃质感（筛选胶囊变空壳） -->
        <DatePicker
          v-model="store.jumpTarget"
          class="mind-cal-picker"
          popup-class="mind-cal-popup"
          :max="todayIso"
          :allowed-dates="store.timeline.map(g => g.date)"
          :show-clear="false"
          :title="t('mind.chooseDate')"
        />
        <div class="mind-filter">
          <PhMagnifyingGlass :size="13" weight="bold" class="mf-icon" />
          <input v-model="store.filterQ" type="text" :placeholder="t('mind.filter')" />
          <button v-if="store.filterQ" class="mf-clear" :title="t('mind.clear')" @click="store.filterQ = ''">
            <PhX :size="11" weight="bold" />
          </button>
        </div>
      </div>
    </div>
    <div class="dntp-body">
      <NotesThreePaneView />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhGraph, PhMagnifyingGlass, PhNotePencil, PhX } from '@phosphor-icons/vue'
import { showAppNotice } from '@/composables/core/useAppToast'
import { useMindStore } from '@/stores/mind'
import { localDayKey } from '@/utils/dateAttribution'
import type { MindNote } from '@/services/api'
import DatePicker from '@/components/common/controls/DatePicker.vue'
import SegmentedControl from '@/components/common/controls/SegmentedControl.vue'
import NotesThreePaneView from '@/views/Mind/NotesThreePaneView.vue'

const store = useMindStore()
const { t } = useI18n()
const todayIso = computed(() => localDayKey(new Date()))

/** 样例数据：id 一律负数，视图层对负 id 不做写操作；时间取相对现在，落位自然的今天/昨天分组 */
function seedSample() {
  if (store.notes.length) { showAppNotice(t('mindThreePane.seedBlocked')); return }
  const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600e3).toISOString()
  const samples: MindNote[] = [
    {
      id: -1, kind: 'note', title: '提问系统设计思路', color: 'amber',
      capturedAt: iso(2), createdAt: iso(2), updatedAt: iso(1.5), version: 1,
      contentMd: [
        '# 提问系统设计思路', '',
        '遇到不确定的内容时，给用户发送问卡（多选 / 单选 / 简答），用户选择回答后由咕咕继续。相比咕咕主动追问更精准，能减少一来一回的轮次。', '',
        '## 提问系统', '',
        '问卡需要**轻量、直观**，不打断用户思路；答案支持多种类型，适配不同场景。', '',
        '## 按钮系统', '',
        '用按钮代替咕咕主动询问：点击按钮就能直接创建项目 / 日程 / 活动 / 待办等，省去用户打字和决策成本。', '',
        '> 设计要点',
        '> - 提问卡片需要轻量、直观，不打断用户思路',
        '> - 支持多种问答类型，适配不同场景',
        '> - 答案选择后能智能推进整个工作流', '',
        '---', '',
        '按钮项目由咕咕根据上下文预测填充，参见 [[project:1|咕咕 1.0 版本规划]] 里的排期。',
      ].join('\n'),
    },
    {
      id: -2, kind: 'note', title: null, color: 'coral',
      capturedAt: iso(5), createdAt: iso(5), updatedAt: iso(5), version: 1,
      contentMd: [
        '夏天太热，脑子也是。适合放弃一些事。', '',
        '我的夏季放弃清单：', '',
        '- 早晨第一个闹钟',
        '- 中午的播客',
        '- 晚上十一点后的所有计划',
      ].join('\n'),
    },
    {
      id: -3, kind: 'note', title: '周视图设计优化', color: 'teal',
      capturedAt: iso(7), createdAt: iso(7), updatedAt: iso(6.5), version: 1,
      contentMd: [
        '# 周视图设计优化', '',
        '考虑在周视图中加入项目能量素的可视化：', '',
        '- [x] 确定能量素的计算口径',
        '- [x] 色带用项目主色而不是状态色',
        '- [ ] 周视图与日视图切换时保留滚动位置',
        '- [ ] 空项目的占位文案', '',
        '视觉稿见 `weekly-review-v3.fig`。',
      ].join('\n'),
    },
    {
      id: -4, kind: 'note', title: '文件存储架构升级', color: 'blue',
      capturedAt: iso(26), createdAt: iso(26), updatedAt: iso(25.5), version: 1,
      refType: 'file', refId: 1,
      contentMd: [
        '# 文件存储架构升级', '',
        '统一存储抽象层，支持本地 / OSS 双存储：', '',
        '## 分层', '',
        '1. **访问层**：统一的 `Storage.driver` 接口',
        '2. **驱动层**：local / oss 两个实现，按 bucket 配置路由',
        '3. **缓存层**：缩略图与常用小文件走内存 LRU', '',
        '> 迁移注意：旧文件保持懒迁移，不做一次性回填，避免升级时长事务。',
      ].join('\n'),
    },
    {
      id: -5, kind: 'note', title: null, color: null,
      capturedAt: iso(30), createdAt: iso(30), updatedAt: iso(30), version: 1,
      contentMd: '补录：上周想到的——待办超期三天自动降级到「本周补救」分组，而不是一直挂在原日期下面制造愧疚感。周末验证一下这个心理假设。',
    },
    {
      id: -6, kind: 'note', title: '画布连接方向提示词', color: 'amber',
      capturedAt: iso(74), createdAt: iso(74), updatedAt: iso(72), version: 1,
      contentMd: [
        '# 画布连接方向提示词', '',
        '连接线的箭头语义在提示词里补一段：默认指向依赖方向，回环（loop）要显式声明，不然模型画出来的方向经常反。', '',
        '- [x] 提示词扩展',
        '- [ ] 连线高亮跟随主题色',
      ].join('\n'),
    },
  ]
  store.notes = samples
}
</script>

<style scoped>
/* 顶栏几何照抄 Mind/index.vue（胶囊居中 + 右侧日历/筛选），主题 paint 走同一批 token */
.dntp-page { display: flex; flex-direction: column; gap: 28px; height: 100%; min-height: 0; }
/* 胶囊距视口顶部 28px（.dntp-bar margin-top），内容区与胶囊的间距取同一数值——上下留白对称 */
.dntp-bar {
  display: grid; grid-template-columns: 1fr auto 1fr;
  align-items: center; gap: 12px;
  position: relative; z-index: 40;
  flex-shrink: 0; margin: 28px 24px 0;
}
.dntp-body { position: relative; z-index: 1; flex: 1; min-height: 0; }
.dntp-side { display: flex; align-items: center; }
.dntp-side.right { justify-content: flex-end; gap: 10px; }
.dntp-badge {
  flex: none; padding: 3px 8px; border-radius: 6px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
  color: var(--color-primary);
  border: 1px solid color-mix(in srgb, var(--color-primary) 40%, transparent);
}
.dntp-seed {
  flex: none; height: 30px; padding: 0 12px; border-radius: 999px;
  font-size: 12px; color: var(--color-primary); cursor: pointer; font-family: inherit;
  border: 1px dashed color-mix(in srgb, var(--color-primary) 45%, transparent);
  transition: background 0.15s;
}
.dntp-seed:hover { background: color-mix(in srgb, var(--color-primary) 10%, transparent); }

.dntp-tabs {
  gap: 2px; padding: 2px; border-radius: 999px;
  background: var(--glass-bg); border: 1px solid var(--glass-border);
  box-shadow: var(--glass-shadow);
  backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
}
.dntp-tab {
  display: inline-flex; align-items: center; gap: 6px;
  height: 36px; box-sizing: border-box; padding: 0 17px; border-radius: 999px;
  font-size: 13.5px; font-weight: 600; color: var(--text-secondary);
  text-decoration: none; cursor: pointer; transition: color 0.15s;
}
.dntp-tab:hover { color: var(--color-primary); }
.dntp-tab.on { color: var(--text-primary); background: var(--surface-card-solid); box-shadow: var(--elevation-card); }

:deep(.mind-cal-picker) { width: auto !important; }
:deep(.mind-cal-picker .dp-input) {
  width: 40px; height: 40px; padding: 0; box-sizing: border-box; justify-content: center;
  border-radius: 999px;
}
:deep(.mind-cal-picker .dp-input span) { display: none; }

/* 几何照抄 Mind/index.vue 的 .mind-filter；主题 paint 走 adoption/mind.css 的同名全局类 */
.mind-filter {
  display: flex; align-items: center; gap: 6px;
  width: 200px; height: 40px; box-sizing: border-box;
  padding: 0 12px; border: 1px solid transparent; border-radius: 999px;
}
.mf-icon { flex-shrink: 0; color: var(--text-secondary); opacity: 0.7; }
.mind-filter input {
  flex: 1; min-width: 0; border: none; outline: none; background: none;
  font-size: 12.5px; color: var(--text-primary); font-family: var(--font-sans);
}
.mind-filter input::placeholder { color: var(--text-secondary); opacity: 0.6; }
.mf-clear {
  flex-shrink: 0; display: inline-flex; padding: 2px;
  border: none; border-radius: 4px; background: none;
  color: var(--text-secondary); cursor: pointer;
}
</style>
