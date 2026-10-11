<template>
  <!-- 临时时间轴预览：复用正式 Mind 顶栏与原时间轴业务实现。样例只写 Pinia 内存态；
       时间轴的负 ID 写保护保证编辑/待办/改色/删除不会触及后端。 -->
  <div class="mind-page dev-notes-timeline">
    <MindToolbar dev-mode @seed="seedSample" />
    <div class="mind-body">
      <NotesView />
    </div>
  </div>
</template>

<script setup lang="ts">
import NotesView from '@/views/Mind/NotesView.vue'
import MindToolbar from '@/views/Mind/components/MindToolbar.vue'
import { useI18n } from 'vue-i18n'
import { showAppNotice } from '@/composables/core/useAppToast'
import { useMindStore } from '@/stores/mind'
import type { MindNote } from '@/services/api'

const store = useMindStore()
const { t } = useI18n()

/** 样例数据：id 一律负数，视图层对负 id 不做写操作；时间取相对现在，落位自然的今天/昨天分组 */
async function seedSample() {
  if (!store.loaded) await store.fetchNotes()
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
.dev-notes-timeline { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; }
.mind-body { position: relative; z-index: 1; flex: 1; min-height: 0; }
</style>
