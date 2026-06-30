<template>
  <div class="cal-page">

    <!-- 工具栏 -->
    <div class="cal-toolbar glass-card">
      <div class="toolbar-left">
        <button class="nav-btn" @click="prev">
          <PhCaretLeft :size="14" weight="bold" />
        </button>
        <button class="period-btn" ref="pickerAnchorRef" @click="togglePicker">
          <span>{{ periodLabel }}</span>
          <PhCaretDown :size="11" weight="bold" :style="{ transform: pickerOpen ? 'rotate(180deg)' : '', transition: 'transform 0.2s' }" />
        </button>
        <button class="nav-btn" @click="next">
          <PhCaretRight :size="14" weight="bold" />
        </button>
      </div>
      <div class="toolbar-right">
        <div class="view-toggle">
          <button :class="{ on: viewMode === 'month' }" @click="setView('month')">月</button>
          <button :class="{ on: viewMode === 'week' }" @click="setView('week')">周</button>
        </div>
        <button class="today-btn" @click="goToday">今天</button>
      </div>
    </div>

    <!-- 主体 -->
    <div class="cal-layout">

      <!-- 日历主区 -->
      <div class="cal-main glass-card">
        <!-- ───── 月视图 ───── -->
        <template v-if="viewMode === 'month'">
        <div class="weekday-row">
          <span v-for="w in weekdays" :key="w" class="weekday-hdr" :class="{ weekend: w === '六' || w === '日' }">{{ w }}</span>
        </div>

        <div class="month-body">
          <div
            v-for="(week, wi) in monthWeeks" :key="wi"
            class="week-row"
            :data-wi="wi"
            :ref="el => setWeekRef(el, wi)"
            @mousemove="onWeekMouseMove($event, week)"
            @mouseleave="hoveredDateIso = null"
            @contextmenu.prevent="onWeekContextMenu($event, week)"
          >
            <div
              v-for="d in week" :key="d.key"
              class="month-cell"
              :data-iso="d.iso"
              :class="{
                'other-month':  d.other,
                'is-today':     d.isToday,
                'is-selected':  d.iso === selectedDate && !activeRange,
                'is-weekend':   d.dow >= 5,
                'is-holiday':   !d.other && hdayType(d.iso) === 'holiday',
                'is-workday':   !d.other && hdayType(d.iso) === 'workday',
                'cell-hovered': d.iso === hoveredDateIso,
                'in-range':     isInActiveRange(d.iso),
                'range-start':  activeRange && d.iso === activeRange.start,
                'range-end':    activeRange && d.iso === activeRange.end,
              }"
              @mousedown="onCellMouseDown(d, $event)"
            >
              <div class="cell-head">
                <div class="cell-num">{{ d.date }}</div>
                <span v-if="!d.other && hdayType(d.iso)" class="hday-badge" :class="'hday-' + hdayType(d.iso)">{{ hdayType(d.iso) === 'holiday' ? '休' : '班' }}</span>
              </div>
              <!-- chips：paddingTop 将格子坐标系对齐到 bars-layer 坐标系 -->
              <template v-for="lay in [dayLayout(d.iso, week, wi)]" :key="'lay'">
                <div
                  class="cell-chips"
                  :style="{ paddingTop: lay.paddingTop + 'px' }"
                >
                  <div
                    v-for="ev in lay.visibleChips" :key="ev.id"
                    class="event-chip cal-chip"
                    :class="{ 'chip-proj': ev.isProject, 'chip-ev-click': ev.isUserEvent, 'cal-done': ev.isProject && ev.status === 'done' }"
                    :style="{ background: ev.accent + '28', color: darkenHex(ev.accent), borderColor: ev.accent + '70', cursor: ev.isProject || ev.isUserEvent ? 'pointer' : 'default' }"
                    @click.left.stop="ev.isProject ? openProject(ev) : (ev.isUserEvent && openEditForm(ev, $event, true))"
                    @contextmenu.prevent.stop="ev.isUserEvent && openEditForm(ev, $event, true)"
                    @mousedown.stop="ev.isProject ? startProjChipDrag(ev, $event) : (ev.isUserEvent && startEventDrag(ev, $event))"
                  >
                    <span v-if="ev.isProject" class="chip-proj-tag">项目</span>
                    <span v-else class="chip-proj-tag chip-ev-tag">活动</span>
                    <span v-if="ev.isProject" class="bar-status-dot" :class="'bsd-' + ev.status"></span>
                    {{ ev.name }}
                  </div>
                  <button
                    v-if="lay.moreCount > 0"
                    class="chip-more-btn cal-chip"
                    @click.stop="showMore($event, d.iso, lay.moreItems)"
                  >+{{ lay.moreCount }} 更多</button>
                </div>
              </template>
            </div>

            <!-- 项目条层（绝对定位，覆盖整行，不再有溢出按钮） -->
            <div class="bars-layer">
              <template v-for="bar in weekBarsCapped(week, wi).bars" :key="bar.id">
                <div
                  class="project-bar cal-chip"
                  :class="{ 'bar-start': bar.startsHere, 'bar-end': bar.endsHere, 'bar-dragging': drag.active && drag.item?.id === bar.id, 'bar-hovered': hoveredBarId === bar.id, 'cal-done': bar.status === 'done' }"
                  :data-bar-id="bar.id"
                  @mouseenter="hoveredBarId = bar.id"
                  @mouseleave="hoveredBarId = null"
                  @click.stop="openProject(bar)"
                  @mousedown.stop="startBarDrag(bar, $event)"
                  :style="{
                    left:  bar.startsHere ? `calc(${bar.colStart / 7 * 100}% + 6px)` : (bar.colStart / 7 * 100) + '%',
                    right: bar.endsHere   ? `calc(${(7 - bar.colEnd - 1) / 7 * 100}% + 6px)` : ((7 - bar.colEnd - 1) / 7 * 100) + '%',
                    top:   (HEADER_H + bar.row * BAR_H) + 'px',
                    background: `linear-gradient(to right, ${bar.accent}50 0%, ${bar.accent}50 ${barSegFill(bar)}%, ${bar.accent}1a ${barSegFill(bar)}%, ${bar.accent}1a 100%)`,
                    borderColor: bar.accent + '70',
                    color:       darkenHex(bar.accent),
                  }"
                >
                  <div v-if="bar.startsHere" class="bar-rh bar-rh-left" @mousedown.stop.prevent="startBarResize(bar, 'start', $event)"></div>
                  <template v-if="bar.startsHere || bar.colStart === 0">
                    <span class="bar-proj-tag">项目</span>
                    <span class="bar-status-dot" :class="'bsd-' + bar.status"></span>
                    <span class="bar-label">{{ bar.name }}</span>
                  </template>
                  <div v-if="bar.endsHere" class="bar-rh bar-rh-right" @mousedown.stop.prevent="startBarResize(bar, 'end', $event)"></div>
                </div>
              </template>
            </div>
          </div>
        </div>
        </template>

        <!-- ───── 周视图（时间轴）───── -->
        <div v-else class="week-view">
          <!-- 日期表头 -->
          <div class="wv-head">
            <div class="wv-gutter"></div>
            <div v-for="d in weekDays" :key="d.iso" class="wv-dhead" :class="{ today: d.isToday, weekend: d.isWeekend, selected: wvDaySelected(d.iso) }"
                 @mousedown="onAllDayDown" @contextmenu.prevent="onAllDayContextMenu">
              <span class="wv-dow">周{{ d.cn }}</span>
              <span class="wv-dnum" :class="{ today: d.isToday }">{{ d.dateNum }}</span>
            </div>
          </div>

          <!-- 全天行：项目跨天条 + 无时间活动 -->
          <div class="wv-allday">
            <div class="wv-gutter wv-allday-tag">全天</div>
            <div class="wv-allday-grid" ref="wvAllDayGridRef" :style="{ height: wvAllDayH + 'px' }"
                 @mousedown="onAllDayDown" @contextmenu.prevent="onAllDayContextMenu">
              <div v-for="(d, ci) in weekDays" :key="d.iso" class="wv-aco" :class="{ today: d.isToday, weekend: d.isWeekend }" :style="{ left: ci / 7 * 100 + '%' }"></div>
              <div v-for="ci in wvSelCols" :key="'adsel' + ci" class="wv-ad-sel" :class="{ weekend: weekDays[ci]?.isWeekend }" :style="{ left: ci / 7 * 100 + '%' }"></div>
              <div v-for="bar in weekAllDayShown" :key="bar.id" class="wv-pbar cal-chip" :class="{ 'cal-done': bar.status === 'done' }"
                   :style="pbarStyle(bar)" @click.stop="openProject(bar)" :title="bar.name">
                <span class="bar-status-dot" :class="'bsd-' + bar.status"></span>{{ bar.name }}
              </div>
              <template v-for="(d, ci) in weekDays" :key="'it' + d.iso">
                <div v-for="(it, ii) in allDayItemsFor(d.iso)" :key="it.isProject ? it.id : it._uid"
                     class="wv-allday-ev cal-chip" :class="{ 'cal-done': it.isProject && it.status === 'done' }"
                     :style="{ left: ci / 7 * 100 + '%', top: ((wvShownRows + ii) * 20) + 'px', background: it.isProject ? capBg(it.accent, it.progress) : it.accent + '28', color: darkenHex(it.accent), borderColor: it.accent + '70' }"
                     @click.stop="it.isProject ? openProject(it) : openEditForm(it, $event, true)" :title="it.name">
                  <span v-if="it.isProject" class="bar-status-dot" :class="'bsd-' + it.status"></span>{{ it.name }}
                </div>
                <!-- 该天列被隐藏的跨天项目 → 在该列底部显示「+K 更多」（样式/逻辑完全同月视图，按天各自计数）-->
                <button v-if="weekMoreFor(ci).length" class="chip-more-btn cal-chip wv-more"
                        :style="{ left: ci / 7 * 100 + '%', top: ((wvShownRows + allDayItemsFor(d.iso).length) * 20) + 'px' }"
                        @click.stop="showMore($event, d.iso, weekMoreFor(ci))">+{{ weekMoreFor(ci).length }} 更多</button>
              </template>
            </div>
          </div>

          <!-- 时间网格（可滚动）-->
          <div class="wv-body" ref="wvBodyRef">
            <div class="wv-grid" :style="{ height: 24 * HOUR_H + 'px' }">
              <div class="wv-hours">
                <div v-for="h in 24" :key="h" class="wv-hour" :style="{ height: HOUR_H + 'px' }">
                  <span v-if="h > 1">{{ h - 1 }}:00</span>
                </div>
              </div>
              <div v-for="d in weekDays" :key="d.iso" class="wv-col" :class="{ today: d.isToday, weekend: d.isWeekend }"
                   :style="{ backgroundSize: '100% ' + HOUR_H + 'px' }"
                   @mousedown="onColDown($event, d)" @mousemove="onColMove($event, d)" @mouseleave="onColLeave"
                   @contextmenu.prevent="onColContextMenu($event, d)">
                <div v-if="wvSelectedSlot && wvSelectedSlot.iso === d.iso" class="wv-selected" :style="{ top: Math.min(wvSelectedSlot.h0, wvSelectedSlot.h1) * HOUR_H + 'px', height: (Math.abs(wvSelectedSlot.h1 - wvSelectedSlot.h0) + 1) * HOUR_H + 'px' }"></div>
                <div v-if="wvHover && wvHover.iso === d.iso && !wvSel" class="wv-hover" :style="{ top: wvHover.h * HOUR_H + 'px', height: HOUR_H + 'px' }"></div>
                <div v-if="wvSel && wvSel.iso === d.iso" class="wv-selbox" :style="{ top: Math.min(wvSel.h0, wvSel.h1) * HOUR_H + 'px', height: (Math.abs(wvSel.h1 - wvSel.h0) + 1) * HOUR_H + 'px' }"></div>
                <div v-if="d.isToday" class="wv-now" :style="{ top: nowTop + 'px' }"></div>
                <div v-for="b in timedLayoutFor(d.iso)" :key="b.ev._uid" class="wv-ev cal-chip"
                     :style="{ top: b.top + 'px', height: b.height + 'px', left: 'calc(' + b.leftPct + '% + 1px)', width: 'calc(' + b.widthPct + '% - 2px)', background: b.ev.accent + '2e', borderColor: b.ev.accent + '85', color: darkenHex(b.ev.accent) }"
                     @mousedown.stop="onEvDown(b.ev, $event)" @mousemove="onEvHover($event)" :title="b.ev.name">
                  <span class="wv-ev-t">{{ b.ev.time }}{{ b.ev.endTime ? '–' + b.ev.endTime : '' }}</span>
                  <span class="wv-ev-n">{{ b.ev.name }}</span>
                  <span v-if="b.ev.description" class="wv-ev-d">{{ b.ev.description }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 侧栏 -->
      <div class="cal-sidebar glass-card" ref="calSidebarRef">
        <div class="sidebar-top">
          <div class="sidebar-date-label">{{ selectedDateLabel }}</div>
          <button v-if="activeRange" class="add-event-btn add-proj-btn" @click="ctxAddProject">
            <PhPlus :size="13" weight="bold" />
            添加项目
          </button>
          <button v-else class="add-event-btn" ref="addBtnRef" @click="openAddForm">
            <PhPlus :size="13" weight="bold" />
            添加活动
          </button>
        </div>

        <div v-if="selectedEvents.length" class="sidebar-events">
          <div v-for="ev in selectedEvents" :key="ev.id" class="sidebar-ev"
               :class="{ 'cal-done': ev.isProject && ev.status === 'done' }"
               :data-event-id="ev.id"
               :style="{ cursor: ev.isProject || ev.isUserEvent ? 'pointer' : 'default' }"
               @click.left="ev.isProject ? openProject(ev) : (ev.isUserEvent && openEditForm(ev, $event))"
               @contextmenu.prevent="ev.isUserEvent && openEditForm(ev, $event)"
          >
            <div class="sidebar-ev-bar" :style="{ background: ev.accent }"></div>
            <div class="sidebar-ev-body">
              <div class="sidebar-ev-name" :style="ev.isProject ? { color: darkenHex(ev.accent) } : {}">
                <span v-if="!ev.isUserEvent" class="ev-type-badge ev-proj-badge" :style="{ color: darkenHex(ev.accent) }">项目</span>
                <span v-else class="ev-type-badge ev-event-badge">{{ typeLabel(ev.type) }}</span>
                <span v-if="ev.time" class="sidebar-ev-time">{{ ev.time }}{{ ev.endTime ? '–' + ev.endTime : '' }}<span v-if="isNextDay(ev.time, ev.endTime)" class="nextday-mini">次日</span></span>
                {{ ev.name }}
                <span v-if="ev.isProject && ev.status === 'done'" class="cal-done-mark"><PhCheck :size="9" weight="bold" /></span>
              </div>
              <template v-if="ev.isUserEvent">
                <div class="sidebar-ev-desc">
                  <PhAlignLeft :size="11" weight="bold" style="flex-shrink:0;opacity:0.38;margin-top:1px" />
                  <span v-if="ev.description">{{ ev.description }}</span>
                </div>
              </template>
              <template v-else>
                <div class="sidebar-ev-desc">
                  {{ ev.startDate?.slice(5).replace('-','/') }} → {{ ev.endDate?.slice(5).replace('-','/') }}
                  <template v-if="ev.currentStage"> · {{ ev.currentStage }}</template>
                </div>
              </template>
            </div>
            <button v-if="ev.isUserEvent" class="ev-del-btn" @click.stop="deleteEvent(ev)" title="删除活动">
              <PhTrash :size="12" weight="bold" />
            </button>
          </div>
        </div>
        <div v-else class="sidebar-empty">
          <PhCalendarBlank :size="26" weight="bold" style="opacity:0.3" />
          <span>当天无日程</span>
        </div>

        <div class="sidebar-divider"></div>

        <div class="sidebar-section-title">近期节点</div>
        <div v-for="ev in upcomingList" :key="ev.id" class="upcoming-item cap-row"
             :class="{ 'upcoming-proj': ev.isProject, 'upcoming-ev': ev.isUserEvent, 'cal-done': ev.isProject && ev.status === 'done' }"
             :style="{ cursor: ev.isProject || ev.isUserEvent ? 'pointer' : 'default' }"
             @click.left="ev.isProject ? openProject(ev) : (ev.isUserEvent && openEditForm(ev, $event))"
             @contextmenu.prevent="ev.isUserEvent && openEditForm(ev, $event)"
        >
          <div class="cap-capsule"
               :style="{ '--cap-bg': capBg(ev.accent, ev.progress), borderColor: hexAlpha(ev.accent, 0.3) }">
            <span class="cap-tag" :class="ev.isProject ? 'cap-tag-proj' : 'cap-tag-ev'" :style="ev.isProject ? { color: darkenHex(ev.accent) } : {}">{{ ev.isProject ? '项目' : '活动' }}</span>
            <span v-if="ev.isProject" class="cap-sdot" :class="'cap-s-' + ev.status"></span>
            <span class="cap-name" :style="{ color: darkenHex(ev.accent) }">{{ ev.name }}<span v-if="ev.isProject && ev.status === 'done'" class="cal-done-mark"><PhCheck :size="9" weight="bold" /></span></span>
            <span v-if="ev.status !== 'done'" class="cap-days" :class="{ urgent: ev.daysLeft <= 3 }">{{ ev.daysLabel }}</span>
          </div>
        </div>
      </div>

    </div>
  </div>

  <!-- 统一"更多"弹窗（项目 + 事件合并） -->
  <Teleport to="body">
    <Transition name="more-pop">
      <div v-if="morePopup.open" class="overflow-popup" ref="morePopupRef" :style="morePopup.style">
        <div class="overflow-popup-title">{{ morePopup.dateLabel }}</div>
        <div class="overflow-list">
          <div
            v-for="item in morePopup.items" :key="item.id"
            class="overflow-item cal-chip"
            :class="{ 'overflow-clickable': item.isProject || item.isUserEvent, 'cal-done': item.isProject && item.status === 'done' }"
            :style="{ background: item.isProject ? capBg(item.accent, item.progress) : item.accent + '28', borderColor: item.accent + '70', color: darkenHex(item.accent), cursor: (item.isProject || item.isUserEvent) ? 'grab' : 'default' }"
            @click.stop="item.isProject ? (morePopup.open = false, showEditForm = false, openProject(item)) : (item.isUserEvent && openEditForm(item, $event, true))"
            @mousedown.stop="(item.isProject || item.isUserEvent) && startMoreItemDrag(item, $event)"
          >
            <span class="overflow-tag" :class="{ 'overflow-tag-ev': !item.isProject }">{{ item.isProject ? '项目' : '活动' }}</span>
            <span v-if="item.isProject" class="bar-status-dot" :class="'bsd-' + item.status"></span>
            <span class="overflow-name">{{ item.name }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 年月快速选择器 -->
  <Teleport to="body">
    <Transition name="picker">
      <div v-if="pickerOpen" class="cal-month-picker" ref="pickerRef" :style="pickerStyle">
        <div class="picker-year-row">
          <button class="picker-nav" @click.stop="pickerYear--">
            <PhCaretLeft :size="12" weight="bold" />
          </button>
          <span class="picker-year">{{ pickerYear }}</span>
          <button class="picker-nav" @click.stop="pickerYear++">
            <PhCaretRight :size="12" weight="bold" />
          </button>
        </div>
        <div class="picker-months">
          <button
            v-for="m in 12" :key="m"
            class="picker-month"
            :class="{ active: m - 1 === cursor.getMonth() && pickerYear === cursor.getFullYear() }"
            @click.stop="selectYearMonth(pickerYear, m - 1)"
          >{{ m }}月</button>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 添加事件弹窗 -->
  <Teleport to="body">
    <Transition name="form-pop">
      <div v-if="showAddForm" class="add-event-popup" ref="addFormRef" :style="addFormStyle">
        <div class="popup-header">
          <span class="popup-title">添加活动</span>
          <button class="popup-close-btn" @click="showAddForm = false" title="关闭">
            <PhX :size="12" weight="bold" />
          </button>
        </div>
        <input v-model="newEvent.name" class="popup-input" placeholder="活动名称" @keydown.enter="saveEvent" @keydown.esc="showAddForm = false" autofocus />
        <DatePicker v-model="newEvent.date" placeholder="选择日期" />
        <div class="time-box">
          <input :value="newEvent.time" type="text" maxlength="5" inputmode="numeric" placeholder="00:00" class="time-inner" @focus="($event.target as HTMLInputElement).select()" @input="onTimeInput($event, newEvent, 'time')" @blur="newEvent.time = normTime(newEvent.time)" />
          <span class="time-dash">—</span>
          <input :value="newEvent.endTime" type="text" maxlength="5" inputmode="numeric" placeholder="00:00" class="time-inner" @focus="($event.target as HTMLInputElement).select()" @input="onTimeInput($event, newEvent, 'endTime')" @blur="newEvent.endTime = normTime(newEvent.endTime)" />
          <span v-if="isNextDay(newEvent.time, newEvent.endTime)" class="nextday-tag">次日</span>
        </div>
        <textarea v-model="newEvent.description" class="popup-textarea" placeholder="描述（可选）" rows="2"></textarea>
        <div class="reminder-section" v-if="!isPastDate(activeFormDate)">
          <div class="reminder-label"><PhBell :size="11" weight="bold" /> 提醒</div>
          <div v-for="(r, i) in reminders" :key="i" class="reminder-item">
            <select v-model.number="r.leadMin" class="lead-select">
              <option v-for="o in LEAD_OPTIONS" :key="o.min" :value="o.min">{{ o.label }}</option>
            </select>
            <button class="reminder-del" @click="removeReminderAt(i)" title="移除"><PhX :size="10" weight="bold" /></button>
          </div>
          <button class="reminder-add-toggle" @click="addReminder">＋ 添加提醒</button>
          <div class="chan-block" v-if="reminders.length">
            <div class="reminder-label">渠道</div>
            <div class="chan-chips">
              <button class="chan-chip" :class="{ on: reminderChannels.includes('web') }" @click="toggleReminderChannel('web')">web</button>
              <button v-for="ch in imChannels" :key="ch" class="chan-chip" :class="{ on: reminderChannels.includes(ch) }" @click="toggleReminderChannel(ch)">{{ CHAN_LABEL[ch] || ch }}</button>
            </div>
            <button class="reminder-test-bar" @click="testReminderChannels"><PhPaperPlaneTilt :size="11" weight="bold" /> 测试发送</button>
          </div>
        </div>
        <div class="popup-actions">
          <button class="popup-save" @click="saveEvent" :disabled="!newEvent.name">保存</button>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 日期格右键菜单 -->
  <Teleport to="body">
    <div
      v-if="cellCtx.show"
      ref="cellCtxRef"
      class="popup-menu cal-ctx-menu"
      :style="{ position:'fixed', left: cellCtx.x+'px', top: cellCtx.y+'px', zIndex: 3000, minWidth:'110px' }"
    >
      <button class="popup-menu-item" @click="ctxAddEvent">
        <PhCalendarPlus :size="13" weight="bold" />
        新建活动
      </button>
      <button v-if="cellCtx.kind !== 'timed'" class="popup-menu-item" @click="ctxAddProject">
        <PhFolderPlus :size="13" weight="bold" />
        新建项目
      </button>
    </div>
  </Teleport>

  <!-- 编辑事件弹窗 -->
  <Teleport to="body">
    <Transition name="form-pop">
      <div v-if="showEditForm && editingEvent" class="add-event-popup" ref="editFormRef" :style="editFormStyle">
        <div class="popup-header">
          <span class="popup-title">编辑活动</span>
          <button class="popup-close-btn" @click="showEditForm = false" title="关闭">
            <PhX :size="12" weight="bold" />
          </button>
        </div>
        <input v-model="editingEvent.name" class="popup-input" placeholder="活动名称" @keydown.enter="saveEditEvent" @keydown.esc="showEditForm = false" autofocus />
        <DatePicker v-model="editingEvent.date" placeholder="选择日期" />
        <div class="time-box">
          <input :value="editingEvent.time" type="text" maxlength="5" inputmode="numeric" placeholder="00:00" class="time-inner" @focus="($event.target as HTMLInputElement).select()" @input="onTimeInput($event, editingEvent, 'time')" @blur="editingEvent.time = normTime(editingEvent.time)" />
          <span class="time-dash">—</span>
          <input :value="editingEvent.endTime" type="text" maxlength="5" inputmode="numeric" placeholder="00:00" class="time-inner" @focus="($event.target as HTMLInputElement).select()" @input="onTimeInput($event, editingEvent, 'endTime')" @blur="editingEvent.endTime = normTime(editingEvent.endTime)" />
          <span v-if="isNextDay(editingEvent.time, editingEvent.endTime)" class="nextday-tag">次日</span>
        </div>
        <textarea v-model="editingEvent.description" class="popup-textarea" placeholder="描述（可选）" rows="2"></textarea>
        <div class="reminder-section" v-if="!isPastDate(activeFormDate)">
          <div class="reminder-label"><PhBell :size="11" weight="bold" /> 提醒</div>
          <div v-for="(r, i) in reminders" :key="i" class="reminder-item">
            <select v-model.number="r.leadMin" class="lead-select">
              <option v-for="o in LEAD_OPTIONS" :key="o.min" :value="o.min">{{ o.label }}</option>
            </select>
            <button class="reminder-del" @click="removeReminderAt(i)" title="移除"><PhX :size="10" weight="bold" /></button>
          </div>
          <button class="reminder-add-toggle" @click="addReminder">＋ 添加提醒</button>
          <div class="chan-block" v-if="reminders.length">
            <div class="reminder-label">渠道</div>
            <div class="chan-chips">
              <button class="chan-chip" :class="{ on: reminderChannels.includes('web') }" @click="toggleReminderChannel('web')">web</button>
              <button v-for="ch in imChannels" :key="ch" class="chan-chip" :class="{ on: reminderChannels.includes(ch) }" @click="toggleReminderChannel(ch)">{{ CHAN_LABEL[ch] || ch }}</button>
            </div>
            <button class="reminder-test-bar" @click="testReminderChannels"><PhPaperPlaneTilt :size="11" weight="bold" /> 测试发送</button>
          </div>
        </div>
        <div class="popup-actions">
          <button class="popup-save" @click="saveEditEvent" :disabled="!editingEvent.name">保存</button>
          <button class="popup-delete" @click="deleteEventFromEdit">删除</button>
        </div>
      </div>
    </Transition>
  </Teleport>

  <Teleport to="body">
    <Transition name="cal-toast">
      <div v-if="toastMsg" class="cal-toast">{{ toastMsg }}</div>
    </Transition>
  </Teleport>
</template>

<script lang="ts">
const eventsCache: Record<string, any> = {}
const upcomingEventsCache: { data: any } = { data: null }
</script>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useProjectStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import { useLiveStore } from '@/stores/live'
import { useAuthStore } from '@/stores/auth'
import { usePreferencesStore } from '@/stores/preferences'
import { eventsApi, scheduledTasksApi } from '@/services/api'
import { calendarSignal } from '@/services/cache'
import DatePicker from '@/components/common/DatePicker.vue'
import { useHolidays } from '@/composables/useHolidays'
import { fireHint } from '@/composables/useOnboarding'
import { projectProgress } from '@/utils/projectProgress'
import { PhCaretLeft, PhCaretRight, PhCaretDown, PhPlus, PhAlignLeft, PhTrash, PhCalendarBlank, PhX, PhCalendarPlus, PhFolderPlus, PhCheck, PhStack, PhBell, PhPaperPlaneTilt } from '@phosphor-icons/vue'

const projectStore = useProjectStore()
const uiStore = useUiStore()
const liveStore = useLiveStore()
const authStore = useAuthStore()
const prefsStore = usePreferencesStore()
const todayIso = ref(toIso(new Date()))

let _midnightTimer = null
function scheduleMidnightTick() {
  const now = new Date()
  const msUntilMidnight = +new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - +now
  _midnightTimer = setTimeout(() => {
    todayIso.value = toIso(new Date())
    scheduleMidnightTick()
  }, msUntilMidnight)
}

const cursor       = ref(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
const selectedDate = ref(todayIso.value)

const { fetchYear, getHolidayType } = useHolidays()
const hdayCache = ref({})

async function loadHolidays() {
  const y = cursor.value.getFullYear()
  const years = [y]
  if (cursor.value.getMonth() === 11) years.push(y + 1)
  for (const yr of years) {
    if (!hdayCache.value[yr]) {
      const data = await fetchYear(yr)
      hdayCache.value = { ...hdayCache.value, [yr]: data }
    }
  }
}

function hdayType(isoDate) {
  if (!isoDate) return null
  const yr = +isoDate.slice(0, 4)
  return getHolidayType(hdayCache.value[yr], isoDate)
}
const showAddForm  = ref(false)
// 边打边格式化：取数字（最多4位），第2位后自动插冒号。1200 → 12:00、120 → 12:0
function onTimeInput(e, obj, key) {
  const d = e.target.value.replace(/\D/g, '').slice(0, 4)
  const out = d.length > 2 ? d.slice(0, 2) + ':' + d.slice(2) : d
  obj[key] = out
  e.target.value = out
}
// 时间直接输入：失焦时规整成 HH:MM（容忍「2330」「9:5」「23：00」等）；空/非法 → 空串
function normTime(v) {
  if (!v) return ''
  let s = String(v).replace(/[：]/g, ':').replace(/[^\d:]/g, '')
  if (/^\d{3,4}$/.test(s)) s = s.slice(0, -2) + ':' + s.slice(-2)   // 2330 → 23:30
  const m = s.match(/^(\d{1,2}):?(\d{0,2})$/)
  if (!m) return ''
  const h = Math.min(23, parseInt(m[1] || '0', 10))
  const mm = Math.min(59, parseInt(m[2] || '0', 10))
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}
// 结束时间早于开始时间 → 视为次日（跨午夜）。HH:MM 已零填充，直接字符串比较即可
function isNextDay(start, end) { return !!start && !!end && end < start }
// 过去的日期（早于今天）不能加提醒——@once 到点早已过、worker 会判过期清掉，加了也白加
function isPastDate(d) { return !!d && d < todayIso.value }
// 默认时间段：下一个整点 → 再过一小时。如现在 22:50 → 23:00–00:00（次日）
function defaultTimeRange() {
  const now = new Date()
  const p = n => String(n).padStart(2, '0')
  const sh = (now.getHours() + 1) % 24
  return { time: `${p(sh)}:00`, endTime: `${p((sh + 1) % 24)}:00` }
}
const newEvent     = ref({ name: '', date: todayIso.value, ...defaultTimeRange(), description: '' })
const addBtnRef    = ref(null)
const addFormRef   = ref(null)
const addFormStyle = ref({})

const showEditForm  = ref(false)
const editingEvent  = ref(null)
// 当前打开的活动表单的日期（编辑优先）——提醒区共享，用它判断能否加提醒
const activeFormDate = computed(() => showEditForm.value ? editingEvent.value?.date : newEvent.value?.date)
const editFormRef   = ref(null)
const editFormStyle = ref({})
const calSidebarRef = ref(null)

// ── 拖拽状态 ─────────────────────────────────────────────────────────────────
const drag = reactive({
  active:     false,
  type:       null,   // 'event' | 'proj-chip' | 'proj-bar' | 'proj-resize-start' | 'proj-resize-end'
  item:       null,
  offsetDays: 0,      // proj-bar: days from startDate to where drag started
})
const hoveredBarId  = ref(null)
const hoveredDateIso = ref(null)

// ── 日期范围框选 ──────────────────────────────────────────────────────────────
const rangeSelect  = reactive({ active: false, anchor: null })
const hoverRangeEnd = ref(null)
const selRange     = ref(null)   // { start, end } committed after mouseup

const activeRange = computed(() => {
  if (rangeSelect.active && rangeSelect.anchor && hoverRangeEnd.value) {
    const [a, b] = [rangeSelect.anchor, hoverRangeEnd.value].sort()
    if (a === b) return null   // 未跨天时不视为 range
    return { start: a, end: b }
  }
  return selRange.value
})

function isInActiveRange(iso) {
  const r = activeRange.value
  return r ? iso >= r.start && iso <= r.end : false
}

function onCellMouseDown(d, e) {
  if (e.button !== 0) return
  if (drag.active) return
  if (e.target.closest('.event-chip,.chip-more-btn,.project-bar,.bar-rh')) return
  e.preventDefault()

  const startIso = d.iso
  rangeSelect.active = true
  rangeSelect.anchor = startIso
  hoverRangeEnd.value = startIso
  selRange.value = null
  cellCtx.show = false

  const mm = (ev) => {
    const iso = isoFromPoint(ev.clientX, ev.clientY)
    if (iso) hoverRangeEnd.value = iso
  }
  const mu = (ev) => {
    document.removeEventListener('mousemove', mm)
    document.removeEventListener('mouseup', mu)
    rangeSelect.active = false
    const endIso = isoFromPoint(ev.clientX, ev.clientY) || startIso
    hoverRangeEnd.value = null
    if (endIso !== startIso) {
      const [a, b] = [startIso, endIso].sort()
      selRange.value = { start: a, end: b }
      document.addEventListener('click', ce => ce.stopPropagation(), { capture: true, once: true })
    } else {
      selRange.value = null
      selectedDate.value = startIso
    }
  }
  document.addEventListener('mousemove', mm)
  document.addEventListener('mouseup', mu)
}

// ── 右键菜单 ─────────────────────────────────────────────────────────────────
const cellCtx = reactive({ show: false, x: 0, y: 0, iso: null, range: null, kind: 'month', time: '', endTime: '' })
const cellCtxRef = ref(null)

function onWeekContextMenu(e, week) {
  if (e.target.closest('.event-chip,.chip-more-btn,.project-bar')) return
  const iso = isoFromPoint(e.clientX, e.clientY)
  if (!iso) return
  cellCtx.kind  = 'month'
  cellCtx.time  = ''; cellCtx.endTime = ''
  cellCtx.iso   = iso
  cellCtx.range = activeRange.value ?? null   // 右键时快照，避免后续被 handleClickOutside 清掉
  cellCtx.x     = e.clientX
  cellCtx.y     = e.clientY
  cellCtx.show  = true
}

function ctxAddEvent() {
  cellCtx.show = false
  const iso = cellCtx.range?.start ?? cellCtx.iso
  const tr = cellCtx.kind === 'timed'  ? { time: cellCtx.time, endTime: cellCtx.endTime }
           : cellCtx.kind === 'allday' ? { time: '', endTime: '' }       // 全天区 → 无时间活动
           : defaultTimeRange()
  newEvent.value = { name: '', date: iso, ...tr, description: '' }
  resetReminder()
  const ADD_H = 260
  const ctxTop = (window.innerHeight - cellCtx.y - 8 >= ADD_H)
    ? cellCtx.y + 8
    : cellCtx.y - ADD_H - 8
  addFormStyle.value = {
    position: 'fixed',
    top:  Math.max(8, ctxTop) + 'px',
    left: Math.max(8, Math.min(cellCtx.x - 120, window.innerWidth - 258)) + 'px',
    width: '240px', zIndex: 1000,
  }
  showAddForm.value = true
  nextTick(() => clampPopupIntoView(addFormRef, addFormStyle))
}

function ctxAddProject() {
  cellCtx.show = false
  uiStore.newProjectRange = cellCtx.range
    ?? activeRange.value
    ?? { start: cellCtx.iso || selectedDate.value, end: cellCtx.iso || selectedDate.value }
  uiStore.openNewProject = true
}

// ── 周视图·全天区：横向多日框选（复用 rangeSelect/selRange/activeRange）+ 右键新建项目 ──
const wvAllDayGridRef = ref(null)
function _isoFromAllDayX(clientX) {
  const grid = wvAllDayGridRef.value
  if (!grid) return null
  const r = grid.getBoundingClientRect()
  const ci = Math.max(0, Math.min(6, Math.floor((clientX - r.left) / r.width * 7)))
  return weekDays.value[ci]?.iso ?? null
}
// 当前周里落在 activeRange 内的列索引（全天区高亮）
const wvSelCols = computed(() => {
  if (viewMode.value !== 'week') return []
  const r = activeRange.value
  if (!r) return []
  return weekDays.value.map((d, ci) => (d.iso >= r.start && d.iso <= r.end ? ci : -1)).filter(ci => ci >= 0)
})
// 「日选择」判定：只看 activeRange（顶部日期格 + 全天区共用）。单选也走 selRange={iso,iso}，
// 故与「时段选择」(wvSelectedSlot) 互不干扰、互斥（见 onAllDayDown / onColDown）。
function wvDaySelected(iso) {
  const r = activeRange.value
  return r ? (iso >= r.start && iso <= r.end) : false
}
function onAllDayDown(e) {
  if (e.button !== 0) return
  if (e.target.closest('.wv-pbar,.wv-allday-ev,.wv-more')) return   // 点在已有条/活动上 → 不框选
  const startIso = _isoFromAllDayX(e.clientX)
  if (!startIso) return
  e.preventDefault()
  wvSelectedSlot.value = null   // 选日期 → 清掉小时格选区（两者用途不同，互斥）
  rangeSelect.active = true
  rangeSelect.anchor = startIso
  hoverRangeEnd.value = startIso
  selRange.value = null
  cellCtx.show = false
  const mm = (ev) => { const iso = _isoFromAllDayX(ev.clientX); if (iso) hoverRangeEnd.value = iso }
  const mu = (ev) => {
    document.removeEventListener('mousemove', mm)
    document.removeEventListener('mouseup', mu)
    rangeSelect.active = false
    const endIso = _isoFromAllDayX(ev.clientX) || startIso
    hoverRangeEnd.value = null
    if (endIso !== startIso) {   // 多选：提交日期区间
      const [a, b] = [startIso, endIso].sort()
      selRange.value = { start: a, end: b }
      document.addEventListener('click', ce => ce.stopPropagation(), { capture: true, once: true })
    } else {                     // 单选：单天也用 range 表示（统一高亮 + 可右键建单天项目）
      selRange.value = { start: startIso, end: startIso }
      selectedDate.value = startIso
    }
  }
  document.addEventListener('mousemove', mm)
  document.addEventListener('mouseup', mu)
}
function onAllDayContextMenu(e) {
  if (e.target.closest('.wv-pbar,.wv-allday-ev,.wv-more')) return
  const iso = _isoFromAllDayX(e.clientX)
  if (!iso) return
  cellCtx.kind  = 'allday'
  cellCtx.iso   = iso
  cellCtx.range = activeRange.value ?? null
  cellCtx.time  = ''; cellCtx.endTime = ''
  cellCtx.x = e.clientX; cellCtx.y = e.clientY; cellCtx.show = true
}
// ── 周视图·小时区：右键在该天该时刻新建活动（有暗色选区则用选区时间段）──
function onColContextMenu(e, d) {
  if (e.target.closest('.wv-ev')) return
  const p = n => String(n).padStart(2, '0')
  let time, endTime
  const sel = wvSelectedSlot.value
  if (sel && sel.iso === d.iso) {        // 复用左键拖出的选区时间段
    const a = Math.min(sel.h0, sel.h1), b = Math.max(sel.h0, sel.h1) + 1
    time = `${p(a)}:00`; endTime = b >= 24 ? '00:00' : `${p(b)}:00`
  } else {                               // 单选：右键点击处的整点 → 1 小时
    const h = _hourAt(e.clientY, e.currentTarget.getBoundingClientRect())
    time = `${p(h)}:00`; endTime = h + 1 >= 24 ? '00:00' : `${p(h + 1)}:00`
  }
  cellCtx.kind = 'timed'
  cellCtx.iso  = d.iso
  cellCtx.range = null
  cellCtx.time = time; cellCtx.endTime = endTime
  cellCtx.x = e.clientX; cellCtx.y = e.clientY; cellCtx.show = true
}

function onWeekMouseMove(e, week) {
  const rect = e.currentTarget.getBoundingClientRect()
  const col  = Math.floor((e.clientX - rect.left) / rect.width * 7)
  hoveredDateIso.value = week[Math.max(0, Math.min(6, col))]?.iso ?? null
}

const dragOverIso = ref(null)

const dragOverRange = computed(() => {
  if (!drag.active || !dragOverIso.value) return null
  const iso = dragOverIso.value
  if (drag.type === 'event') return { start: iso, end: iso }
  if (drag.type === 'proj-chip') return { start: iso, end: iso }
  if (drag.type === 'proj-bar') {
    const newStart = addDays(iso, -drag.offsetDays)
    const dur      = daysBetween(drag.item.startDate, drag.item.endDate)
    return { start: newStart, end: addDays(newStart, dur) }
  }
  if (drag.type === 'proj-resize-start') {
    if (iso > drag.item.endDate) return null
    return { start: iso, end: drag.item.endDate }
  }
  if (drag.type === 'proj-resize-end') {
    if (iso < drag.item.startDate) return null
    return { start: drag.item.startDate, end: iso }
  }
  return null
})

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return toIso(d)
}
function barSegFill(bar) {
  if (!bar.progress) return 0
  // total 含端点（+1）：与下面 segEndOff 的「含端点 +1」口径一致。
  // 否则 progressDays 最大只到 end-start，永远 < 末段 segEndOff(=total+1)，100% 的项目长条只填到 ~90%。
  const total = daysBetween(bar.startDate, bar.endDate) + 1
  if (total <= 0) return bar.progress
  const progressDays  = total * bar.progress / 100
  const segStartOff   = daysBetween(bar.startDate, bar.segStartIso)
  const segEndOff     = daysBetween(bar.startDate, bar.segEndIso) + 1
  if (progressDays <= segStartOff) return 0
  if (progressDays >= segEndOff)   return 100
  return Math.round((progressDays - segStartOff) / (segEndOff - segStartOff) * 100)
}

function daysBetween(isoA, isoB) {
  return Math.round((+new Date(isoB + 'T00:00:00') - +new Date(isoA + 'T00:00:00')) / 86400000)
}
function isoFromPoint(x, y) {
  // elementsFromPoint won't reach month-cell behind bars-layer; use grid bounds instead
  for (let wi = 0; wi < monthWeeks.value.length; wi++) {
    const el = weekRowElMap[wi]
    if (!el) continue
    const rect = el.getBoundingClientRect()
    if (y >= rect.top && y < rect.bottom && x >= rect.left && x < rect.right) {
      const col = Math.min(6, Math.max(0, Math.floor((x - rect.left) / (rect.width / 7))))
      return monthWeeks.value[wi]?.[col]?.iso ?? null
    }
  }
  return null
}
function isInDragRange(iso) {
  const r = dragOverRange.value
  return r ? iso >= r.start && iso <= r.end : false
}

function startDrag(type, item, e, offsetDays = 0, onActivate = null) {
  const startX = e.clientX
  const startY = e.clientY
  let activated = false

  const mm = (ev) => {
    if (!activated) {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (Math.sqrt(dx * dx + dy * dy) < 5) return
      activated = true
      drag.active     = true
      drag.type       = type
      drag.item       = item
      drag.offsetDays = offsetDays
      document.body.style.cursor     = 'grabbing'
      document.body.style.userSelect = 'none'
      onActivate?.()
    }
    dragOverIso.value = isoFromPoint(ev.clientX, ev.clientY)
  }

  const mu = (ev) => {
    document.removeEventListener('mousemove', mm)
    document.removeEventListener('mouseup', mu)
    if (activated) {
      dragOverIso.value = isoFromPoint(ev.clientX, ev.clientY)
      commitDrag()
      // suppress the click that fires after mouseup so it doesn't trigger open/select
      document.addEventListener('click', (ce) => ce.stopPropagation(), { capture: true, once: true })
      setTimeout(() => {
        drag.active = false
        drag.type   = null
        drag.item   = null
        dragOverIso.value = null
      }, 30)
    }
    document.body.style.cursor     = ''
    document.body.style.userSelect = ''
  }

  document.addEventListener('mousemove', mm)
  document.addEventListener('mouseup', mu)
}

function startEventDrag(ev, e)              { startDrag('event', ev, e) }
function startProjChipDrag(bar, e)          { startDrag('proj-chip', bar, e) }
function startMoreItemDrag(item, e) {
  const closePopup = () => { morePopup.value.open = false }
  if (item.isProject) startDrag('proj-chip', item, e, 0, closePopup)
  else if (item.isUserEvent) startDrag('event', item, e, 0, closePopup)
}
function startBarDrag(bar, e) {
  const anchorIso = isoFromPoint(e.clientX, e.clientY) ?? bar.startDate
  startDrag('proj-bar', bar, e, daysBetween(bar.startDate, anchorIso))
}
function startBarResize(bar, edge, e) {
  startDrag(edge === 'start' ? 'proj-resize-start' : 'proj-resize-end', bar, e)
}

async function commitDrag() {
  const range = dragOverRange.value
  if (!range) return

  if (drag.type === 'event') {
    const ev = drag.item
    if (ev.date === range.start) return
    const patch = (list) => {
      const idx = list.findIndex(e => e.id === ev.id)
      if (idx !== -1) list[idx] = { ...list[idx], date: range.start }
    }
    patch(extraEvents.value)
    patch(nextMonthEvents.value)
    patch(spilloverEvents.value)
    buildUpcomingList()
    eventsCache[`${cursor.value.getFullYear()}-${cursor.value.getMonth() + 1}`] = [...extraEvents.value]
    try {
      const updated = await eventsApi.update(ev.id, { title: ev.name, date: range.start, description: ev.description || undefined, version: ev.version })
      const applyVer = (list) => { const i = list.findIndex(e => e.id === ev.id); if (i !== -1 && updated?.version) list[i] = { ...list[i], version: updated.version } }
      applyVer(extraEvents.value); applyVer(nextMonthEvents.value); applyVer(spilloverEvents.value)
    } catch (e) { if (e.status === 409) { alert('活动已被其他用户修改，请刷新页面'); await fetchEvents() } }
  }

  if (['proj-chip', 'proj-bar', 'proj-resize-start', 'proj-resize-end'].includes(drag.type)) {
    const projId = Number(String(drag.item.id).replace(/^p/, ''))
    const proj   = projectStore.projects.find(p => p.id === projId)
    if (!proj) return
    if (range.start === drag.item.startDate && range.end === drag.item.endDate) return
    try { await projectStore.updateProject(projId, { startDate: range.start, deadline: range.end }) } catch {}
  }
}

// ── 年月选择器 ──
const pickerOpen      = ref(false)
const pickerYear      = ref(new Date().getFullYear())
const pickerAnchorRef = ref(null)
const pickerRef       = ref(null)
const pickerStyle     = ref({})

const morePopup    = ref({ open: false, items: [], dateLabel: '', style: {} })
const morePopupRef = ref(null)

// ── 动态行高测量 ──
const BAR_H    = 20  // 每条 bar / chip 的行高（slot 高，含间距）
const HEADER_H = 32  // bars-layer 第一条 bar 的 top：cell-num 底部(31) + 1px 间距
const CELL_TOP = 31  // cell-chips 起点：cell padding-top(7) + cell-num(24)
const BOTTOM_PAD = 8 // 底部安全留白（px）：cell padding-bottom(4) + 4px 视觉安全区

const weekHeights = ref({})   // { [weekIndex]: heightInPx }
const weekRowElMap = {}       // 原生 el 引用，不需要响应式

function setWeekRef(el, wi) {
  if (el) weekRowElMap[wi] = el
  else    delete weekRowElMap[wi]
}

let ro = null
function setupRO() {
  if (ro) ro.disconnect()
  ro = new ResizeObserver(entries => {
    const next = { ...weekHeights.value }
    entries.forEach(e => {
      const wi = parseInt((e.target as HTMLElement).dataset.wi)
      if (!isNaN(wi)) next[wi] = e.contentRect.height
    })
    weekHeights.value = next
  })
  Object.entries(weekRowElMap).forEach(([wi, el]) => {
    if (el) ro.observe(el)
  })
}

// 某一行最多能放几个条目（项目条 + 更多按钮 + chip 共用这个池）
function maxSlots(wi) {
  const h = weekHeights.value[wi] ?? 90
  return Math.max(1, Math.floor((h - HEADER_H - BOTTOM_PAD) / BAR_H))
}

// ── 核心布局计算 ──

// weekBars 结果按周缓存，避免贪心算法在同一渲染周期内重复执行
const _weekBarsCache = new Map()
function weekBarsCached(week) {
  const key = week[0].iso
  if (!_weekBarsCache.has(key)) _weekBarsCache.set(key, weekBars(week))
  return _weekBarsCache.get(key)
}
// projectTimelines 变化时清缓存（watch 在 script setup 末尾注册）

function weekBarsCapped(week, wi) {
  const all = weekBarsCached(week)
  const max = maxSlots(wi)
  return {
    bars: all.filter(b => b.row < max),
    all,
  }
}

/**
 * 统一的格子布局：一次调用完成所有计算，返回 paddingTop、可见 chips、更多信息。
 * 消除模板中 dayLayout + nextAvailableRow 的重复 weekBars 调用。
 */
function dayLayout(iso, week, wi) {
  const { bars: cappedBars, all } = weekBarsCapped(week, wi)

  // chip 起始行 = 覆盖该天的可见 bar 中最大 row + 1
  let maxBarRow = -1
  cappedBars.forEach(b => {
    if (b.startDate <= iso && b.endDate >= iso) maxBarRow = Math.max(maxBarRow, b.row)
  })
  const nextRow  = maxBarRow + 1
  const paddingTop = Math.max(0, nextRow * BAR_H + HEADER_H - CELL_TOP)
  const slots    = Math.max(0, maxSlots(wi) - nextRow)

  // 当天被隐藏的项目（row >= max）
  const cappedIds = new Set(cappedBars.map(b => b.id))
  const hiddenProjects = all
    .filter(b => b.startDate <= iso && b.endDate >= iso && !cappedIds.has(b.id))
    .map(b => ({ ...b, isProject: true }))

  // 单日项目（startDate === endDate）不进 bars-layer，在此当 chip 显示
  const singleDayProjects = effectiveProjectTimelines.value
    .filter(p => p.startDate === p.endDate && p.startDate === iso)
    .map(p => ({ ...p, isProject: true }))
  const allChips = [...singleDayProjects, ...effectiveExtraEvents.value.filter(e => e.date === iso)]
  const _chipPrio = p => ({ high: 3, medium: 2, low: 1 }[p.priority] ?? 0)
  allChips.sort((a, b) => {
    const da = a.status === 'done' ? 1 : 0
    const db = b.status === 'done' ? 1 : 0
    if (da !== db) return da - db
    const pd = _chipPrio(b) - _chipPrio(a)
    if (pd !== 0) return pd
    const as_ = a.startDate ?? a.date ?? ''
    const bs  = b.startDate ?? b.date ?? ''
    if (as_ !== bs) return as_.localeCompare(bs)
    const ae = a.endDate ?? a.date ?? ''
    const be = b.endDate ?? b.date ?? ''
    if (ae !== be) return ae.localeCompare(be)
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
  })
  const hasMore  = hiddenProjects.length > 0 || allChips.length > slots

  if (!hasMore) {
    return { paddingTop, visibleChips: allChips, moreCount: 0, moreItems: [] }
  }
  const chipLimit    = Math.max(0, slots - 1)
  const visibleChips = allChips.slice(0, chipLimit)
  const hiddenChips  = allChips.slice(chipLimit)
  const moreItems    = [...hiddenProjects, ...hiddenChips]
  return { paddingTop, visibleChips, moreCount: moreItems.length, moreItems }
}

// ── 统一"更多"弹窗 ──
function showMore(e, iso, items) {
  const d     = new Date(iso + 'T00:00:00')
  const label = `${d.getMonth()+1}月${d.getDate()}日`
  const w     = 230
  const rect  = e.currentTarget.getBoundingClientRect()
  const estH  = 48 + items.length * 30   // 估算弹窗高度
  const gap   = 6
  const left  = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - 8))

  const spaceBelow = window.innerHeight - rect.bottom
  const openUp     = spaceBelow < estH + gap && rect.top > estH + gap

  const style = openUp
    ? { position: 'fixed', bottom: (window.innerHeight - rect.top + gap) + 'px', left: left + 'px', width: w + 'px', zIndex: 2000, transformOrigin: 'bottom' }
    : { position: 'fixed', top: (rect.bottom + gap) + 'px',                      left: left + 'px', width: w + 'px', zIndex: 2000, transformOrigin: 'top' }

  morePopup.value = { open: true, items, dateLabel: label, style }
}

function togglePicker() {
  if (pickerOpen.value) { pickerOpen.value = false; return }
  pickerYear.value = cursor.value.getFullYear()
  pickerOpen.value = true
  nextTick(() => {
    const rect = pickerAnchorRef.value?.getBoundingClientRect()
    if (!rect) return
    const w = 220
    let left = rect.left + rect.width / 2 - w / 2
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
    pickerStyle.value = { position: 'fixed', top: rect.bottom + 6 + 'px', left: left + 'px', width: w + 'px', zIndex: 2000 }
  })
}

function selectYearMonth(y, m) {
  cursor.value = new Date(y, m, 1)
  pickerOpen.value = false
}

const weekdays = ['一', '二', '三', '四', '五', '六', '日']

function toIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function extractAccent(colorStr) {
  const m = colorStr?.match(/#[0-9a-fA-F]{6}/)
  return m ? m[0] : '#7b7fb2'
}
function capBg(hex, progress) {
  const base = hexAlpha(hex, 0.1)
  if (!progress) return base
  const fill = hexAlpha(hex, 0.32)
  return `linear-gradient(to right, ${fill} 0%, ${fill} ${progress}%, ${base} ${progress}%, ${base} 100%)`
}

function hexAlpha(hex, a) {
  const r = parseInt(hex.slice(1,3),16)
  const g = parseInt(hex.slice(3,5),16)
  const b = parseInt(hex.slice(5,7),16)
  return `rgba(${r},${g},${b},${a})`
}
function darkenHex(hex, amount = 0.60) {
  const r = Math.round(parseInt(hex.slice(1,3),16) * amount)
  const g = Math.round(parseInt(hex.slice(3,5),16) * amount)
  const b = Math.round(parseInt(hex.slice(5,7),16) * amount)
  return `rgb(${r},${g},${b})`
}
function typeLabel(t) {
  return { deadline: '截止日', meeting: '会议', review: '审核', milestone: '节点', project: '进行中' }[t] ?? '活动'
}

const TYPE_ACCENT = {
  meeting:   '#7b7fb2',
  review:    '#7ab8c8',
  milestone: '#c4afc8',
  deadline:  '#b07858',
  event:     '#8a8fa8',
}

function normalizeEvent(e) {
  return {
    _uid:        e._uid ?? ('e' + e.id),   // 稳定客户端标识：本地增删改按它匹配，不受临时→真 id 替换影响
    id:          e.id,
    date:        e.date,
    time:        e.time ?? '',
    endTime:     e.endTime ?? '',
    name:        e.title,
    client:      e.client ?? '',
    type:        e.type,
    accent:      TYPE_ACCENT[e.type] ?? '#8a8fa8',
    isUserEvent: true,
    description: e.description ?? '',
    version:     e.version ?? 1,
  }
}

const extraEvents     = ref([])
const nextMonthEvents = ref([])

async function fetchNextMonthEvents() {
  const now = new Date()
  const m   = now.getMonth() + 1
  const nm  = m === 12 ? 1 : m + 1
  const ny  = m === 12 ? now.getFullYear() + 1 : now.getFullYear()
  const key = `${ny}-${nm}`
  if (eventsCache[key]) { nextMonthEvents.value = eventsCache[key]; return }
  try {
    const data       = await eventsApi.list(ny, nm)
    const normalized = data.map(normalizeEvent)
    eventsCache[key] = normalized
    nextMonthEvents.value = normalized
  } catch { }
}

async function fetchEvents() {
  const y   = cursor.value.getFullYear()
  const m   = cursor.value.getMonth() + 1
  const key = `${y}-${m}`
  if (eventsCache[key]) extraEvents.value = eventsCache[key]
  try {
    const data       = await eventsApi.list(y, m)
    const normalized = data.map(normalizeEvent)
    eventsCache[key] = normalized
    extraEvents.value = normalized
  } catch { }
}

// 网格首/末行会溢出到上/下月（首行最多 6 天上月、末行最多 6 天下月），这些「其他月」格子上的
// 单日活动也要显示。按 cursor 取上、下月活动（与 nextMonthEvents 区分：那个按真实今天算、给「即将到来」侧栏用）。
const spilloverEvents = ref([])
async function fetchSpilloverEvents() {
  const y = cursor.value.getFullYear()
  const m = cursor.value.getMonth()
  const fetchMonth = async (date) => {
    const yy = date.getFullYear(), mm = date.getMonth() + 1
    const key = `${yy}-${mm}`
    if (eventsCache[key]) return eventsCache[key]
    try {
      const norm = (await eventsApi.list(yy, mm)).map(normalizeEvent)
      eventsCache[key] = norm
      return norm
    } catch { return [] }
  }
  const [prev, next] = await Promise.all([
    fetchMonth(new Date(y, m - 1, 1)),
    fetchMonth(new Date(y, m + 1, 1)),
  ])
  spilloverEvents.value = [...prev, ...next]
}

// 咕咕在对话里增删改了活动 → 清月缓存并重取当前月 + 溢出月
watch(calendarSignal, () => {
  for (const k in eventsCache) delete eventsCache[k]
  fetchEvents()
  fetchSpilloverEvents()
})

// 当前月 + 溢出月（按 id 去重）——渲染溢出格、选中日详情都用它，保证跨月活动可见
const visibleEvents = computed(() => {
  const ids = new Set(extraEvents.value.map(e => e.id))
  return [...extraEvents.value, ...spilloverEvents.value.filter(e => !ids.has(e.id))]
})

function singleEvents(iso) { return visibleEvents.value.filter(e => e.date === iso) }

function openProject(bar) {
  const pid = Number(bar.id.replace(/^p/, ''))
  const proj = projectStore.projects.find(p => p.id === pid)
  if (proj) projectStore.openModal(proj)
}

const projectTimelines = computed(() =>
  projectStore.projects
    .filter(p => p.startDate && p.deadline)
    .map(p => ({
      id:           `p${p.id}`,
      name:         p.name,
      client:       p.client,
      startDate:    (prefsStore.calendarDoneMode === 'done' && p.status === 'done' && p.doneAt && p.doneAt.slice(0, 10) < p.startDate)
                      ? p.doneAt.slice(0, 10) : p.startDate,
      endDate:      (prefsStore.calendarDoneMode === 'done' && p.status === 'done' && p.doneAt)
                      ? p.doneAt.slice(0, 10) : p.deadline,
      accent:       extractAccent(p.color),
      type:         'deadline',
      isProject:    true,
      status:       p.status,
      currentStage: p.stages?.find(s => s.key === p.currentStage)?.label ?? null,
      priority:     p.priority ?? null,
      createdAt:    p.createdAt ?? '',
      progress:     projectProgress(p),
    }))
)

const effectiveProjectTimelines = computed(() => {
  const range = dragOverRange.value
  if (!drag.active || !range || !drag.item) return projectTimelines.value
  if (!['proj-bar', 'proj-resize-start', 'proj-resize-end', 'proj-chip'].includes(drag.type)) return projectTimelines.value
  const dragId = drag.item.id
  return projectTimelines.value.map(p =>
    p.id === dragId ? { ...p, startDate: range.start, endDate: range.end } : p
  )
})

const effectiveExtraEvents = computed(() => {
  const base = visibleEvents.value
  const range = dragOverRange.value
  if (!drag.active || drag.type !== 'event' || !range || !drag.item) return base
  const evId = drag.item.id
  return base.map(e =>
    e.id === evId ? { ...e, date: range.start } : e
  )
})

const monthDays = computed(() => {
  const y = cursor.value.getFullYear()
  const m = cursor.value.getMonth()
  const first    = new Date(y, m, 1)
  const last     = new Date(y, m + 1, 0)
  const startDow = (first.getDay() + 6) % 7
  const days     = []
  for (let i = startDow - 1; i >= 0; i--) {
    const d = new Date(y, m, -i)
    days.push({ key: `p${i}`, date: d.getDate(), iso: toIso(d), other: true, isToday: false, dow: (d.getDay()+6)%7 })
  }
  for (let i = 1; i <= last.getDate(); i++) {
    const d   = new Date(y, m, i)
    const iso = toIso(d)
    days.push({ key: iso, date: i, iso, other: false, isToday: iso === todayIso.value, dow: (d.getDay()+6)%7 })
  }
  const rem = 7 - (days.length % 7)
  if (rem < 7) for (let i = 1; i <= rem; i++) {
    const d = new Date(y, m + 1, i)
    days.push({ key: `n${i}`, date: i, iso: toIso(d), other: true, isToday: false, dow: (d.getDay()+6)%7 })
  }
  return days
})

const monthWeeks = computed(() => {
  const w = []
  for (let i = 0; i < monthDays.value.length; i += 7) w.push(monthDays.value.slice(i, i+7))
  return w
})

function weekBars(week) {
  const ws = week[0].iso
  const we = week[6].iso
  const bars = effectiveProjectTimelines.value
    .filter(p => p.endDate >= ws && p.startDate <= we && p.startDate !== p.endDate)
    .map(p => {
      const colStart = p.startDate <= ws ? 0 : week.findIndex(d => d.iso >= p.startDate)
      let colEnd = 6
      for (let i = 6; i >= 0; i--) { if (week[i].iso <= p.endDate) { colEnd = i; break } }
      const cs = Math.max(0, colStart)
      const ce = Math.min(6, colEnd)
      return {
        ...p,
        colStart: cs,
        colEnd:   ce,
        startsHere:   p.startDate >= ws && p.startDate <= we,
        endsHere:     p.endDate   >= ws && p.endDate   <= we,
        segStartIso:  week[cs].iso,
        segEndIso:    week[ce].iso,
        row:          0,   // 占位，下方贪心分行回填（让 TS 认得 .row）
      }
    })

  // 贪心区间着色：已完成排末尾；其次截止日早的优先；再次开始日；最后创建时间兜底
  const _prioVal = p => ({ high: 3, medium: 2, low: 1 }[p.priority] ?? 0)
  bars.sort((a, b) => {
    const da = a.status === 'done' ? 1 : 0
    const db = b.status === 'done' ? 1 : 0
    if (da !== db) return da - db
    const pd = _prioVal(b) - _prioVal(a)
    if (pd !== 0) return pd
    if (a.startDate !== b.startDate) return a.startDate.localeCompare(b.startDate)
    if (a.endDate !== b.endDate) return a.endDate.localeCompare(b.endDate)
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
  })
  const rowEnds = []  // rowEnds[r] = 该行最后一条 bar 的 colEnd
  bars.forEach(bar => {
    let r = 0
    while (rowEnds[r] !== undefined && rowEnds[r] >= bar.colStart) r++
    bar.row = r
    rowEnds[r] = bar.colEnd
  })

  return bars
}

// ───────────────── 周视图（时间轴）─────────────────
const viewMode  = ref('month')        // 'month' | 'week'
const weekRef   = ref(new Date())     // 可视周内任一日期
const HOUR_H    = 48                   // 每小时像素高
const wvBodyRef = ref(null)
const _CN_DOW   = ['日','一','二','三','四','五','六']

function _mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))   // 回到本周一
  return x
}
const weekDays = computed(() => {
  const mon = _mondayOf(weekRef.value)
  const out = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i)
    const iso = toIso(d)
    out.push({ iso, dateNum: d.getDate(), cn: _CN_DOW[d.getDay()],
               md: (d.getMonth()+1) + '/' + d.getDate(),
               isToday: iso === todayIso.value,
               isWeekend: d.getDay() === 0 || d.getDay() === 6 })
  }
  return out
})

function _parseMin(t) { const [h, m] = (t || '').split(':').map(Number); return (h || 0) * 60 + (m || 0) }

// 某天「有时间」的活动 → 计算位置 + 重叠分栏（聚簇贪心分列）
function timedLayoutFor(iso) {
  const items = visibleEvents.value
    .filter(e => e.date === iso && e.time)
    .map(e => {
      const s = _parseMin(e.time)
      let en = e.endTime ? _parseMin(e.endTime) : s + 60
      if (en <= s) en = 1440          // 结束<=开始（次日/无效）→ 当天截到 24:00
      return { ev: e, s, e: Math.min(1440, en) }
    })
    .sort((a, b) => a.s - b.s || a.e - b.e)
  const res = []
  let cluster = [], cEnd = -1
  const flush = () => {
    const colEnds = []
    cluster.forEach(it => {
      let c = 0
      while (c < colEnds.length && colEnds[c] > it.s) c++
      it._col = c; colEnds[c] = it.e
    })
    const n = Math.max(1, colEnds.length)
    cluster.forEach(it => { it._n = n })
    res.push(...cluster); cluster = []; cEnd = -1
  }
  items.forEach(it => {
    if (cluster.length && it.s >= cEnd) flush()
    cluster.push(it); cEnd = Math.max(cEnd, it.e)
  })
  flush()
  return res.map(it => ({
    ev: it.ev,
    top: it.s / 60 * HOUR_H,
    height: Math.max(15, (it.e - it.s) / 60 * HOUR_H - 2),
    leftPct: it._col / it._n * 100,
    widthPct: 100 / it._n,
  }))
}

// 某天「无时间」的活动 → 全天行
function allDayEventsFor(iso) { return visibleEvents.value.filter(e => e.date === iso && !e.time) }
// 单日项目（startDate===endDate）：weekBars 只收跨天条，这类在全天行当单天条目显示（同月视图把它当 chip）
function singleDayProjectsFor(iso) {
  return effectiveProjectTimelines.value
    .filter(p => p.startDate === p.endDate && p.startDate === iso)
    .map(p => ({ ...p, isProject: true }))
}
// 某天全天行的单天条目 = 单日项目 + 无时间活动，按月视图 chip 排序（done 末尾→优先级→开始/日期→创建）
function allDayItemsFor(iso) {
  const items = [...singleDayProjectsFor(iso), ...allDayEventsFor(iso).map(e => ({ ...e, isProject: false }))]
  const prio = p => ({ high: 3, medium: 2, low: 1 }[p.priority] ?? 0)
  return items.sort((a, b) => {
    const da = a.status === 'done' ? 1 : 0, db = b.status === 'done' ? 1 : 0
    if (da !== db) return da - db
    const pd = prio(b) - prio(a); if (pd) return pd
    const as_ = a.startDate ?? a.date ?? '', bs = b.startDate ?? b.date ?? ''
    if (as_ !== bs) return as_.localeCompare(bs)
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
  })
}
// 本周项目跨天条（复用月视图的 weekBars 布局）
// weekBars 已按月视图同一逻辑排序（done 末尾→优先级→开始日→截止日→创建时间）并贪心分行
const weekAllDayBars  = computed(() => weekBars(weekDays.value))
const _WEEK_MAX_PROJ  = 10   // 全天行最多显示的项目数，超出收入「更多」（同月视图：封顶 + 更多）
const weekAllDayShown = computed(() => weekAllDayBars.value.slice(0, _WEEK_MAX_PROJ))
const weekAllDayMore  = computed(() => weekAllDayBars.value.slice(_WEEK_MAX_PROJ).map(b => ({ ...b, isProject: true })))
const wvShownRows     = computed(() => weekAllDayShown.value.reduce((m, b) => Math.max(m, b.row + 1), 0))
// 第 ci 列被隐藏（超出 10）的跨天项目 = 覆盖该天的隐藏条；每天列各自「更多」，按实际位置显示（同月视图）
function weekMoreFor(ci) { return weekAllDayMore.value.filter(b => b.colStart <= ci && b.colEnd >= ci) }
function pbarStyle(bar) {
  return { left: bar.colStart / 7 * 100 + '%',
           width: (bar.colEnd - bar.colStart + 1) / 7 * 100 + '%',
           top: bar.row * 20 + 'px',
           background: capBg(bar.accent, bar.progress),   // 进度填充：与月视图/侧栏胶囊一致
           borderColor: bar.accent + '70', color: darkenHex(bar.accent) }
}

// 全天行高度：取各列「跨天条行 + 该列单日条目行 + 该列若有更多再 +1」的最大行数（避免溢出）
const wvAllDayH = computed(() => {
  let maxRows = wvShownRows.value
  weekDays.value.forEach((d, ci) => {
    const rows = wvShownRows.value + allDayItemsFor(d.iso).length + (weekMoreFor(ci).length ? 1 : 0)
    if (rows > maxRows) maxRows = rows
  })
  return Math.max(maxRows * 20 + 6, 26)
})

// 当前时间红线（每分钟更新）
const nowMinutes = ref(new Date().getHours() * 60 + new Date().getMinutes())
const nowTop = computed(() => nowMinutes.value / 60 * HOUR_H)
let _nowTimer = null
onMounted(() => { _nowTimer = setInterval(() => { nowMinutes.value = new Date().getHours() * 60 + new Date().getMinutes() }, 60000) })
onUnmounted(() => clearInterval(_nowTimer))

function setView(m) {
  if (m === viewMode.value) return
  if (m === 'week') weekRef.value = new Date((selectedDate.value || todayIso.value) + 'T00:00:00')
  else cursor.value = new Date(weekRef.value.getFullYear(), weekRef.value.getMonth(), 1)
  viewMode.value = m
}
// 周视图导航/切换时把 cursor 同步到当周月份 → 触发按月 fetch（含 spillover，覆盖跨月那周）
watch(weekRef, v => {
  const m0 = new Date(v.getFullYear(), v.getMonth(), 1)
  if (m0.getFullYear() !== cursor.value.getFullYear() || m0.getMonth() !== cursor.value.getMonth()) cursor.value = m0
})

// 周视图：悬停高亮小时格 + 按下拖拽选时段建活动
const wvHover = ref(null)   // { iso, h } 悬停的小时格
const wvSel   = ref(null)   // { iso, h0, h1 } 拖拽中选区
const wvSelectedSlot = ref(null)   // { iso, h0, h1 } 点击/拖拽后保持暗色的选中格
let _wvColRect = null
function _hourAt(clientY, rect) { return Math.max(0, Math.min(23, Math.floor((clientY - rect.top) / HOUR_H))) }

function onColMove(e, d) {
  if (wvSel.value || _evDrag) return                          // 选区/活动拖拽中：不高亮小时格
  if (e.target.closest('.wv-ev')) { wvHover.value = null; return }   // 鼠标在活动上：不高亮下方格（替代原 .stop，避免挡住 document 拖拽监听）
  wvHover.value = { iso: d.iso, h: _hourAt(e.clientY, e.currentTarget.getBoundingClientRect()) }
}
function onColLeave() { if (!wvSel.value) wvHover.value = null }

function onColDown(e, d) {
  if (e.button !== 0) return
  selRange.value = null   // 选时段 → 清掉日期选择（两者用途不同，互斥）
  _wvColRect = e.currentTarget.getBoundingClientRect()
  const h = _hourAt(e.clientY, _wvColRect)
  wvSel.value = { iso: d.iso, h0: h, h1: h }
  wvHover.value = null
  document.addEventListener('mousemove', _wvDrag)
  document.addEventListener('mouseup', _wvUp)
  e.preventDefault()
}
function _wvDrag(e) {
  if (!wvSel.value || !_wvColRect) return
  wvSel.value = { ...wvSel.value, h1: _hourAt(e.clientY, _wvColRect) }
}
function _wvUp(e) {
  document.removeEventListener('mousemove', _wvDrag)
  document.removeEventListener('mouseup', _wvUp)
  const sel = wvSel.value
  wvSel.value = null
  if (!sel) return
  const a = Math.min(sel.h0, sel.h1), b = Math.max(sel.h0, sel.h1)
  const p = n => String(n).padStart(2, '0')
  const endV = b + 1   // 拖到 B 点 → 覆盖到 (B+1):00；点一下不拖 → 1 小时
  wvSelectedSlot.value = { iso: sel.iso, h0: a, h1: b }   // 点击后格子保持暗色
  selectedDate.value = sel.iso
  newEvent.value = { name: '', date: sel.iso, time: `${p(a)}:00`, endTime: endV >= 24 ? '00:00' : `${p(endV)}:00`, description: '' }
  resetReminder()
  const w = 240
  const left = Math.max(8, Math.min(e.clientX - w / 2, window.innerWidth - w - 8))
  addFormStyle.value = { position: 'fixed', top: Math.max(8, e.clientY + 8) + 'px', left: left + 'px', width: w + 'px', zIndex: 1000 }
  showAddForm.value = true
  nextTick(() => clampPopupIntoView(addFormRef, addFormStyle))
}

// ── 周视图：拖活动边缘改起止时间 / 拖活动体改日期 ──
const _SNAP = 30   // 分钟吸附
let _evDrag = null
function _toMin(t) { const [h, m] = (t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0) }
function _fromMin(min) { const p = n => String(n).padStart(2, '0'); min = ((Math.round(min) % 1440) + 1440) % 1440; return `${p(Math.floor(min / 60))}:${p(min % 60)}` }
function _snapMin(min) { return Math.max(0, Math.min(1440, Math.round(min / _SNAP) * _SNAP)) }

function _setEventLocal(id, fields) {
  const apply = (list) => { const i = list.findIndex(e => e.id === id); if (i !== -1) list[i] = { ...list[i], ...fields } }
  apply(extraEvents.value); apply(nextMonthEvents.value); apply(spilloverEvents.value)
}
async function _persistEvent(s) {
  buildUpcomingList()
  eventsCache[`${cursor.value.getFullYear()}-${cursor.value.getMonth() + 1}`] = [...extraEvents.value]
  try {
    const updated = await eventsApi.update(s.id, { title: s.name, date: s.date, time: s.time || null, endTime: s.endTime || null, description: s.description || undefined, version: s.version })
    if (updated?.version) _setEventLocal(s.id, { version: updated.version })
  } catch (e) { if (e.status === 409) { alert('活动已被其他用户修改，请刷新页面'); await fetchEvents() } }
}

function onEvResize(ev, edge, e) {   // 拖边缘改起止时间
  const colEl = e.currentTarget.closest('.wv-col')
  _evDrag = { kind: 'resize', edge, colRect: colEl.getBoundingClientRect(), moved: false,
              id: ev.id, _uid: ev._uid, name: ev.name, description: ev.description, version: ev.version, date: ev.date, time: ev.time, endTime: ev.endTime,
              startMin: _toMin(ev.time || '09:00'), endMin: ev.endTime ? _toMin(ev.endTime) : _toMin(ev.time || '09:00') + 60 }
  if (_evDrag.endMin <= _evDrag.startMin) _evDrag.endMin = 1440
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', _evDragMove)
  document.addEventListener('mouseup', _evDragUp)
  e.preventDefault()
}
function _evEdge(e) {   // 按下/悬停位置离上下边缘的判定：'start'(上) / 'end'(下) / null(中间)
  const rect = e.currentTarget.getBoundingClientRect()
  const off = e.clientY - rect.top
  const EDGE = Math.min(7, rect.height / 2)   // 短块时减半，免上下交叠
  if (off <= EDGE) return 'start'
  if (off >= rect.height - EDGE) return 'end'
  return null
}
function onEvHover(e) {   // 悬停活动：清掉小时格悬停 + 按位置切换光标（边缘=ns-resize、中间=grab）
  wvHover.value = null
  e.currentTarget.style.cursor = _evEdge(e) ? 'ns-resize' : 'grab'
}
function onEvDown(ev, e) {   // 按下活动体：近边缘=缩放起止，中间=自由移动，未拖=编辑
  if (e.button !== 0) return
  const edge = _evEdge(e)
  if (edge) return onEvResize(ev, edge, e)
  const sM = _toMin(ev.time || '09:00')
  let eM = ev.endTime ? _toMin(ev.endTime) : sM + 60
  if (eM <= sM) eM = sM + 60
  _evDrag = { kind: 'move', x0: e.clientX, y0: e.clientY, moved: false,
              id: ev.id, _uid: ev._uid, name: ev.name, description: ev.description, version: ev.version,
              date: ev.date, time: ev.time, endTime: ev.endTime,
              startMin0: sM, dur: eM - sM,
              cols: [...document.querySelectorAll('.week-view .wv-col')].map((el, i) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, iso: weekDays.value[i]?.iso } }) }
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', _evDragMove)
  document.addEventListener('mouseup', _evDragUp)
}
function _evDragMove(e) {
  if (!_evDrag) return
  if (_evDrag.kind === 'resize') {
    _evDrag.moved = true
    const min = _snapMin((e.clientY - _evDrag.colRect.top) / HOUR_H * 60)
    if (_evDrag.edge === 'start') _evDrag.startMin = Math.min(min, _evDrag.endMin - _SNAP)
    else _evDrag.endMin = Math.max(min, _evDrag.startMin + _SNAP)
    _evDrag.time = _fromMin(_evDrag.startMin)
    _evDrag.endTime = _evDrag.endMin >= 1440 ? '00:00' : _fromMin(_evDrag.endMin)
    _setEventLocal(_evDrag.id, { time: _evDrag.time, endTime: _evDrag.endTime })
    return
  }
  if (!_evDrag.moved && Math.abs(e.clientX - _evDrag.x0) + Math.abs(e.clientY - _evDrag.y0) < 5) return
  _evDrag.moved = true
  wvHover.value = null
  // 纵向：整体平移时间，保持时长，30 分吸附，限制在当天内
  let ns = _snapMin(_evDrag.startMin0 + (e.clientY - _evDrag.y0) / HOUR_H * 60)
  ns = Math.max(0, Math.min(1440 - _evDrag.dur, ns))
  const newTime = _fromMin(ns)
  const ne = ns + _evDrag.dur
  const newEnd = ne >= 1440 ? '00:00' : _fromMin(ne)
  // 横向：落在哪一列就是哪天
  const col = _evDrag.cols.find(c => e.clientX >= c.left && e.clientX < c.right)
  const newDate = (col && col.iso) ? col.iso : _evDrag.date
  if (newDate !== _evDrag.date || newTime !== _evDrag.time || newEnd !== _evDrag.endTime) {
    _evDrag.date = newDate; _evDrag.time = newTime; _evDrag.endTime = newEnd
    _setEventLocal(_evDrag.id, { date: newDate, time: newTime, endTime: newEnd })
  }
}
function _evDragUp(e) {
  document.removeEventListener('mousemove', _evDragMove)
  document.removeEventListener('mouseup', _evDragUp)
  document.body.style.userSelect = ''
  const s = _evDrag; _evDrag = null
  if (!s) return
  if (!s.moved) {   // 没拖动 = 单击 → 打开编辑（无论按在边缘还是中间）
    openEditForm({ _uid: s._uid, id: s.id, name: s.name, date: s.date, time: s.time, endTime: s.endTime, description: s.description, version: s.version }, e, true)
    return
  }
  selectedDate.value = s.date
  _persistEvent(s)
}

const periodLabel = computed(() => {
  if (viewMode.value === 'week') {
    const ds = weekDays.value
    return new Date(ds[0].iso + 'T00:00:00').getFullYear() + '年 ' + ds[0].md + ' - ' + ds[6].md
  }
  const c = cursor.value
  return c.getFullYear() + '年 ' + (c.getMonth()+1) + '月'
})

function prev() {
  if (viewMode.value === 'week') { const d = new Date(weekRef.value); d.setDate(d.getDate() - 7); weekRef.value = d }
  else { const d = new Date(cursor.value); d.setMonth(d.getMonth()-1); cursor.value = d }
}
function next() {
  if (viewMode.value === 'week') { const d = new Date(weekRef.value); d.setDate(d.getDate() + 7); weekRef.value = d }
  else { const d = new Date(cursor.value); d.setMonth(d.getMonth()+1); cursor.value = d }
}
function goToday() {
  const now = new Date()
  cursor.value = new Date(now.getFullYear(), now.getMonth(), 1)
  weekRef.value = now
  selectedDate.value = todayIso.value
}

const selectedDateLabel = computed(() => {
  if (!selectedDate.value) return ''
  const d = new Date(selectedDate.value + 'T00:00:00')
  const cn = ['日','一','二','三','四','五','六']
  return (d.getMonth()+1) + '月' + d.getDate() + '日 · 周' + cn[d.getDay()]
})

const selectedEvents = computed(() => {
  const sel = selectedDate.value
  const chips = singleEvents(sel)
  const prioVal = p => ({ high: 3, medium: 2, low: 1 }[p.priority] ?? 0)
  const activeProjects = projectTimelines.value
    .filter(p => p.startDate <= sel && p.endDate >= sel)
    .map(p => ({ ...p, type: p.endDate === sel ? 'deadline' : 'project' }))
    .sort((a, b) => {
      const aDone = a.status === 'done' ? 1 : 0
      const bDone = b.status === 'done' ? 1 : 0
      if (aDone !== bDone) return aDone - bDone
      return prioVal(b) - prioVal(a)
        || (a.startDate ?? '').localeCompare(b.startDate ?? '')
        || (a.endDate ?? '').localeCompare(b.endDate ?? '')
        || (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
    })
  return [...activeProjects, ...chips]
})

const upcomingList = ref([])

function buildUpcomingList() {
  const now         = new Date()
  const todayStr    = toIso(now)
  const cutoff      = toIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 15))
  const midnight    = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  function label(iso) {
    const d = Math.round((+new Date(iso + 'T00:00:00') - +midnight) / 86400000)
    return { daysLeft: d, daysLabel: d === 0 ? '今天' : d === 1 ? '明天' : d + '天后' }
  }

  const prioVal = p => ({ high: 3, medium: 2, low: 1 }[p.priority] ?? 0)

  // 项目截止（15天内），已完成项目排最后
  const projects = projectTimelines.value
    .filter(p => p.endDate >= todayStr && p.endDate <= cutoff)
    .sort((a, b) => {
      const doneDiff = (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0)
      if (doneDiff) return doneDiff
      return prioVal(b) - prioVal(a)
        || (a.startDate ?? '').localeCompare(b.startDate ?? '')
        || (a.endDate ?? '').localeCompare(b.endDate ?? '')
        || (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
    })
    .slice(0, 4)
    .map(p => ({ ...p, date: p.endDate, ...label(p.endDate) }))

  // 日历事件（当月 + 下月，15天内）
  const seen = new Set()
  const events = [...extraEvents.value, ...nextMonthEvents.value]
    .filter(ev => {
      if (seen.has(ev.id)) return false
      seen.add(ev.id)
      return ev.date >= todayStr && ev.date <= cutoff
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 4)
    .map(ev => ({ ...ev, ...label(ev.date) }))

  upcomingList.value = [...projects, ...events]
}

watch([projectTimelines, extraEvents, nextMonthEvents], buildUpcomingList, { immediate: true })
watch(activeRange, r => { uiStore.calendarActiveRange = r })

// 搜索跳转：导航到日程所在月份并高亮
watch(() => uiStore.pendingCalendarEvent, async (target) => {
  if (!target) return
  uiStore.pendingCalendarEvent = null
  const d = new Date(target.date + 'T00:00:00')
  cursor.value = new Date(d.getFullYear(), d.getMonth(), 1)
  selectedDate.value = target.date
  await nextTick()
  _flashCalendarEvent(target.id)
})

function _flashCalendarEvent(id) {
  setTimeout(() => {
    const el = document.querySelector(`[data-event-id="${id}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('search-flash')
    setTimeout(() => el.classList.remove('search-flash'), 1800)
  }, 150)
}

// 弹窗加提醒后会变高，可能顶出屏幕底部、保存按钮被切掉。
// 量实际高度，把 top 往上抬到「底部留 SAFE_GAP 安全距离」；超高就靠 CSS max-height 内部滚动。
const SAFE_GAP = 12
function clampPopupIntoView(elRef, styleRef) {
  const el = elRef.value
  if (!el) return
  const h = el.offsetHeight
  const cur = parseFloat(styleRef.value.top) || 0
  const maxTop = window.innerHeight - h - SAFE_GAP
  const top = Math.max(SAFE_GAP, Math.min(cur, maxTop))
  if (Math.abs(top - cur) > 0.5) styleRef.value = { ...styleRef.value, top: top + 'px' }
}
// 新建活动的默认日期/时间：周视图里若有选中格 → 用选中格时段；否则下一个整点
function _addDefaults() {
  if (viewMode.value === 'week' && wvSelectedSlot.value) {
    const s = wvSelectedSlot.value
    const a = Math.min(s.h0, s.h1), b = Math.max(s.h0, s.h1)
    const p = n => String(n).padStart(2, '0')
    const endV = b + 1
    return { date: s.iso, time: `${p(a)}:00`, endTime: endV >= 24 ? '00:00' : `${p(endV)}:00` }
  }
  return { date: selectedDate.value || todayIso.value, ...defaultTimeRange() }
}

function openAddForm() {
  newEvent.value = { name: '', ..._addDefaults(), description: '' }
  resetReminder()
  const btnEl = addBtnRef.value
  if (btnEl) {
    const btnRect    = btnEl.getBoundingClientRect()
    const popupWidth = 240
    const sbEl   = btnEl.closest('.cal-sidebar') ?? calSidebarRef.value
    const sbRect = sbEl?.getBoundingClientRect()
    const centerX = sbRect
      ? sbRect.left + sbRect.width / 2
      : btnRect.right - popupWidth / 2
    const left = Math.max(8, Math.min(centerX - popupWidth / 2, window.innerWidth - popupWidth - 8))
    const ADD_H = 260
    const btnTop = (window.innerHeight - btnRect.bottom - 8 >= ADD_H)
      ? btnRect.bottom + 8
      : btnRect.top - ADD_H - 8
    addFormStyle.value = {
      position: 'fixed',
      top:   Math.max(8, btnTop) + 'px',
      left:  left + 'px',
      width: popupWidth + 'px',
      zIndex: 1000,
    }
  }
  showAddForm.value = true
  nextTick(() => clampPopupIntoView(addFormRef, addFormStyle))
}

function openEditForm(ev, nativeEv, useMousePos = false) {
  showAddForm.value = false
  editingEvent.value = { _uid: ev._uid, id: ev.id, name: ev.name, date: ev.date, time: ev.time || '', endTime: ev.endTime || '', description: ev.description || '' }
  loadReminders(ev)
  const w = 240
  const EDIT_H = 300
  let left, top
  if (useMousePos) {
    left = Math.max(8, Math.min(nativeEv.clientX - w / 2, window.innerWidth - w - 8))
    top  = (window.innerHeight - nativeEv.clientY - 8 >= EDIT_H)
      ? nativeEv.clientY + 8
      : nativeEv.clientY - EDIT_H - 8
  } else {
    const el    = nativeEv.currentTarget ?? nativeEv.target
    const rect  = el.getBoundingClientRect()
    const sbEl  = el.closest('.cal-sidebar') ?? calSidebarRef.value
    const sbRect = sbEl?.getBoundingClientRect()
    const centerX = sbRect ? sbRect.left + sbRect.width / 2 : rect.left + rect.width / 2
    left = Math.max(8, Math.min(centerX - w / 2, window.innerWidth - w - 8))
    top  = (window.innerHeight - rect.bottom - 6 >= EDIT_H)
      ? rect.bottom + 6
      : rect.top - EDIT_H - 6
  }
  editFormStyle.value = { position: 'fixed', top: Math.max(8, top) + 'px', left: left + 'px', width: w + 'px', zIndex: 2100 }
  showEditForm.value = true
  nextTick(() => clampPopupIntoView(editFormRef, editFormStyle))
}

// ── 活动绑定的提醒（定时任务）：可加多个，每个用「提前量」下拉选；渠道按用户已绑（web + feishu/qq/wechat）勾选 ──
// 加/编辑两个表单共用；提醒在「保存活动」时一并对账落地（新增建、删除的删、改渠道）。
const LEAD_OPTIONS = [
  { label: '活动开始时',  min: 0 },
  { label: '提前 5 分钟', min: 5 },
  { label: '提前 15 分钟', min: 15 },
  { label: '提前 30 分钟', min: 30 },
  { label: '提前 1 小时', min: 60 },
  { label: '提前 2 小时', min: 120 },
  { label: '提前 1 天',   min: 1440 },
  { label: '提前 2 天',   min: 2880 },
]
const CHAN_LABEL = { web: 'web', feishu: '飞书', qq: 'QQ', wechat: '微信' }
const imChannels = computed(() => authStore.user?.imChannels ?? [])   // 用户已绑的 IM 平台
const reminders          = ref([])         // [{ id?, leadMin }]，可多个
const reminderChannels   = ref(['web'])    // 渠道（web + 已绑 IM），该活动的提醒共用
const removedReminderIds = ref([])         // 编辑里删掉的已存在提醒 id，保存时真删

// 提醒条数 / 渠道变化（弹窗变高）后重新夹住当前打开的弹窗，避免保存按钮顶出屏幕底部
watch([() => reminders.value.length, reminderChannels], () => {
  nextTick(() => {
    if (showEditForm.value) clampPopupIntoView(editFormRef, editFormStyle)
    else if (showAddForm.value) clampPopupIntoView(addFormRef, addFormStyle)
  })
})

function leadLabelOf(min) { return LEAD_OPTIONS.find(o => o.min === min)?.label || `提前 ${min} 分钟` }
function toggleReminderChannel(ch) {
  const set = new Set(reminderChannels.value)
  set.has(ch) ? set.delete(ch) : set.add(ch)
  if (set.size === 0) set.add(ch)   // 至少留一个
  reminderChannels.value = [...set]
}
function addReminder() {
  // 点一下就建一条提醒（默认提前 30 分钟），之后用它自己的下拉改时间
  reminders.value.push({ leadMin: 30 })
}
const toastMsg = ref('')
let toastTimer = null
function showToast(msg) {
  toastMsg.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastMsg.value = '' }, 3200)
}
// 测试提醒渠道：往当前选的渠道发一条测试消息（不建任务，新建/编辑活动都能测）
async function testReminderChannels() {
  try {
    const name = (showEditForm.value ? editingEvent.value?.name : newEvent.value?.name) || '活动提醒'
    const res = await scheduledTasksApi.testNotify({ channels: reminderChannels.value, name })
    showToast(res?.msg || '已发送测试消息')
  } catch { showToast('测试失败，请稍后重试') }
}
function removeReminderAt(i) {
  const r = reminders.value[i]
  if (r?.id) removedReminderIds.value.push(r.id)
  reminders.value.splice(i, 1)
}
function resetReminder() {
  reminders.value = []
  reminderChannels.value = ['web']
  removedReminderIds.value = []
}

function _pad2(n) { return String(n).padStart(2, '0') }
function _reminderAtIso(date, time, leadMin) {
  const [h, mm] = (time || '09:00').split(':').map(Number)
  const d = new Date(`${date}T00:00:00`)
  d.setHours(h, mm - leadMin, 0, 0)   // 负分钟/跨天由 Date 自动回退
  return `${d.getFullYear()}-${_pad2(d.getMonth()+1)}-${_pad2(d.getDate())}T${_pad2(d.getHours())}:${_pad2(d.getMinutes())}`
}

async function loadReminders(ev) {
  resetReminder()
  if (typeof ev.id !== 'number') return   // 临时事件（还没存）：保持 reset 态
  try {
    const tasks = (await scheduledTasksApi.listForEvent(ev.id))?.tasks || []
    if (!tasks.length) return
    reminderChannels.value = (tasks[0].channels && tasks[0].channels.length) ? tasks[0].channels : ['web']
    reminders.value = tasks.map(t => {
      let leadMin = 0
      if ((t.cron || '').startsWith('@once:')) {
        const raw = Math.round((+new Date(`${ev.date}T${ev.time || '09:00'}`) - +new Date(t.cron.slice(6))) / 60000)
        leadMin = LEAD_OPTIONS.reduce((b, o) => Math.abs(o.min - raw) < Math.abs(b - raw) ? o.min : b, 0)
      }
      return { id: t.id, leadMin }
    })
  } catch { /* 保持 reset 态 */ }
}

// 保存活动后调用：对账该活动的提醒——删掉移除的、改已存在的渠道/时刻、建新增的
async function applyReminders(eventId, name, date, time) {
  try {
    for (const id of removedReminderIds.value) await scheduledTasksApi.delete(id)
    removedReminderIds.value = []
    for (const r of reminders.value) {
      const cron = `@once:${_reminderAtIso(date, time, r.leadMin)}`
      const data = { name: `${name} 提醒`, payload: `提醒：${name}（${date}${time ? ' ' + time : ''}）`, cron, channels: reminderChannels.value }
      if (r.id) await scheduledTasksApi.update(r.id, data)
      else { const t = await scheduledTasksApi.create({ ...data, event_id: eventId }); r.id = t?.id ?? null }
    }
    liveStore.bump?.('scheduled_tasks')
  } catch { /* 提醒失败不挡活动保存 */ }
}

async function saveEditEvent() {
  const ev = editingEvent.value
  if (!ev?.name) return
  showEditForm.value = false

  // 更新本地列表
  const update = (list) => {
    const idx = list.findIndex(e => e.id === ev.id)
    if (idx !== -1) {
      list[idx] = { ...list[idx], name: ev.name, date: ev.date, time: ev.time || '', endTime: ev.endTime || '', description: ev.description }
    }
  }
  update(extraEvents.value)
  update(nextMonthEvents.value)
  update(spilloverEvents.value)
  buildUpcomingList()
  const cacheKey = `${cursor.value.getFullYear()}-${cursor.value.getMonth() + 1}`
  eventsCache[cacheKey] = [...extraEvents.value]

  try {
    const updated = await eventsApi.update(ev.id, { title: ev.name, date: ev.date, time: ev.time || null, endTime: ev.endTime || null, description: ev.description || undefined, version: ev.version })
    const applyVer = (list) => { const i = list.findIndex(e => e.id === ev.id); if (i !== -1 && updated?.version) list[i] = { ...list[i], version: updated.version } }
    applyVer(extraEvents.value); applyVer(nextMonthEvents.value); applyVer(spilloverEvents.value)
    await applyReminders(ev.id, ev.name, ev.date, ev.time)   // 按提前量/渠道落地提醒
  } catch (e) { if (e.status === 409) { alert('活动已被其他用户修改，请刷新页面'); await fetchEvents() } }
}

function handleClickOutside(e) {
  if (e.target.closest('.dp-popup')) return
  if (showAddForm.value) {
    if (!addBtnRef.value?.contains(e.target) && !addFormRef.value?.contains(e.target))
      showAddForm.value = false
  }
  if (showEditForm.value) {
    if (!editFormRef.value?.contains(e.target) && !morePopupRef.value?.contains(e.target))
      showEditForm.value = false
  }
  if (pickerOpen.value) {
    if (!pickerAnchorRef.value?.contains(e.target) && !pickerRef.value?.contains(e.target))
      pickerOpen.value = false
  }
  if (morePopup.value.open) {
    if (!morePopupRef.value?.contains(e.target) && !editFormRef.value?.contains(e.target))
      morePopup.value.open = false
  }
  if (cellCtx.show) {
    if (!cellCtxRef.value?.contains(e.target)) cellCtx.show = false
  }
}

onMounted(() => {
  fireHint('calendar')   // 新手引导：第一次打开日历
  document.addEventListener('click', handleClickOutside, true)
  fetchEvents()
  fetchNextMonthEvents()
  fetchSpilloverEvents()
  nextTick(setupRO)
  scheduleMidnightTick()
  loadHolidays()
})
onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside, true)
  ro?.disconnect()
  clearTimeout(_midnightTimer)
})

// 实时：咕咕/IM 改了日历 → 重新拉当前+下月活动
watch(() => liveStore.rev.calendar, () => { fetchEvents(); fetchNextMonthEvents(); fetchSpilloverEvents() })
watch(cursor, () => { fetchEvents(); fetchSpilloverEvents(); loadHolidays() })
watch(monthWeeks, () => nextTick(setupRO))
watch([projectTimelines, dragOverRange], () => _weekBarsCache.clear())

async function deleteEvent(ev) {
  // ① 按稳定 _uid 匹配（旧数据/无 _uid 时退回宽松 id 比较）——临时→真 id 替换后也能删对那份，
  //    杜绝「服务器删成功了、视图里那份却因 id 形态对不上而没删掉」。
  const match = (e) => (ev._uid != null ? e._uid === ev._uid : String(e.id) === String(ev.id))
  extraEvents.value     = extraEvents.value.filter(e => !match(e))
  nextMonthEvents.value = nextMonthEvents.value.filter(e => !match(e))
  spilloverEvents.value = spilloverEvents.value.filter(e => !match(e))
  buildUpcomingList()
  const key = `${cursor.value.getFullYear()}-${cursor.value.getMonth() + 1}`
  eventsCache[key] = extraEvents.value
  try {
    await eventsApi.delete(ev.id)
  } catch { /* 已删/网络等 → 下面对账兜底，不再静默留下脏状态 */ }
  finally {
    // ③ 与服务器对账：不管成功/404 都按最新刷一次，杜绝「删了还在 / 删了又回来 / 再删报错」
    fetchEvents(); fetchNextMonthEvents(); fetchSpilloverEvents()
  }
}

async function deleteEventFromEdit() {
  const ev = editingEvent.value
  if (!ev) return
  showEditForm.value = false
  await deleteEvent(ev)
}

async function saveEvent() {
  if (!newEvent.value.name) return
  const date = newEvent.value.date || selectedDate.value
  const uid = 'u' + Date.now()
  const localItem = {
    _uid:        uid,
    id:          uid,                    // 临时 id；create 回来换成真数字 id，但 _uid 不变
    date,
    time:        newEvent.value.time || '',
    endTime:     newEvent.value.endTime || '',
    name:        newEvent.value.name,
    client:      '',
    type:        'event',
    accent:      '#7b7fb2',
    isUserEvent: true,
    description: newEvent.value.description || '',
  }
  extraEvents.value.push(localItem)
  selectedDate.value = date
  newEvent.value = { name: '', date: todayIso.value, ...defaultTimeRange(), description: '' }
  showAddForm.value = false

  const cacheKey = `${cursor.value.getFullYear()}-${cursor.value.getMonth() + 1}`
  try {
    const created = await eventsApi.create({ title: localItem.name, date, time: localItem.time || undefined, endTime: localItem.endTime || undefined, type: 'event', description: localItem.description || undefined })
    const norm = { ...normalizeEvent(created), _uid: uid }   // 保留同一 _uid，删/改才能稳定匹配
    const idx = extraEvents.value.findIndex(e => e._uid === uid)
    if (idx !== -1) extraEvents.value[idx] = norm
    if (typeof created?.id === 'number') await applyReminders(created.id, localItem.name, date, localItem.time)   // 新活动按提前量/渠道建提醒
  } catch { }
  eventsCache[cacheKey] = [...extraEvents.value]
}
</script>

<style scoped>
/* 已完成项目：日历各处（chip / 项目条 / 侧边栏 / 近期节点 / 更多弹层）统一淡化 */
.cal-done { opacity: 0.45; }
.cal-done:hover { opacity: 0.7; }   /* 悬停略恢复，方便看清要操作的那条 */

.cal-page { display: flex; flex-direction: column; gap: 14px; height: 100%; }
.cal-toolbar { display: flex; align-items: center; justify-content: space-between; height: 52px; box-sizing: border-box; padding: 0 18px; flex-shrink: 0; }
.toolbar-left { display: flex; align-items: center; gap: 4px; }
.nav-btn { width: 30px; height: 30px; border-radius: 8px; border: none; background: none; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--text-secondary); transition: background 0.15s; }
.nav-btn:hover { background: rgba(0,0,0,0.06); }
.period-btn {
  display: flex; align-items: center; gap: 5px;
  font-size: 15px; font-weight: 700; color: var(--text-primary);
  min-width: 130px; justify-content: center;
  padding: 4px 10px; border-radius: 9px; border: none; background: none;
  cursor: pointer; font-family: var(--font-sans);
  transition: background 0.15s;
}
.period-btn:hover { background: rgba(0,0,0,0.06); }
.today-btn { padding: 5px 14px; border-radius: 8px; border: 1px solid rgba(0,0,0,0.1); background: rgba(255,255,255,0.56); font-size: 12px; font-weight: 600; cursor: pointer; color: var(--text-secondary); font-family: var(--font-sans); transition: all 0.15s; }
.today-btn:hover { background: rgba(255,255,255,0.82); color: var(--text-primary); }

.cal-layout { display: grid; grid-template-columns: 1fr 260px; gap: 14px; flex: 1; min-height: 0; }
.cal-main { padding: 16px 16px 8px; display: flex; flex-direction: column; overflow: hidden; }
.weekday-row { display: grid; grid-template-columns: repeat(7, 1fr); flex-shrink: 0; margin-bottom: 2px; }
.weekday-hdr { text-align: center; font-size: 11px; font-weight: 600; color: var(--text-secondary); padding: 3px 0 8px; border-right: 1px solid rgba(123,127,178,0.15); }
.weekday-hdr:last-child { border-right: none; }
.weekday-hdr.weekend { color: rgba(195,90,90,0.85); }

.month-body { flex: 1; display: flex; flex-direction: column; border-top: 1px solid rgba(123,127,178,0.15); overflow: hidden; }

.week-row {
  flex: 1;
  display: grid; grid-template-columns: repeat(7, 1fr);
  position: relative;
  border-bottom: 1px solid rgba(123,127,178,0.15);
  min-height: 80px;
  overflow: hidden;
}
.week-row:last-child { border-bottom: none; }

.month-cell {
  padding: 7px 6px 4px;
  border-right: 1px solid rgba(123,127,178,0.15);
  cursor: pointer; transition: background 0.12s;
  overflow: hidden;
}
.month-cell:last-child { border-right: none; }
.month-cell.cell-hovered { background: rgba(123,127,178,0.06); }
.month-cell.other-month { opacity: 0.3; }
.month-cell.is-weekend { background: rgba(195,90,90,0.028); }
.month-cell.is-weekend.cell-hovered { background: rgba(195,90,90,0.07); }
.month-cell.is-today { background: rgba(123,127,178,0.07); }
.month-cell.is-today.is-weekend { background: rgba(195,90,90,0.07); }
.month-cell.is-today .cell-num { background: linear-gradient(135deg,#7b7fb2,#9590c4); color: rgba(255,255,255,0.88) !important; font-weight: 700; border-radius: 6px; }
.month-cell.is-today.is-weekend .cell-num { background: linear-gradient(135deg,#b85c5c,#c97070); }
.month-cell.is-selected { background: rgba(123,127,178,0.1); }
.month-cell.is-selected.is-weekend { background: rgba(195,90,90,0.1); }
.month-cell.is-selected:not(.is-today) .cell-num { background: rgba(123,127,178,0.15); color: var(--color-primary); font-weight: 700; border-radius: 6px; }
.month-cell.is-selected:not(.is-today).is-weekend .cell-num { background: rgba(195,90,90,0.15); color: rgba(195,90,90,0.9); }
.month-cell.is-selected:not(.is-today).is-workday .cell-num { color: var(--color-primary); }

/* ── 日期范围框选 ── */
.month-cell.in-range { background: rgba(123,127,178,0.08); }
.month-cell.in-range.is-weekend { background: rgba(195,90,90,0.07); }
.month-cell.range-start,
.month-cell.range-end { background: rgba(123,127,178,0.16); }
.month-cell.range-start.is-weekend,
.month-cell.range-end.is-weekend { background: rgba(195,90,90,0.1); }
.month-cell.range-start .cell-num,
.month-cell.range-end .cell-num { background: rgba(123,127,178,0.22); color: var(--color-primary); font-weight: 700; border-radius: 6px; }
.month-cell.range-start.is-weekend .cell-num,
.month-cell.range-end.is-weekend .cell-num { background: rgba(195,90,90,0.15); color: rgba(195,90,90,0.9); }

.cell-head { display: flex; align-items: center; gap: 3px; height: 24px; }
.cell-num { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; line-height: 1; color: var(--text-primary); flex-shrink: 0; transition: all 0.15s; }
.hday-badge { font-size: 9px; font-weight: 700; line-height: 1; padding: 2px 3px; border-radius: 3px; flex-shrink: 0; }
.hday-holiday { background: rgba(210,75,75,0.1); color: rgba(210,75,75,0.82); }
.hday-workday { background: rgba(210,130,20,0.14); color: rgba(170,100,5,0.9); }
.month-cell.is-holiday .cell-num { color: rgba(210,75,75,0.82); }
.month-cell.is-workday.is-weekend .cell-num { color: var(--text-primary); }

/* chip 区域：paddingTop 由 JS 动态设置，推到 bar 下方 */
.cell-chips { display: flex; flex-direction: column; gap: 2px; }

.event-chip {
  height: 18px; box-sizing: border-box;
  font-size: 10px; font-weight: 500;
  padding: 0 7px; border-radius: 99px; border: 1px solid transparent;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  display: flex; align-items: center;
}
.event-chip.chip-proj,
.event-chip.chip-ev-click { cursor: grab; }
.chip-more-btn {
  height: 16px; box-sizing: border-box;
  font-size: 10px; font-weight: 500;
  padding: 0 7px; border-radius: 99px;
  border: 1px solid rgba(123,127,178,0.35);
  background: rgba(123,127,178,0.1); color: rgb(101,104,146);
  cursor: pointer; font-family: var(--font-sans);
  white-space: nowrap;
  display: flex; align-items: center;
}

/* 项目条层 */
.bars-layer { position: absolute; inset: 0; pointer-events: none; }
/* bars-layer is pointer-events:none so date-cell clicks work; individual bars opt back in */

.project-bar {
  position: absolute; height: 16px;
  border: 1px solid transparent;
  display: flex; align-items: center;
  padding: 0 6px; font-size: 10px; font-weight: 500;
  white-space: nowrap; overflow: hidden; box-sizing: border-box;
  pointer-events: auto; cursor: grab;
}
.project-bar.bar-dragging { opacity: 0.6; }
.project-bar.bar-start  { border-radius: 99px 0 0 99px; padding-left: 8px; }
.project-bar.bar-end    { border-radius: 0 99px 99px 0; }
.project-bar.bar-start.bar-end { border-radius: 99px; }

/* resize handles */
.bar-rh {
  position: absolute; top: 0; bottom: 0; width: 8px;
  cursor: ew-resize; display: flex; align-items: center; justify-content: center;
  opacity: 0; transition: opacity 0.15s; z-index: 1;
}
.bar-rh::after {
  content: ''; width: 2px; height: 8px; border-radius: 2px;
  background: currentColor; opacity: 0.7;
}
.bar-rh-left  { left: 0; }
.bar-rh-right { right: 0; }
.project-bar.bar-hovered .bar-rh { opacity: 1; }

.bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }

.bar-proj-tag {
  flex-shrink: 0;
  font-size: 8px; font-weight: 700; letter-spacing: 0.04em;
  background: rgba(255,255,255,0.5);
  border-radius: 3px; padding: 0 3px; line-height: 11px;
  margin-right: 2px;
}
.cal-done-mark {
  display: inline-flex; align-items: center;
  color: #3a8870; vertical-align: -2px; margin-left: 2px;
}
.bar-status-dot {
  width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; margin-right: 4px;
}
.bsd-pending { background: #d46b6b; }
.bsd-active  { background: #c9943a; }
.bsd-done    { background: #5a9e88; }
.chip-proj-tag {
  flex-shrink: 0;
  font-size: 8px; font-weight: 700; letter-spacing: 0.04em;
  background: rgba(255,255,255,0.55);
  border-radius: 3px; padding: 0 3px; line-height: 11px;
  margin-right: 4px;
}
.chip-ev-tag {
  background: rgba(210,175,40,0.28); color: #7a5c00;
}



/* 侧栏 */
.cal-sidebar { padding: 16px; display: flex; flex-direction: column; gap: 0; overflow-y: auto; min-height: 0; scrollbar-gutter: stable; }
.sidebar-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.sidebar-date-label { font-size: 13px; font-weight: 700; color: var(--text-primary); }
.add-event-btn { display: flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 8px; border: 1px solid rgba(123,127,178,0.3); background: rgba(123,127,178,0.08); font-size: 11px; font-weight: 600; cursor: pointer; color: var(--color-primary); font-family: var(--font-sans); transition: all 0.15s; }
.add-event-btn:hover { background: rgba(123,127,178,0.15); border-color: rgba(123,127,178,0.5); }
.add-proj-btn { background: linear-gradient(135deg,#7b7fb2,#9590c4); border-color: transparent; color: #fff; box-shadow: 0 3px 12px rgba(123,127,178,0.3); }
.add-proj-btn:hover { background: linear-gradient(135deg,#7b7fb2,#9590c4); border-color: transparent; opacity: 0.92; box-shadow: 0 6px 18px rgba(123,127,178,0.4); }
.sidebar-events { display: flex; flex-direction: column; gap: 7px; margin-bottom: 4px; }
.sidebar-ev { display: flex; gap: 9px; align-items: flex-start; background: rgba(255,255,255,0.66); border: 1px solid rgba(255,255,255,0.88); border-radius: 10px; padding: 8px 10px; transition: box-shadow 0.25s ease; }
.sidebar-ev:hover { box-shadow: inset 0 0 0 100px rgba(255,255,255,0.2), 0 3px 10px rgba(0,0,0,0.10); }
.sidebar-ev-body { flex: 1; min-width: 0; }
.ev-del-btn {
  background: rgba(176,120,88,0.08);
  border: 1px solid rgba(176,120,88,0.3);
  cursor: pointer; flex-shrink: 0;
  color: #b07858; padding: 4px;
  display: flex; align-items: center; align-self: center;
  border-radius: 6px; margin-left: auto;
  transition: background 0.15s, transform 0.15s;
}
.ev-del-btn:hover { background: rgba(176,120,88,0.15); border-color: rgba(176,120,88,0.5); transform: scale(1.1); }
.sidebar-ev-bar { width: 3px; border-radius: 99px; align-self: stretch; flex-shrink: 0; min-height: 26px; }
.sidebar-ev-name { font-size: 12px; font-weight: 500; color: var(--text-primary); line-height: 1.4; overflow-wrap: break-word; word-break: break-word; }
.sidebar-ev-time { font-size: 11px; font-weight: 600; color: var(--accent, #7b7fb2); margin-left: 7px; margin-right: 4px; font-variant-numeric: tabular-nums; }
.popup-row { display: flex; gap: 6px; align-items: center; }
.popup-row > :first-child { flex: 1; min-width: 0; }
.time-box { position: relative; display: flex; align-items: center; justify-content: center; gap: 4px; width: 100%; box-sizing: border-box; padding: 8px 11px; border-radius: 10px; border: 1px solid rgba(0,0,0,0.1); background: rgba(255,255,255,0.72); transition: border-color 0.15s, box-shadow 0.15s; }
.time-box:focus-within { border-color: rgba(123,127,178,0.55); box-shadow: 0 0 0 3px rgba(123,127,178,0.12); background: rgba(255,255,255,0.85); }
.time-inner { border: none; background: none; outline: none; font-size: 13px; font-family: 'PingFang SC','Segoe UI',sans-serif; color: #1e2028; padding: 0; width: 52px; text-align: center; font-variant-numeric: tabular-nums; }
.time-dash { color: #8a8fa8; font-size: 12px; font-weight: 600; }
.ev-type-badge {
  display: inline-block; vertical-align: middle; margin-left: 4px;
  font-size: 9px; font-weight: 700; letter-spacing: 0.04em;
  padding: 1px 5px; border-radius: 4px; line-height: 1.5;
  white-space: nowrap;
}
.ev-proj-badge {
  background: rgba(123,127,178,0.12); color: #7b7fb2;
  border: 1px solid rgba(123,127,178,0.2);
}
.ev-event-badge {
  background: rgba(210,175,40,0.15); color: #a07c00;
  border: 1px solid rgba(210,175,40,0.4);
}
.sidebar-ev-desc { font-size: 11px; color: var(--text-secondary); margin-top: 3px; line-height: 1.4; display: flex; align-items: flex-start; gap: 4px; }
.sidebar-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 18px 0; color: var(--text-secondary); font-size: 12px; opacity: 0.55; }
.sidebar-divider { height: 1px; background: rgba(0,0,0,0.06); margin: 14px 0; }
.sidebar-section-title { font-size: 10px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 10px; }
.upcoming-item { display: flex; align-items: center; margin-bottom: 7px; }
.upcoming-item:last-child { margin-bottom: 0; }
</style>

<style>
.overflow-popup {
  background: var(--panel-bg);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.82);
  border-radius: 14px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 8px 28px rgba(30,40,80,0.14);
  padding: 12px 14px;
  display: flex; flex-direction: column; gap: 8px;
}
.overflow-popup-title { font-size: 12px; font-weight: 700; color: var(--text-secondary); line-height: 1; padding-bottom: 2px; margin-bottom: -2px; }
.overflow-list { display: flex; flex-direction: column; gap: 4px; }
.overflow-item {
  display: flex; align-items: center; gap: 4px;
  height: 22px; padding: 0 8px; border-radius: 99px;
  border: 1px solid transparent; font-size: 10px; font-weight: 500;
  white-space: nowrap; overflow: hidden;
}
.overflow-item:not(.overflow-clickable) { pointer-events: none; }
.overflow-tag {
  font-size: 8px; font-weight: 700; letter-spacing: 0.04em;
  background: rgba(255,255,255,0.5);
  border-radius: 3px; padding: 0 3px; line-height: 11px;
  flex-shrink: 0; margin-right: 2px;
}
.overflow-tag-ev { background: rgba(210,175,40,0.35); color: #7a5c00; }
.overflow-name { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }

.cal-month-picker {
  background: var(--panel-bg);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.82);
  border-radius: 16px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 10px 36px rgba(30,40,80,0.14);
  padding: 14px;
}
.picker-year-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.picker-year { font-size: 13px; font-weight: 700; color: #1e2028; }
.picker-nav { width: 26px; height: 26px; border-radius: 7px; border: none; background: none; cursor: pointer; display: flex; align-items: center; justify-content: center; color: #8a8fa8; transition: background 0.12s; }
.picker-nav:hover { background: rgba(0,0,0,0.07); }
.picker-months { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
.picker-month { padding: 6px 0; border-radius: 8px; border: none; font-size: 12px; font-weight: 500; font-family: 'PingFang SC','Segoe UI',sans-serif; cursor: pointer; background: none; color: #1e2028; transition: all 0.12s; }
.picker-month:hover { background: rgba(123,127,178,0.14); }
.picker-month.active { background: linear-gradient(135deg,#7b7fb2,#9590c4); color: white; font-weight: 700; box-shadow: 0 2px 6px rgba(123,127,178,0.3); }

.picker-enter-active { transition: opacity 0.16s, transform 0.18s cubic-bezier(0.34,1.2,0.64,1); }
.picker-leave-active { transition: opacity 0.12s, transform 0.12s ease-in; }
.picker-enter-from,.picker-leave-to { opacity: 0; transform: scaleY(0.9) translateY(-6px); transform-origin: top; }

/* 更多弹窗：transform-origin 由内联 style 控制，动画只改 opacity + scale */
.more-pop-enter-active { transition: opacity 0.16s, transform 0.18s cubic-bezier(0.34,1.2,0.64,1); }
.more-pop-leave-active { transition: opacity 0.12s, transform 0.12s ease-in; }
.more-pop-enter-from,.more-pop-leave-to { opacity: 0; transform: scaleY(0.88); }

.add-event-popup { background: rgba(255,255,255,0.6); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); border: 1px solid rgba(255,255,255,0.75); border-radius: 16px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 8px 32px rgba(60,70,100,0.12); padding: 16px; display: flex; flex-direction: column; gap: 9px; max-height: calc(100vh - 24px); overflow-y: auto; overscroll-behavior: contain; }
.popup-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
.popup-title { font-size: 13px; font-weight: 700; color: #1e2028; }
.popup-input { width: 100%; padding: 7px 10px; border-radius: 9px; border: 1px solid rgba(255,255,255,0.75); background: rgba(255,255,255,0.68); font-size: 12px; font-family: 'PingFang SC', 'Segoe UI', sans-serif; color: #1e2028; outline: none; box-sizing: border-box; transition: border-color 0.15s, box-shadow 0.15s; }
.popup-input:focus { border-color: rgba(123,127,178,0.55); box-shadow: 0 0 0 3px rgba(123,127,178,0.12); background: rgba(255,255,255,0.85); }
.popup-textarea { width: 100%; padding: 7px 10px; border-radius: 9px; border: 1px solid rgba(255,255,255,0.75); background: rgba(255,255,255,0.68); font-size: 12px; font-family: 'PingFang SC', 'Segoe UI', sans-serif; color: #1e2028; outline: none; box-sizing: border-box; transition: border-color 0.15s, box-shadow 0.15s; resize: none; line-height: 1.5; }
.popup-textarea:focus { border-color: rgba(123,127,178,0.55); box-shadow: 0 0 0 3px rgba(123,127,178,0.12); background: rgba(255,255,255,0.85); }
.popup-actions { display: flex; gap: 6px; justify-content: flex-end; align-items: center; margin-top: 2px; }
.popup-delete { padding: 5px 12px; border-radius: 8px; border: 1px solid rgba(176,120,88,0.3); background: rgba(176,120,88,0.08); font-size: 12px; cursor: pointer; color: #b07858; font-family: 'PingFang SC', 'Segoe UI', sans-serif; font-weight: 600; transition: background 0.12s, border-color 0.12s; }
.popup-delete:hover { background: rgba(176,120,88,0.15); border-color: rgba(176,120,88,0.5); }
.popup-save { padding: 5px 14px; border-radius: 8px; border: none; background: linear-gradient(135deg,#7b7fb2,#9590c4); color: white; font-size: 12px; font-weight: 600; cursor: pointer; font-family: 'PingFang SC', 'Segoe UI', sans-serif; transition: opacity 0.15s; box-shadow: 0 2px 8px rgba(123,127,178,0.28); }
.popup-save:disabled { opacity: 0.38; cursor: default; }
.popup-save:not(:disabled):hover { opacity: 0.88; }
.reminder-section { display: flex; flex-direction: column; gap: 6px; padding-top: 7px; border-top: 1px solid rgba(123,127,178,0.18); }
.reminder-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.reminder-label { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; color: #8a8fa8; }
.reminder-item { display: flex; align-items: center; gap: 6px; }
.reminder-lead { font-size: 11px; font-weight: 600; color: #65688f; }
.reminder-test-bar { width: 100%; box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: 5px; margin-top: 7px; padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(123,127,178,0.4); background: rgba(123,127,178,0.08); color: #65688f; font-size: 11px; font-weight: 600; cursor: pointer; font-family: 'PingFang SC','Segoe UI',sans-serif; transition: all 0.12s; }
.reminder-test-bar:hover { border-color: rgba(123,127,178,0.7); background: rgba(123,127,178,0.16); color: #54577a; }
.reminder-del { display: flex; align-items: center; padding: 2px; border: none; background: none; cursor: pointer; color: #b07858; border-radius: 5px; }
.reminder-del:hover { background: rgba(176,120,88,0.12); }
.reminder-add { display: flex; gap: 6px; align-items: center; }
.lead-select { flex: 1; height: 28px; padding: 0 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.75); background: rgba(255,255,255,0.68); font-size: 11px; font-family: 'PingFang SC','Segoe UI',sans-serif; color: #1e2028; cursor: pointer; outline: none; }
.reminder-add-btn { flex-shrink: 0; padding: 5px 10px; border-radius: 8px; border: 1px solid rgba(123,127,178,0.3); background: rgba(123,127,178,0.1); color: #65688f; font-size: 11px; font-weight: 600; cursor: pointer; font-family: 'PingFang SC','Segoe UI',sans-serif; transition: background 0.12s; }
.reminder-add-btn:hover { background: rgba(123,127,178,0.2); }
.reminder-cancel { flex-shrink: 0; display: flex; align-items: center; padding: 4px; border: none; background: none; cursor: pointer; color: #8a8fa8; border-radius: 6px; }
.reminder-cancel:hover { background: rgba(0,0,0,0.06); }
.reminder-add-toggle { width: 100%; box-sizing: border-box; text-align: center; padding: 6px 10px; border-radius: 8px; border: 1px dashed rgba(123,127,178,0.4); background: none; color: #8a8fa8; font-size: 11px; font-weight: 600; cursor: pointer; font-family: 'PingFang SC','Segoe UI',sans-serif; transition: all 0.12s; }
.reminder-add-toggle:hover { border-color: rgba(123,127,178,0.7); color: #65688f; background: rgba(123,127,178,0.06); }
/* 绝对定位浮在右侧，不参与 flex 居中，保证「开始—结束」时间仍水平居中 */
.nextday-tag { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 10px; font-weight: 600; color: #9590c4; background: rgba(123,127,178,0.1); padding: 1px 6px; border-radius: 5px; white-space: nowrap; pointer-events: none; }
.nextday-mini { margin-left: 4px; font-size: 9px; font-weight: 600; color: #a8a3c8; padding: 1px 4px; border-radius: 4px; background: rgba(123,127,178,0.1); vertical-align: 1px; }
.chan-block { display: flex; flex-direction: column; gap: 5px; }
.chan-chips { display: flex; gap: 5px; flex-wrap: wrap; }
.chan-chip { padding: 3px 11px; border-radius: 99px; border: 1px solid rgba(123,127,178,0.3); background: rgba(255,255,255,0.5); color: #8a8fa8; font-size: 11px; font-weight: 600; cursor: pointer; font-family: 'PingFang SC','Segoe UI',sans-serif; transition: all 0.12s; }
.chan-chip.on { background: rgba(123,127,178,0.16); border-color: rgba(123,127,178,0.55); color: #5b5f8c; }
.form-pop-enter-active { transition: opacity 0.16s, transform 0.18s cubic-bezier(0.34,1.2,0.64,1); }
.form-pop-leave-active { transition: opacity 0.12s, transform 0.12s ease-in; }
.form-pop-enter-from, .form-pop-leave-to { opacity: 0; transform: scale(0.95) translateY(-6px); }

/* 搜索跳转高亮 */
.search-flash { animation: search-flash 1.8s ease forwards; border-radius: 10px; }
@keyframes search-flash {
  0%   { background: rgba(123,127,178,0.22); }
  35%  { background: rgba(123,127,178,0.22); }
  100% { background: transparent; }
}
/* ───────── 周视图（时间轴）───────── */
.toolbar-right { display: flex; align-items: center; gap: 8px; }
.view-toggle { display: inline-flex; gap: 2px; padding: 2px; border-radius: 9px; background: rgba(123,127,178,0.1); }
.view-toggle button { border: none; background: none; padding: 4px 12px; border-radius: 7px; font-size: 12px; font-weight: 600; color: #8a8fa8; cursor: pointer; font-family: 'PingFang SC','Segoe UI',sans-serif; transition: all 0.15s; }
.view-toggle button.on { background: #fff; color: #5a5e86; box-shadow: 0 1px 4px rgba(60,70,100,0.12); }

.week-view { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.wv-gutter { width: 46px; flex: none; }
.wv-head { display: flex; border-bottom: 1px solid rgba(123,127,178,0.18); padding-bottom: 4px; }
.wv-dhead { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 3px 0; cursor: pointer; border-radius: 8px; transition: background 0.12s; }
.wv-dhead:hover { background: rgba(123,127,178,0.07); }
.wv-dhead.weekend .wv-dow { color: #b06a78; }
.wv-dow { font-size: 11px; font-weight: 600; color: #8a8fa8; }
.wv-dnum { width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 15px; font-weight: 600; color: #3a3d52; line-height: 1; }
.wv-dnum.today { background: linear-gradient(135deg,#7b7fb2,#9590c4); color: #fff; }
.wv-dhead.weekend .wv-dnum.today { background: linear-gradient(135deg,#b85c5c,#c97070); }
/* 选中日：整格暗色被选中（取代数字外的浅色球）；周末同步暖红 */
.wv-dhead.selected { background: rgba(123,127,178,0.16); }
.wv-dhead.selected.weekend { background: rgba(195,90,90,0.14); }
.wv-dhead.selected .wv-dnum:not(.today) { color: var(--color-primary); }
.wv-dhead.selected.weekend .wv-dnum:not(.today) { color: rgba(195,90,90,0.95); }

.wv-allday { display: flex; align-items: stretch; border-bottom: 1px solid rgba(123,127,178,0.18); }
.wv-allday-tag { display: flex; align-items: flex-start; justify-content: flex-end; padding: 4px 6px 0 0; font-size: 10px; color: #a8acc4; }
.wv-allday-grid { position: relative; flex: 1; min-height: 26px; overflow: hidden; }
.wv-aco { position: absolute; top: 0; bottom: 0; width: 14.2857%; box-sizing: border-box; border-left: 1px solid rgba(123,127,178,0.1); pointer-events: none; }
.wv-aco.today { background: rgba(123,127,178,0.06); }
.wv-aco.weekend { background: rgba(195,90,90,0.028); }
/* 全天区多日框选高亮（DOM 在列底之后、chip 之前 → 盖列底、垫 chip 下）；色同月视图 in-range */
.wv-ad-sel { position: absolute; top: 0; bottom: 0; width: 14.2857%; background: rgba(123,127,178,0.08); pointer-events: none; }
.wv-ad-sel.weekend { background: rgba(195,90,90,0.07); }
.wv-pbar, .wv-allday-ev { position: absolute; height: 18px; box-sizing: border-box; display: flex; align-items: center; gap: 3px; padding: 0 6px; border: 1px solid; border-radius: 5px; font-size: 11px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; z-index: 1; }
.wv-allday-ev { width: 14.2857%; margin-left: 1px; padding-right: 8px; }
.wv-pbar { margin: 0 1px; }
/* 周视图全天行的「更多」：视觉完全复用月视图 .chip-more-btn，这里只加绝对定位 + 列宽 */
.wv-more { position: absolute; width: 14.2857%; box-sizing: border-box; margin: 0 1px; overflow: hidden; z-index: 1; }
.wv-more:hover { background: rgba(123,127,178,0.22); }

.wv-body { flex: 1; overflow-y: auto; min-height: 0; scrollbar-gutter: stable; }
.wv-grid { display: flex; position: relative; }
.wv-hours { width: 46px; flex: none; }
.wv-hour { position: relative; }
.wv-hour span { position: absolute; top: -7px; right: 6px; font-size: 10px; color: #a8acc4; font-variant-numeric: tabular-nums; }
.wv-col { flex: 1; position: relative; border-left: 1px solid rgba(123,127,178,0.1); background-image: linear-gradient(to bottom, rgba(123,127,178,0.13) 1px, transparent 1px); background-repeat: repeat-y; cursor: pointer; }
.wv-col.today { background-color: rgba(123,127,178,0.045); }
.wv-col.weekend { background-color: rgba(195,90,90,0.028); }
/* 悬停/周末——与月视图 .month-cell 同一套调色（冷紫；周末转 195,90,90 暖红）。
   选中不落在小时格上，而是落在日期数字上（同月视图选中日）*/
/* 悬停带提到活动块之上（z-index>事件的 3），否则活动占据/下方的小时格悬停被活动遮住；pointer-events:none 不挡点击 */
.wv-hover { position: absolute; left: 0; right: 0; background: rgba(123,127,178,0.06); pointer-events: none; z-index: 5; transition: none; }
.wv-col.weekend .wv-hover { background: rgba(195,90,90,0.07); }
/* 选中/拖拽选区：直接纯色变暗，无边框、无过渡动画（点击那一下不闪）*/
.wv-selected, .wv-selbox { position: absolute; left: 0; right: 0; background: rgba(123,127,178,0.1); pointer-events: none; z-index: 1; transition: none; }
.wv-col.weekend .wv-selected, .wv-col.weekend .wv-selbox { background: rgba(195,90,90,0.1); }
.wv-now { position: absolute; left: 0; right: 0; height: 0; border-top: 2px solid #e5484d; z-index: 6; pointer-events: none; }
.wv-now::before { content: ''; position: absolute; left: -3px; top: -4px; width: 7px; height: 7px; border-radius: 50%; background: #e5484d; }
.wv-ev { position: absolute; box-sizing: border-box; border: 1px solid; border-radius: 6px; padding: 1px 5px; overflow: hidden; cursor: pointer; display: flex; flex-direction: column; line-height: 1.25; z-index: 3; transition: box-shadow 0.25s ease; }
/* hover 高光：整块白光叠层「均匀淡入」（不走 .cal-chip 的 inset 阴影外→内扫光），观感同项目胶囊 */
.wv-ev::before { content: ''; position: absolute; inset: 0; border-radius: inherit; background: rgba(255,255,255,0.45); opacity: 0; transition: opacity 0.2s ease; pointer-events: none; }
.wv-ev:hover::before { opacity: 1; }
.wv-ev.cal-chip:hover { box-shadow: 0 2px 8px rgba(80,90,110,0.16); z-index: 5; }
.wv-ev-t, .wv-ev-n, .wv-ev-d { position: relative; z-index: 1; }   /* 文字盖在白光层之上，保持清晰 */
.wv-ev-d { font-size: 10px; font-weight: 400; opacity: 0.78; line-height: 1.3; margin-top: 1px; overflow: hidden; min-height: 0; flex: 1; word-break: break-word; }
.wv-ev { cursor: grab; }   /* 中间=grab、上下 7px 边缘=ns-resize，由 onEvHover 动态切换 */
.wv-ev:active { cursor: grabbing; }
.wv-ev-t { font-size: 9.5px; font-weight: 600; opacity: 0.85; white-space: nowrap; }
.wv-ev-n { font-size: 11px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.cal-toast {
  position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%);
  background: rgba(30,32,40,0.92); backdrop-filter: blur(16px);
  border: 1px solid rgba(255,255,255,0.12); border-radius: 12px;
  padding: 11px 20px; font-size: 13px; line-height: 1.5; color: rgba(255,255,255,0.85);
  box-shadow: 0 8px 24px rgba(0,0,0,0.3);
  pointer-events: none; white-space: pre-line; max-width: 360px; z-index: 99999;
  font-family: 'PingFang SC','Segoe UI',sans-serif;
}
.cal-toast-enter-active, .cal-toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.cal-toast-enter-from { opacity: 0; transform: translateX(-50%) translateY(8px); }
.cal-toast-leave-to   { opacity: 0; transform: translateX(-50%) translateY(8px); }
</style>
