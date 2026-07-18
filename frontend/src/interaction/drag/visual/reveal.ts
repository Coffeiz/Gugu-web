export function revealWithoutStaleHover(
  el: HTMLElement,
  pointerMode: boolean,
  onSettled?: () => void,
  keepControls = false,
  isActive: () => boolean = () => true,
): void {
  el.classList.add('phys-just-revealed')
  el.classList.add('phys-reveal-snap')
  // 跟 main 分支一致：这里只加 phys-reveal-controls（控制按钮/连接点 opacity 直接可见，
  // 跟卡片是否真的 hover 无关，纯粹是"揭示这一刻不要空窗"）。不再额外加 phys-reveal-hover——
  // 那个类用 !important 直接钉死 transform/box-shadow，绕开了卡片自己 `.hover-card-fx:hover`
  // 的 CSS transition，在 phys-reveal-snap 窗口内加上就等于"瞬间摆好抬起终态，之后也不再
  // 触发任何动画"，表现为本体 hover 是瞬间生效、没有平滑上浮的过程。抬起动效交给下面
  // dispatchEvent(mouseenter) 触发的真实 :hover 状态自己去过渡，不需要额外用一个 !important
  // 类顶替它。
  if (keepControls) {
    el.classList.add('phys-reveal-controls')
  }
  el.style.opacity = ''
  el.style.pointerEvents = ''
  if (pointerMode && (keepControls || el.matches(':hover'))) {
    el.dispatchEvent(new MouseEvent('mouseenter'))
  }
  void el.offsetWidth
  el.classList.remove('phys-reveal-snap')
  requestAnimationFrame(() => {
    // pointer 模式下 finishSession 可能在同一轮调用栈里结束 session；这个视觉清理不能
    // 因此被 isActive 拦掉，否则 phys-just-revealed 会永久留在卡片上并被下一次克隆继承。
    el.classList.remove('phys-just-revealed')
    if (keepControls) requestAnimationFrame(() => {
      el.classList.remove('phys-reveal-controls')
    })
  })
  if (pointerMode) {
    onSettled?.()
    return
  }
  el.style.pointerEvents = 'none'
  setTimeout(() => {
    if (!isActive()) return
    el.style.pointerEvents = ''
    onSettled?.()
  }, 160)
}

export function holdHoverUntilReveal(el: HTMLElement): void {
  el.classList.add('phys-just-revealed')
  // 飞行期间落点本体不可见时仍可被 pointer 事件命中，导致用户点击透明位置触发新拖拽。
  // 关掉 pointer-events，直到揭示时重新打开。
  el.style.pointerEvents = 'none'
}
