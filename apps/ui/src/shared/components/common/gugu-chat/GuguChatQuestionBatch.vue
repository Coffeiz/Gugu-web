<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from '@/components/common/icons/Icon.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import MarkdownView from '@/components/common/content/MarkdownView.vue'
import type { ChatQuestion } from './chatTypes'

const props = defineProps<{ questions: ChatQuestion[]; disabled: boolean }>()
const emit = defineEmits<{ submit: [answers: string]; cancel: [] }>()
const step = ref(0)
const drafts = ref(props.questions.map(() => ({ ids: [] as string[], text: '' })))
const question = computed(() => props.questions[step.value]!)
const draft = computed(() => drafts.value[step.value]!)
const complete = (answer: { ids: string[]; text: string }) => Boolean(answer.ids.length || answer.text.trim())
const last = computed(() => step.value === props.questions.length - 1)

function toggle(id: string) {
  const current = draft.value
  const selected = current.ids.includes(id)
  current.ids = selected ? current.ids.filter(value => value !== id)
    : question.value.selection_mode === 'multiple' ? [...current.ids, id] : [id]
  current.text = ''
}

function advance() {
  if (!complete(draft.value) || props.disabled) return
  if (!last.value) {
    step.value++
    return
  }
  if (!drafts.value.every(complete)) return
  emit('submit', JSON.stringify(props.questions.map((item, index) => {
    const answer = drafts.value[index]!
    return { question_id: item.id, ...(answer.ids.length ? { option_ids: answer.ids } : { text: answer.text.trim() }) }
  })))
}
</script>

<template>
  <form class="question-batch is-choice" :class="{ 'is-multiple-choice': question.selection_mode === 'multiple' }" @submit.prevent="advance">
    <div class="question-progress" role="status" :aria-label="$t('pageUi.questionProgress', { current: step + 1, total: questions.length })"
      :style="{ '--question-progress': (step + 1) / questions.length * 100 + '%' }">
      <span aria-hidden="true">{{ step + 1 }}/{{ questions.length }}</span>
    </div>
    <div class="question-title">{{ question.title }}</div>
    <MarkdownView v-if="question.body" class="question-body" :text="question.body" />
    <div v-if="question.options?.length" class="interaction-actions" role="group" :aria-label="question.title">
      <ActionButton v-for="option in question.options" :key="option.id" class="interaction-option"
        :class="{ 'is-selected': draft.ids.includes(option.id) }" type="button" fit variant="secondary"
        :disabled="disabled" :aria-pressed="draft.ids.includes(option.id)" @click="toggle(option.id)">
        <span class="interaction-choice-marker" aria-hidden="true">
          <Icon v-if="draft.ids.includes(option.id)" name="status.success" :size="13" />
        </span>
        <span class="interaction-choice-label">{{ option.label }}</span>
        <Icon v-if="question.selection_mode !== 'multiple'" class="interaction-choice-arrow"
          name="action.chevron-next" :size="15" aria-hidden="true" />
      </ActionButton>
    </div>
    <textarea v-model="draft.text" class="form-input control-resizable" rows="2" maxlength="2000" :disabled="disabled"
      :aria-label="$t('pageUi.textAnswer', { title: question.title })" :placeholder="question.options?.length ? $t('pageUi.customAnswer') : $t('pageUi.enterAnswer')"
      @input="draft.ids = []" />
    <div class="question-controls">
      <ActionButton type="button" fit variant="secondary" :disabled="disabled" @click="emit('cancel')">{{ $t('pageUi.cancelQuestions') }}</ActionButton>
      <ActionButton v-if="step > 0" type="button" fit variant="secondary" :disabled="disabled" @click="step--">{{ $t('pageUi.previousQuestion') }}</ActionButton>
      <ActionButton type="submit" fit :disabled="disabled || !complete(draft)">{{ last ? $t('pageUi.submitAnswers') : $t('pageUi.nextQuestion') }}</ActionButton>
    </div>
  </form>
</template>

<style scoped>
.question-batch { display: grid; gap: var(--space-sm); }
.question-body { min-width: 0; color: var(--content-secondary); overflow-wrap: anywhere; }
.question-body :deep(:first-child) { margin-block-start: 0; }
.question-body :deep(:last-child) { margin-block-end: 0; }
.question-progress {
  position: absolute;
  inset-block-start: 15px;
  inset-inline-end: 15px;
  display: grid;
  place-items: center;
  inline-size: 32px;
  block-size: 32px;
  border-radius: 50%;
  background: conic-gradient(var(--action-primary) var(--question-progress), var(--content-divider) 0);
  color: var(--content-secondary);
  font-size: var(--font-size-xs);
}
.question-progress span {
  display: grid;
  place-items: center;
  inline-size: 28px;
  block-size: 28px;
  border-radius: 50%;
  background: var(--surface-card-solid);
}
.question-title { font-weight: var(--font-weight-semibold); }
.question-controls { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
.question-controls { justify-content: flex-end; }

</style>

<style scoped src="./interaction-choice.css"></style>
