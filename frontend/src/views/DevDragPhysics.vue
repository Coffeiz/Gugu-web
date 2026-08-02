<template>
  <div class="dp-dev">
    <router-link to="/dev" class="back-link">&larr; Dev 工具</router-link>
    <h2>拖拽物理 · 调参面板</h2>
    <p class="hint">
      只影响 <strong>projectDrag</strong>（项目看板卡片的 legacy 视觉路径）。改完不用刷新页面——
      去 <router-link to="/projects">项目看板</router-link> 拖一张卡片就能看到最新效果，
      调完再切回来继续改，状态不会丢。访问路径 <code>/dev/drag-physics</code>。
      参数用 response(响应时长)/dampingRatio(阻尼比) 描述弹簧，不是原始刚度/阻尼系数——
      跟 iOS <code>UISpringTimingParameters</code> 同一套思路，更好凭手感调。
    </p>

    <section>
      <h3>跟手阶段（拖拽中，还没松手）</h3>
      <div class="row">
        <label>响应时长 response (s)</label>
        <input type="range" min="0.1" max="1" step="0.01" v-model.number="tuning.follow.response">
        <input type="number" step="0.01" v-model.number="tuning.follow.response" class="num">
        <p class="desc">大概多久能贴上指针，越小跟得越紧、几乎没有拖尾感。</p>
      </div>
      <div class="row">
        <label>阻尼比 dampingRatio</label>
        <input type="range" min="0.3" max="1.5" step="0.01" v-model.number="tuning.follow.dampingRatio">
        <input type="number" step="0.01" v-model.number="tuning.follow.dampingRatio" class="num">
        <p class="desc">1 = 不回弹（追指针不晃）；&lt;1 会晃/飘；&gt;1 迟钝，慢慢逼近指针。</p>
      </div>
      <div class="row">
        <label>摆动系数 sway</label>
        <input type="range" min="0" max="1" step="0.05" v-model.number="tuning.followSway">
        <input type="number" step="0.05" v-model.number="tuning.followSway" class="num">
        <p class="desc">横向移动速度换算成 rotateZ 甩动的比例，越大甩得越明显。</p>
      </div>
      <div class="row">
        <label>后仰角 tilt (deg)</label>
        <input type="range" min="0" max="20" step="1" v-model.number="tuning.followTilt">
        <input type="number" step="1" v-model.number="tuning.followTilt" class="num">
        <p class="desc">拾起时固定叠加的 3D 倾斜角度，纵向速度会在这个基础上再叠加。</p>
      </div>
    </section>

    <section>
      <h3>落地阶段（松手到吸附目标）</h3>
      <div class="row">
        <label>响应时长 response (s)</label>
        <input type="range" min="0.1" max="1" step="0.01" v-model.number="tuning.landing.response">
        <input type="number" step="0.01" v-model.number="tuning.landing.response" class="num">
        <p class="desc">大概多久能吸附到目标，越小落地越快。</p>
      </div>
      <div class="row">
        <label>阻尼比 dampingRatio</label>
        <input type="range" min="0.2" max="1.5" step="0.01" v-model.number="tuning.landing.dampingRatio">
        <input type="number" step="0.01" v-model.number="tuning.landing.dampingRatio" class="num">
        <p class="desc">1 = 不回弹；&lt;1 会回弹/画弧线，越接近 0 弹得越夸张（iOS 那种感觉一般在 0.6~0.9）。</p>
      </div>
      <div class="row">
        <label>松手抛出力度 releaseImpulse</label>
        <input type="range" min="0.6" max="1.8" step="0.05" v-model.number="tuning.releaseImpulse">
        <input type="number" min="0.6" max="1.8" step="0.05" v-model.number="tuning.releaseImpulse" class="num">
        <p class="desc">只增强松手时的当前速度，不改变最终落点；1 = 保持原速度，建议从 1.1 开始。</p>
      </div>
      <div class="row">
        <label>松手速度上限 releaseVelocityCap</label>
        <input type="range" min="800" max="3600" step="100" v-model.number="tuning.releaseVelocityCap">
        <input type="number" min="800" max="3600" step="100" v-model.number="tuning.releaseVelocityCap" class="num">
        <p class="desc">限制倍率放大后的最高释放速度；越高，甩出距离越远，建议从 2400 开始。</p>
      </div>
      <p class="hint">
        换算出的 stiffness ≈ {{ landingStiffnessPreview }}，damping ≈ {{ landingDampingPreview }}
        （质量归一化为 1，公式见 <code>physicsTuning.ts</code>）。
      </p>
    </section>

    <div class="row wrap">
      <button class="primary" @click="save">保存（作为生产参数，刷新/开新标签页都读得到）</button>
      <button @click="setAnchor">设为默认（仅调试锚点，不影响生产）</button>
      <button @click="reset">恢复默认值</button>
      <button @click="copyCode">复制为代码</button>
      <span v-if="hint" class="saved-hint">{{ hint }}</span>
    </div>
    <p class="hint">
      "保存"代表你认可的生产参数，但浏览器改不了源码——真的要让它变成生产环境编译进去的默认值，
      还需要"复制为代码"，把结果发给我写进 <code>DEFAULT_DRAG_PHYSICS_TUNING</code>。
      "设为默认"只是一个调试锚点，跟生产值无关，方便试验时有个可回退的基准。
      多个标签页同时打开这个页面时，改动会通过 <code>BroadcastChannel</code> 实时同步。
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  dragPhysicsTuning as tuning,
  saveDragPhysicsTuning,
  setDragPhysicsTuningAnchor,
  resetDragPhysicsTuning,
  copyDragPhysicsTuningAsCode,
  springParamsFromResponse,
} from '@/interaction/drag/physicsTuning'

const landingStiffnessPreview = computed(() => Math.round(springParamsFromResponse(tuning.landing).stiffness))
const landingDampingPreview = computed(() => Math.round(springParamsFromResponse(tuning.landing).damping * 10) / 10)

const hint = ref('')
let hintTimer: ReturnType<typeof setTimeout> | null = null
function showHint(text: string) {
  hint.value = text
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = setTimeout(() => { hint.value = '' }, 2000)
}

function save() {
  saveDragPhysicsTuning()
  showHint('已保存')
}

function setAnchor() {
  setDragPhysicsTuningAnchor()
  showHint('已设为默认锚点')
}

function reset() {
  resetDragPhysicsTuning()
  showHint('已恢复')
}

async function copyCode() {
  const code = copyDragPhysicsTuningAsCode()
  try {
    await navigator.clipboard.writeText(code)
    showHint('已复制到剪贴板')
  } catch {
    showHint('复制失败，请手动选中：' + code)
  }
}
</script>

<style scoped>
.dp-dev { max-width: 760px; margin: 0 auto; padding: 28px 24px; color: var(--text-primary, #2a2a3a); }
.back-link { display: inline-block; font-size: 13px; color: var(--text-secondary, #6b6b7a); text-decoration: none; margin-bottom: 12px; }
.back-link:hover { text-decoration: underline; }
.hint { color: var(--text-secondary, #6b6b7a); font-size: 13px; line-height: 1.6; margin: 8px 0 20px; }
section { margin-bottom: 28px; }
h3 { font-size: 15px; margin-bottom: 12px; }
.row { display: grid; grid-template-columns: 190px 1fr 72px; align-items: center; gap: 10px; margin-bottom: 4px; }
.row.wrap { display: flex; flex-wrap: wrap; align-items: center; }
.row label { font-size: 13px; }
.row .num { width: 72px; }
.desc { grid-column: 1 / -1; font-size: 12px; color: var(--text-secondary, #6b6b7a); margin: 0 0 10px; }
button { padding: 6px 14px; border-radius: 6px; border: 1px solid #d0d0d8; background: #f5f5f8; cursor: pointer; }
button:hover { background: #ececf2; }
button.primary { border-color: #4a6cf7; background: #4a6cf7; color: #fff; }
button.primary:hover { background: #3a5ce0; }
.saved-hint { font-size: 13px; color: #2a9d5c; }
code { background: #f0f0f4; padding: 1px 5px; border-radius: 4px; }
</style>
