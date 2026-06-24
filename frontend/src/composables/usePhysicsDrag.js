/**
 * 拖拽物理效果（项目卡 / 文件卡通用）
 *
 * 原生 HTML5 拖放的 ghost 由浏览器接管，无法做弹簧跟随、占位收合或落点让位。
 * 这里在保留原有拖放逻辑（dragstart/drop 照常）的前提下叠一层视觉物理：
 *   - 拾起：隐藏源卡（克隆体即「本体」跟着指针弹簧跟随、带后仰），源卡占位用 FLIP **动画收合**；
 *   - 落下：飞到实际落点（换列/重排的新槽位），落点容器的其它卡 **FLIP 动画让位**；
 *     文件被收进文件夹/面包屑 → 缩小吸入；没变化 → 占位 FLIP 重新展开、克隆体归位。
 */

let _ghostImg = null
function _transparentGhost() {
  if (_ghostImg) return _ghostImg
  const img = new Image()
  img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  _ghostImg = img
  return img
}

let _active = null   // 同一时刻只有一个拖拽

function _childCards(container, exclude) {
  return [...container.children].filter(c =>
    c.nodeType === 1 && c !== exclude && !c.classList.contains('phys-drag-clone'))
}
const _rects = els => els.map(e => e.getBoundingClientRect())

// 到位缓动：强 ease-out（快进慢收，非线性），不过冲、不回弹
const _SETTLE = 'cubic-bezier(0.22, 1, 0.36, 1)'

// FLIP：布局已经变到「现状(toRects)」后，让 kids 先回到 fromRects 再动画到现状
function _invertPlay(kids, fromRects, toRects, dur = 340) {
  kids.forEach((c, i) => {
    const dx = fromRects[i].left - toRects[i].left
    const dy = fromRects[i].top  - toRects[i].top
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
    c.style.transition = 'none'
    c.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`
  })
  requestAnimationFrame(() => {
    for (const c of kids) {
      if (!c.style.transform) continue
      c.style.transition = `transform ${dur}ms ${_SETTLE}`
      c.style.transform = ''
      const clr = () => { c.style.transition = ''; c.removeEventListener('transitionend', clr) }
      c.addEventListener('transitionend', clr)
      setTimeout(clr, dur + 80)
    }
  })
}

/**
 * @param {DragEvent} event  原生 dragstart 事件
 * @param {HTMLElement} sourceEl  被拖的卡片（一般传 event.currentTarget）
 * @param {object} [opts]  { stiffness, sway, tilt, grabY, lift }
 */
export function startPhysicsDrag(event, sourceEl, opts = {}) {
  if (!sourceEl || _active) return
  try { event.dataTransfer?.setDragImage(_transparentGhost(), 0, 0) } catch {}

  const STIFF = opts.stiffness ?? 0.10   // 跟随刚度：越小越「拖沓」、延迟越高
  const LIFT  = opts.lift      ?? 1.045  // 克隆抬起的放大
  const SWAY  = opts.sway      ?? 0.25   // 横向摆动幅度
  const TILT  = opts.tilt      ?? 5      // 后仰角(deg)：上小下大，像被拎起
  const GRABY = opts.grabY     ?? 28     // 抓取点到卡片顶部的距离：挂在指针下方

  const rect = sourceEl.getBoundingClientRect()
  const half = { x: rect.width / 2, y: rect.height / 2 }
  const container = sourceEl.parentElement

  // 克隆体（保留 data-v scoped 属性 → 外观一致），它就是飞动的「本体」
  const clone = sourceEl.cloneNode(true)
  clone.classList.add('phys-drag-clone')
  Object.assign(clone.style, {
    position: 'fixed', left: '0', top: '0',
    width: rect.width + 'px', height: rect.height + 'px',
    margin: '0', boxSizing: 'border-box',
    zIndex: '9999', pointerEvents: 'none', willChange: 'transform', transition: 'none',
  })
  // 克隆体初始就摆到源卡位置，避免首帧停在左上角(0,0)闪一下
  clone.style.transform =
    `translate3d(${rect.left.toFixed(2)}px, ${(rect.top + half.y - GRABY).toFixed(2)}px, 0)` +
    ` perspective(760px) rotateX(${TILT}deg) scale(${LIFT})`
  document.body.appendChild(clone)

  // 拾起：先即时透明隐藏源卡（同步 display:none 会让浏览器取消原生拖拽 → 立刻 dragend），
  // 下一帧再真正移出布局并 FLIP 合拢邻居
  sourceEl.style.opacity = '0'
  if (container) {
    requestAnimationFrame(() => {
      if (!_active || !sourceEl.isConnected) return
      const kids = _childCards(container, sourceEl)
      const open = _rects(kids)
      sourceEl.style.display = 'none'
      const closed = _rects(kids)
      _invertPlay(kids, open, closed)
    })
  }

  const pos    = { x: rect.left + half.x, y: rect.top + half.y }
  const target = { x: pos.x, y: pos.y }
  let vxs = 0, vys = 0

  function onOver(e) {
    // 让整页都成为有效放置区：在任意处（包括拖出范围）松手都立刻触发 drop，
    // 避免无效拖放时浏览器先播放「飞回源」动画、dragend 被推迟 ~250ms 的延迟
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    if (e.clientX || e.clientY) { target.x = e.clientX; target.y = e.clientY }
  }

  function frame() {
    const nx = pos.x + (target.x - pos.x) * STIFF
    const ny = pos.y + (target.y - pos.y) * STIFF
    const vx = nx - pos.x, vy = ny - pos.y
    pos.x = nx; pos.y = ny
    vxs += (vx - vxs) * 0.12; vys += (vy - vys) * 0.12   // 速度低通：旋转不再一卡一卡
    const rotZ = Math.max(-5, Math.min(5, vxs * SWAY))
    const rotX = TILT + Math.max(-4, Math.min(4, vys * 0.16))
    clone.style.transform =
      `translate3d(${(pos.x - half.x).toFixed(2)}px, ${(pos.y - GRABY).toFixed(2)}px, 0)` +
      ` perspective(760px) rotateX(${rotX.toFixed(2)}deg) rotateZ(${rotZ.toFixed(2)}deg) scale(${LIFT})`
    _active.raf = requestAnimationFrame(frame)
  }

  function end() {
    if (!_active) return
    cancelAnimationFrame(_active.raf)
    _active = null
    document.removeEventListener('dragover', onOver)
    document.removeEventListener('drop', end, true)
    sourceEl.removeEventListener('dragend', end)

    const dropX = target.x, dropY = target.y
    const idAttr = sourceEl.getAttribute('data-file-id')    ? ['data-file-id',    sourceEl.getAttribute('data-file-id')]
                 : sourceEl.getAttribute('data-folder-key') ? ['data-folder-key', sourceEl.getAttribute('data-folder-key')]
                 : sourceEl.getAttribute('data-project-id') ? ['data-project-id', sourceEl.getAttribute('data-project-id')]
                 : null
    const sel = idAttr ? `[${idAttr[0]}="${idAttr[1]}"]` : null

    let done = false, onEnd = null
    const SLOT = box => `translate3d(${box.left.toFixed(2)}px, ${box.top.toFixed(2)}px, 0) perspective(760px) rotateX(0deg) rotateZ(0deg) scale(1)`

    // 单克隆：吸入(shrink) / 归位(同样式，飞到位再露出真卡)
    const flyTo = (box, shrink, revealEl) => {
      clone.style.transition = `transform 0.42s ${_SETTLE}, opacity 0.4s ease`
      if (shrink) {
        const cx = box.left + box.width / 2, cy = box.top + box.height / 2
        clone.style.opacity = '0'
        clone.style.transform =
          `translate3d(${(cx - half.x).toFixed(2)}px, ${(cy - half.y).toFixed(2)}px, 0) perspective(760px) rotateX(0deg) rotateZ(0deg) scale(0.32)`
      } else {
        clone.style.transform = SLOT(box)
      }
      const finish = () => {
        if (done) return
        done = true
        clone.removeEventListener('transitionend', onEnd)
        clone.remove()
        if (revealEl) { revealEl.style.opacity = ''; revealEl.style.transition = '' }
      }
      onEnd = finish
      clone.addEventListener('transitionend', onEnd)
      setTimeout(finish, 560)
    }

    // 双克隆样式渐变：clone(旧样式) 与 clone2(新样式) 同起点、同轨迹飞向落点，飞行途中：
    //  ① 用 scale 把卡片实际拉伸/缩短到落点卡的尺寸（长短按需变化，而非靠淡变蒙混）；
    //  ② 交叉淡变完成内容（旧→新样式）。看到的是飞动的卡片自己变形+变样式并落位。
    const flyMorph = (box, revealEl, clone2) => {
      // 克隆体是按源卡(旧)尺寸渲染的；缩放到落点卡尺寸，并让缩放后中心对齐落点中心
      const sx = (box.width  / rect.width ).toFixed(4)
      const sy = (box.height / rect.height).toFixed(4)
      const cx = box.left + box.width / 2, cy = box.top + box.height / 2
      const tf = `translate3d(${(cx - half.x).toFixed(2)}px, ${(cy - half.y).toFixed(2)}px, 0)` +
                 ` perspective(760px) rotateX(0deg) rotateZ(0deg) scale(${sx}, ${sy})`
      clone2.getBoundingClientRect()   // 提交初始态（与 clone 重叠、opacity 0），下面才会从此处动画
      const trans = `transform 0.42s ${_SETTLE}, opacity 0.42s ease`
      clone.style.transition = trans
      clone2.style.transition = trans
      clone.style.transform = tf;  clone.style.opacity = '0'
      clone2.style.transform = tf; clone2.style.opacity = '0.97'
      const finish = () => {
        if (done) return
        done = true
        clone2.removeEventListener('transitionend', onEnd)
        clone.remove(); clone2.remove()
        revealEl.style.opacity = ''; revealEl.style.transition = ''
      }
      onEnd = finish
      clone2.addEventListener('transitionend', onEnd)
      setTimeout(finish, 580)
    }

    // 占位重新展开：FLIP 邻居从「合拢」动到「展开」。el 当前可能已收合(home)或已展开(落点新卡)，
    // 两种都要先拿到 closed 和 open 两套位置
    const animateOpen = (cont, el) => {
      const sibs = _childCards(cont, el)
      let closedR, openR
      if (el.style.display === 'none') {   // 已收合（home）：量 closed → 展开 → 量 open
        closedR = _rects(sibs)
        el.style.display = ''
        openR = _rects(sibs)
      } else {                              // 已展开（落点新卡已插入）：量 open → 临时收合量 closed → 复原
        openR = _rects(sibs)
        el.style.display = 'none'
        closedR = _rects(sibs)
        el.style.display = ''
      }
      el.style.opacity = '0'              // 落定前隐藏，克隆体落到位再露出
      _invertPlay(sibs, closedR, openR)   // 从合拢 → 展开
      return el.getBoundingClientRect()
    }

    // 业务 drop + Vue 重渲染在微任务里已落定；本 rAF 在 paint 前做落点 FLIP，避免闪一下
    requestAnimationFrame(() => {
      // 1) 释放点压着文件夹/面包屑 → 吸入（不依赖异步重渲染）
      const under = document.elementFromPoint(dropX, dropY)
      const absorb = under && under.closest && under.closest('.folder-card, .bc-item')
      if (absorb) { flyTo(absorb.getBoundingClientRect(), true, null); return }

      // 2) 卡片落到新位置（换列/重排）
      if (sel) {
        const el = document.querySelector(sel)
        if (el && el.isConnected && el !== sourceEl) {
          if (el.offsetWidth > 0) {   // 落点可见 → 占位 FLIP 展开；双克隆同轨迹飞行 + 样式渐变
            const box = animateOpen(el.parentElement, el)
            const clone2 = el.cloneNode(true)   // 新状态样式
            clone2.classList.add('phys-drag-clone')
            Object.assign(clone2.style, {
              position: 'fixed', left: '0', top: '0',
              width: clone.style.width, height: clone.style.height,
              margin: '0', boxSizing: 'border-box', zIndex: '9999', pointerEvents: 'none',
              willChange: 'transform', transition: 'none', opacity: '0',
              transform: clone.style.transform,   // 起点与旧克隆重叠
            })
            document.body.appendChild(clone2)
            flyMorph(box, el, clone2)
          } else {                    // 落点在折叠分组里不可见（如已完成列折叠的月份）→ 就地缩小淡出
            flyTo({ left: dropX - half.x, top: dropY - half.y, width: rect.width, height: rect.height }, true, null)
          }
          return
        }
      }

      // 3) 没变化 → 归位
      if (container && sourceEl.style.display === 'none') {
        // 已收合 → 占位 FLIP 重新展开
        const box = animateOpen(container, sourceEl)
        flyTo(box, false, sourceEl)
      } else {
        // 收合还没来得及发生（极快的拖放）→ 直接归位即可
        sourceEl.style.display = ''
        const box = sourceEl.getBoundingClientRect()
        sourceEl.style.opacity = '0'
        flyTo(box, false, sourceEl)
      }
    })
  }

  _active = { raf: 0, end }
  document.addEventListener('dragover', onOver)
  document.addEventListener('drop', end, true)   // 捕获阶段，先于业务 drop 收尾视觉
  sourceEl.addEventListener('dragend', end)
  _active.raf = requestAnimationFrame(frame)
}
