import { z } from 'zod'

export const QUESTION_BATCH_SUBMIT = '__submit_questions__'
export const QUESTION_BATCH_CANCEL = '__cancel_questions__'

const id = z.string().trim().min(1).max(64)
const option = z.object({ id, label: z.string().trim().min(1).max(120) }).strict()
export const askQuestionBatchSchema = (serial = false) => z.array(z.object({
  id, title: z.string().trim().min(1).max(120), body: z.string().trim().max(1000).optional(),
  options: z.array(option).max(8).optional(),
  ...(serial ? {} : { selection_mode: z.enum(['single', 'multiple']).optional() }),
}).strict().refine(question => new Set(question.options?.map(item => item.id)).size === (question.options?.length ?? 0)
  && (question.selection_mode !== 'multiple' || Boolean(question.options?.length))))
  .min(2).max(5).refine(questions => new Set(questions.map(question => question.id)).size === questions.length)

export type AskQuestion = z.infer<ReturnType<typeof askQuestionBatchSchema>>[number]
const answerSchema = z.object({ question_id: id, option_ids: z.array(id).max(8).optional(),
  text: z.string().trim().min(1).max(2000).optional() }).strict()
export type AskQuestionAnswer = z.infer<typeof answerSchema>

export function readQuestionBatch(schema: Record<string, unknown>) {
  const result = askQuestionBatchSchema().safeParse(schema.questions)
  return result.success ? result.data : null
}

export function validateQuestionAnswers(questions: AskQuestion[], value: unknown) {
  const parsed = z.array(answerSchema).length(questions.length).safeParse(value)
  if (!parsed.success) return null
  const answers = questions.map(question => parsed.data.find(answer => answer.question_id === question.id))
  for (const [index, question] of questions.entries()) {
    const answer = answers[index]
    if (!answer || Boolean(answer.option_ids?.length) === Boolean(answer.text)) return null
    const ids = answer.option_ids ?? []
    if ((question.selection_mode !== 'multiple' && ids.length > 1) || new Set(ids).size !== ids.length
      || ids.some(id => !question.options?.some(option => option.id === id))) return null
  }
  return answers as AskQuestionAnswer[]
}

export function questionBatchText(questions: AskQuestion[], index: number) {
  const question = questions[index]
  if (!question) return ''
  const choices = question.options?.map((option, i) => `${i + 1}. ${option.label}`).join('\n')
  return [`第 ${index + 1} / ${questions.length} 题 · ${question.title}`, question.body, choices,
    choices ? '请回复选项序号、选项文字或输入自定义答案。' : '请直接回复你的答案。',
    '回复「取消问答」可结束本组问题。'].filter(Boolean).join('\n')
}

export function questionStepOptionId(questionIndex: number, optionIndex: number) {
  return `__question_${questionIndex}_${optionIndex}__`
}

export function advanceQuestionBatch(schema: Record<string, unknown>, questions: AskQuestion[],
  answer: AskQuestionAnswer, eventId: string | undefined, at: Date) {
  const prior = Array.isArray(schema.question_progress) ? schema.question_progress as AskQuestionAnswer[] : []
  const answers = [...prior, answer]
  const events = Array.isArray(schema.question_events) ? schema.question_events : []
  return { answers, complete: answers.length === questions.length,
    schema: { ...schema, question_progress: answers,
      question_events: eventId ? [...events, eventId] : events, question_advanced_at: at.toISOString() } }
}
