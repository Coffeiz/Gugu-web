import { definePostgresMigration } from '../runner.js'

export const calendarReminderMode = definePostgresMigration({
  revision: '0023_calendar_reminder_mode',
  prerequisites: ['scheduled_tasks', 'calendar_events'],
  tables: [],
  sql: `
UPDATE scheduled_tasks AS task
SET execution_mode='reminder',
    payload='提醒：' || event.title || '（' || event.date || COALESCE(' ' || NULLIF(event.time, ''), '') || '）'
FROM calendar_events AS event
WHERE task.event_id=event.id AND task.user_id=event.user_id AND task.execution_mode='instruction';
`,
})
