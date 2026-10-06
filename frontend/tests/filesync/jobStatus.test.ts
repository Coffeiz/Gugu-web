import { describe, expect, it } from 'vitest'
import {
  filesyncCycleDecisionKey,
  filesyncPauseReasonKey,
  filesyncRunReasonKey,
  filesyncRunStageKey,
  filesyncRunStatusKey,
} from '@/utils/filesyncJobStatus'

describe('filesync job status presentation', () => {
  it('shows activity skip as a distinct non-error outcome', () => {
    expect(filesyncRunStatusKey({ status: 'cancelled', errorCode: 'skipped_file_active' }))
      .toBe('filesyncAdmin.skippedFileActivity')
    expect(filesyncCycleDecisionKey('skipped_file_active'))
      .toBe('filesyncAdmin.skippedFileActivity')
  })

  it('leaves real failure and other cycle decisions to their existing status labels', () => {
    expect(filesyncRunStatusKey({ status: 'failed', errorCode: 'reconcile_failed' }))
      .toBe('filesyncAdmin.statusFailed')
    expect(filesyncCycleDecisionKey('scan')).toBe('filesyncAdmin.cycleScan')
  })

  it('localizes queue states, stages, reasons, and pauses without hiding unknown values', () => {
    expect(filesyncRunReasonKey('file_event')).toBe('filesyncAdmin.reasonFileEvent')
    expect(filesyncRunStatusKey({ status: 'paused', errorCode: null }))
      .toBe('filesyncAdmin.statusPaused')
    expect(filesyncRunStageKey('scanning')).toBe('filesyncAdmin.stageScanning')
    expect(filesyncPauseReasonKey('execution_budget'))
      .toBe('filesyncAdmin.pauseExecutionBudget')
    expect(filesyncRunReasonKey('future_reason')).toBeNull()
    expect(filesyncRunStageKey('future_stage')).toBeNull()
    expect(filesyncPauseReasonKey('future_pause')).toBeNull()
  })
})
