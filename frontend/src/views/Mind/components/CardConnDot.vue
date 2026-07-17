<template>
  <!-- 四种画布贴纸（便签/活动/文件/项目）共用的连接点——左右各一颗，悬停贴纸才显形，
       按住拖出去落到另一张贴纸上建立关联（整个拖拽判定在 MindCanvas.vue 的
       onConnectDragStart，这里只管发起+外观）。之前四个文件里各自抄一份几乎一模一样的
       模板+CSS，改一处（比如调个颜色/尺寸）就要四处同步，这里收成一份。
       用 props 驱动外观（hovering/connecting/targetSide）而不是 CSS :hover——这样样式
       完全封在这个组件自己身上，宿主贴纸不需要为了"看到子组件里的 .conn-dot"写
       :deep() 选择器，components 边界更干净。宿主只需要把自己已有的 mouseenter/mouseleave
       状态和 connecting/connectionTargetSide 这两个已有 prop 原样传进来。 -->
  <span class="card-conn-dots" :data-node-id="nodeId" :class="{ hovering, connecting, 'connection-target': !!targetSide }">
    <button class="conn-dot conn-dot-left" :class="{ 'conn-dot-active': targetSide === 'left' }" title="拖出连线建立关联" @pointerdown.stop="e => emit('dragStart', e, 'left')"></button>
    <button class="conn-dot conn-dot-right" :class="{ 'conn-dot-active': targetSide === 'right' }" title="拖出连线建立关联" @pointerdown.stop="e => emit('dragStart', e, 'right')"></button>
  </span>
</template>

<script setup lang="ts">
defineProps<{
  // 拖拽/落地飞行途中，RelationLayer.vue 靠这个属性去 DOM 里精确定位当前正在飘着的那颗
  // 连接点管理节点（拖拽系统的 connectionDotManager 会复制这份结构并统一定位），不必再
  // 假装卡片没有旋转、自己算一份可能跟摆动动画对不上的锚点坐标。
  nodeId: number
  hovering: boolean
  connecting: boolean
  targetSide: 'left' | 'right' | null
}>()
const emit = defineEmits<{ (e: 'dragStart', event: PointerEvent, side: 'left' | 'right'): void }>()
</script>

<style scoped>
/* inset:0 铺满宿主贴纸（宿主自己是 position:absolute/relative 的定位祖先）——自己不接收
   任何指针事件（pointer-events:none），只有两颗真正的圆点按钮要能点，各自开回 auto。
   position:absolute 必须 !important：NoteCard.vue 有一条 `.note-card > * { position:
   relative; z-index: 1; }`（给自己的正常内容抬到装饰性 ::after 高光层之上用的），Vue 的
   scoped 样式会把父组件的 scope-id 一并打到子组件根节点上，让这类「宿主对自己直接子元素
   的通用规则」也命中子组件（这里是 CardConnDot 的根 .card-conn-dots）——跟 CardConnDot 自己
   这条特异度打平，样式表顺序不保真，输了就会从 absolute 被拉回 relative：inset:0 在
   position:relative 下不再是"铺满宿主"而是个没意义的偏移量，.card-conn-dots 变成塌缩在
   文档流位置的一个 0 大小行内元素，两颗圆点的定位基准从"宿主整张卡"变成这个错位的小元素，
   表现正是"连接点跑去了左上角"。四种贴纸只有便签会踩这个坑（另外三种没有类似的
   `.xxx > *` 通用规则），但这里直接把 position 钉死更稳，不用逐个排查宿主有没有这类规则。 */
.card-conn-dots { position: absolute !important; inset: 0; pointer-events: none; z-index: 20 !important; }
/* 鼠标判定区比看着的圆点大一圈（+10px 半径）——12px 的圆点本身很小，直接点很难点中，这里
   按钮自己的盒子开到 32px 兜住更宽松的判定范围，画出来的圆点挪到 ::before 上按视觉尺寸
   居中摆放，肉眼看着还是原来那个小圆点，只是好点了。 */
.conn-dot {
  position: absolute; top: 50%; width: 32px; height: 32px; margin-top: -16px;
  border: none; background: none; padding: 0;
  cursor: crosshair; z-index: 6;
  pointer-events: auto;
}
.conn-dot::before {
  content: '';
  position: absolute; inset: 10px;
  border: 2px solid #fff; border-radius: 50%;
  background: var(--color-primary); box-shadow: 0 1px 4px rgba(80,90,110,.35);
  opacity: 0; transition: opacity 0.15s, transform 0.15s, box-shadow 0.2s ease;
}
.card-conn-dots.hovering .conn-dot::before { opacity: 1; }
/* 正在从别的贴纸拖连线出来时，全部可落点的贴纸都先显出一点存在感（.38），不依赖悬停；
   拖到这张贴纸判定命中的具体那一侧再跳到 1 + 放大 + 磁吸辉光，靠 .conn-dot-active 这个
   更具体的类名天然赢过上面这条（不用管两条规则谁在样式表里写得靠前）。辉光原来是一份
   infinite alternate 的关键帧动画（来回一直跳），现在改成纯 transition：class 加上去
   time 就过渡到展开的辉光并停在那儿，class 摘掉（比如挪到另一侧/连接判定丢失）时再
   平滑收回基础态，不再有"贴上去还在反复横跳"的效果。 */
.card-conn-dots.connecting .conn-dot::before,
.card-conn-dots.connection-target .conn-dot::before { opacity: .38; }
.card-conn-dots.connection-target .conn-dot-active::before {
  opacity: 1; transform: scale(1.28);
  box-shadow: 0 0 0 5px rgba(123,127,178,.16), 0 2px 8px rgba(80,90,110,.38);
}
.conn-dot:hover::before { transform: scale(1.3); }
/* 判定盒比可见圆点大了一圈（16→32px），左右偏移量按同样的量往外挪，让可见圆点的中心
   落在跟原来完全一样的位置（贴着卡片边缘），只是判定范围变宽，不改变肉眼看到的位置。 */
.conn-dot-left { left: -17px; }
.conn-dot-right { right: -17px; }
</style>
