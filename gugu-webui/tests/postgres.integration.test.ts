import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresRuntime, type SqlDataRuntime } from '@gugu/core/data'
import { createApp } from '../src/app.js'
import { createClientOperations } from '../src/clients.js'
import { createEventOperations } from '../src/events.js'
import { createNotificationOperations } from '../src/notifications.js'
import { createProjectFileCountListing, createProjectGetter, createProjectListing } from '../src/projects.js'
import { signedUserToken } from './helpers/auth.js'
import { createUserRepository } from '../src/users.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const secret = 'synthetic-postgres-integration-secret'

test('Node auth, project, client, calendar, and notification routes preserve PostgreSQL contracts', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const schema = `gugu_webui_test_${randomUUID().replaceAll('-', '')}`
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 })
  await adminPool.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  let core: SqlDataRuntime | undefined
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: { secret, ...createUserRepository(pool) },
    listProjects: async () => [],
  })

  try {
    const namespace = await pool.query<{ schema: string }>('SELECT current_schema() AS schema')
    assert.equal(namespace.rows[0]?.schema, schema)
    await pool.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        username varchar(100) NOT NULL,
        display_name varchar(100),
        email varchar(300) NOT NULL,
        is_active boolean NOT NULL,
        account_status varchar(16),
        security_version integer,
        avatar varchar(500),
        created_at timestamptz,
        timezone varchar(64),
        email_subscribed boolean,
        last_active_at timestamptz
      )
    `)
    await pool.query(`
      CREATE TABLE user_bots (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id),
        platform varchar(20) NOT NULL,
        enabled boolean NOT NULL
      )
    `)
    await pool.query(`
      CREATE TABLE projects (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL,
        name varchar(200) NOT NULL,
        summary varchar(200),
        contact_name varchar(200),
        status varchar(20) NOT NULL,
        start_date varchar(10),
        deadline varchar(10),
        color varchar(300) NOT NULL,
        progress integer NOT NULL,
        stages_json text NOT NULL,
        current_stage varchar(100),
        priority varchar(20),
        version integer NOT NULL,
        archived boolean NOT NULL,
        done_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        deleted_at timestamptz,
        idempotency_key varchar(64),
        idempotency_fingerprint varchar(64)
      )
    `)
    await pool.query(`
      CREATE TABLE project_file_counts (
        project_id integer PRIMARY KEY,
        file_count bigint NOT NULL CHECK (file_count > 0)
      )
    `)
    await pool.query(`
      CREATE TABLE calendar_events (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL,
        title varchar(300) NOT NULL,
        date varchar(10) NOT NULL,
        time varchar(5),
        end_time varchar(5),
        type varchar(50) NOT NULL,
        contact_name varchar(200),
        project_id integer,
        description text,
        version integer NOT NULL,
        created_at timestamptz NOT NULL,
        deleted_at timestamptz,
        idempotency_key varchar(64),
        idempotency_fingerprint varchar(64)
      )
    `)
    await pool.query(`
      CREATE TABLE clients (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL,
        name varchar(200) NOT NULL,
        contact varchar(200),
        email varchar(300),
        phone varchar(50),
        notes text NOT NULL,
        created_at timestamptz NOT NULL
      )
    `)
    await pool.query(`
      CREATE TABLE site_notifications (
        id serial PRIMARY KEY,
        title varchar(200) NOT NULL,
        content text NOT NULL,
        color varchar(50) NOT NULL,
        target varchar(50) NOT NULL,
        bubble boolean NOT NULL DEFAULT true,
        persist boolean NOT NULL DEFAULT true,
        bubble_expire_at timestamptz,
        created_by varchar(100) NOT NULL DEFAULT 'admin',
        created_at timestamptz NOT NULL
      )
    `)
    await pool.query(`
      CREATE TABLE notification_reads (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        notification_id integer NOT NULL REFERENCES site_notifications(id) ON DELETE CASCADE,
        read_at timestamptz NOT NULL,
        UNIQUE (user_id, notification_id)
      )
    `)
    await pool.query(`
      CREATE TABLE notification_dismissals (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        notification_id integer NOT NULL REFERENCES site_notifications(id) ON DELETE CASCADE,
        dismissed_at timestamptz NOT NULL,
        UNIQUE (user_id, notification_id)
      )
    `)
    const userId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
    await pool.query(
      `INSERT INTO users
        (id, username, display_name, email, is_active, account_status, security_version,
         created_at, timezone, email_subscribed)
       VALUES ($1, $2, $3, $4, TRUE, 'active', 4, $5, $6, FALSE)`,
      [userId, 'integration-user', '合成集成用户', 'integration@example.test', '2026-11-02T00:00:00.123456Z', 'Asia/Shanghai'],
    )
    await pool.query(
      'INSERT INTO user_bots (user_id, platform, enabled) VALUES ($1, $2, TRUE)',
      [userId, 'qq'],
    )

    const otherUserId = 'ad0902a0-c899-44ee-b180-d54eb04e4604'
    await pool.query(
      `INSERT INTO users
        (id, username, display_name, email, is_active, account_status, security_version,
         created_at, timezone, email_subscribed)
       VALUES ($1, $2, NULL, $3, TRUE, 'active', 4, $4, NULL, FALSE)`,
      [otherUserId, 'other-integration-user', 'other@example.test', '2026-11-02T00:00:00Z'],
    )
    const insertProject = async (owner: string, name: string, archived: boolean) => {
      const result = await pool.query<{ id: number }>(
        `INSERT INTO projects
          (user_id, name, summary, contact_name, status, start_date, deadline, color,
           progress, stages_json, current_stage, priority, version, archived, done_at,
           created_at, updated_at, deleted_at, idempotency_key, idempotency_fingerprint)
         VALUES ($1, $2, NULL, NULL, 'pending', NULL, NULL, '#000000', 0, '[]', NULL,
                 NULL, 1, $3, NULL, '2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z',
                 NULL, NULL, NULL)
         RETURNING id`,
        [owner, name, archived],
      )
      return result.rows[0]!.id
    }
    const activeProjectId = await insertProject(userId, 'Active owned project', false)
    const archivedProjectId = await insertProject(userId, 'Archived owned project', true)
    const otherProjectId = await insertProject(otherUserId, 'Other owner project', false)
    await pool.query(
      'INSERT INTO project_file_counts (project_id, file_count) VALUES ($1, 2), ($2, 99)',
      [activeProjectId, otherProjectId],
    )

    const insertNotification = async (
      title: string,
      target: string,
      createdAt: string,
      options: { bubble?: boolean; persist?: boolean; expiresAt?: string | null } = {},
    ) => {
      const result = await pool.query<{ id: number }>(
        `INSERT INTO site_notifications
           (title, content, color, target, bubble, persist, bubble_expire_at, created_at)
         VALUES ($1, $2, '#789abc', $3, $4, $5, $6, $7)
         RETURNING id`,
        [title, `content:${title}`, target, options.bubble ?? true, options.persist ?? true,
          options.expiresAt ?? null, createdAt],
      )
      return result.rows[0]!.id
    }
    const registrationBoundaryId = await insertNotification(
      'At registration timestamp', 'all', '2026-11-02T00:00:00.123456Z',
    )
    const beforeRegistrationBoundaryId = await insertNotification(
      'One microsecond before registration', 'all', '2026-11-02T00:00:00.123455Z',
    )
    const preRegistrationId = await insertNotification('Before registration', 'all', '2026-11-01T08:00:00Z')
    const sharedId = await insertNotification('Shared notice', 'all', '2026-11-04T08:00:00Z')
    const targetedId = await insertNotification('Targeted notice', userId, '2026-11-05T08:00:00Z')
    const otherTargetId = await insertNotification('Other target', otherUserId, '2026-11-06T08:00:00Z')
    const transientId = await insertNotification('Transient bubble', 'all', '2026-11-07T08:00:00Z', { persist: false })
    const expiredId = await insertNotification('Expired bubble', 'all', '2026-11-08T08:00:00Z', {
      expiresAt: '2026-11-10T00:00:00Z',
    })
    const dismissedId = await insertNotification('Hidden notice', 'all', '2026-11-09T08:00:00Z')
    const recentBubbleId = await insertNotification('Recent bubble', 'all', '2026-11-10T08:00:00Z', {
      expiresAt: '2026-11-15T00:00:00Z',
    })
    await pool.query(
      'INSERT INTO notification_reads (user_id, notification_id, read_at) VALUES ($1, $2, $3)',
      [userId, targetedId, '2026-11-11T00:00:00Z'],
    )
    await pool.query(
      'INSERT INTO notification_dismissals (user_id, notification_id, dismissed_at) VALUES ($1, $2, $3)',
      [userId, dismissedId, '2026-11-11T00:00:00Z'],
    )
    const notificationsApp = createApp({
      appName: 'Gugu',
      isReady: async () => true,
      userAuth: { secret, ...createUserRepository(pool) },
      notifications: createNotificationOperations(pool),
    })
    try {
      const headers = { authorization: `Bearer ${signedUserToken(secret, userId, 4)}` }
      const list = await notificationsApp.inject({
        method: 'GET', url: '/api/v1/notifications?limit=2', headers,
      })
      assert.equal(list.statusCode, 200, list.body)
      assert.deepEqual(list.json(), [
        {
          id: recentBubbleId, title: 'Recent bubble', content: 'content:Recent bubble',
          color: '#789abc', time: '2026-11-10T08:00:00+00:00', unread: true,
        },
        {
          id: expiredId, title: 'Expired bubble', content: 'content:Expired bubble',
          color: '#789abc', time: '2026-11-08T08:00:00+00:00', unread: true,
        },
      ])
      const fullList = await notificationsApp.inject({
        method: 'GET', url: '/api/v1/notifications?limit=100', headers,
      })
      const fullListIds = fullList.json().map((notification: { id: number }) => notification.id)
      assert.equal(fullListIds.includes(registrationBoundaryId), true)
      assert.equal(fullListIds.includes(beforeRegistrationBoundaryId), false)
      assert.equal(fullListIds.includes(preRegistrationId), false)
      assert.equal(fullListIds.includes(otherTargetId), false)
      const bubble = await notificationsApp.inject({ method: 'GET', url: '/api/v1/notifications/bubble', headers })
      assert.equal(bubble.statusCode, 200)
      assert.deepEqual(bubble.json(), {
        bubble: { id: recentBubbleId, title: 'Recent bubble', content: 'content:Recent bubble', color: '#789abc' },
      })
      await pool.query(
        'INSERT INTO notification_reads (user_id, notification_id, read_at) VALUES ($1, $2, $3)',
        [userId, recentBubbleId, '2026-11-11T00:00:00Z'],
      )
      const nextBubble = await notificationsApp.inject({ method: 'GET', url: '/api/v1/notifications/bubble', headers })
      assert.deepEqual(nextBubble.json(), {
        bubble: { id: transientId, title: 'Transient bubble', content: 'content:Transient bubble', color: '#789abc' },
      })
      const firstRead = await notificationsApp.inject({
        method: 'POST', url: '/api/v1/notifications/read', headers, payload: { ids: [sharedId, sharedId] },
      })
      assert.equal(firstRead.statusCode, 200)
      assert.deepEqual(firstRead.json(), { ok: true, marked: 1 })
      const duplicateRead = await notificationsApp.inject({
        method: 'POST', url: '/api/v1/notifications/read', headers, payload: { ids: [sharedId] },
      })
      assert.deepEqual(duplicateRead.json(), { ok: true, marked: 0 })
      const markAll = await notificationsApp.inject({
        method: 'POST', url: '/api/v1/notifications/read', headers, payload: { ids: [] },
      })
      assert.deepEqual(markAll.json(), { ok: true, marked: 4 })
      const clear = await notificationsApp.inject({ method: 'DELETE', url: '/api/v1/notifications', headers })
      assert.deepEqual(clear.json(), { ok: true, dismissed: 5 })
      const afterClear = await notificationsApp.inject({ method: 'GET', url: '/api/v1/notifications', headers })
      assert.deepEqual(afterClear.json(), [])
      const preserved = await pool.query<{ count: string }>(
        'SELECT count(*) AS count FROM site_notifications WHERE id = ANY($1::integer[])',
        [[preRegistrationId, otherTargetId, transientId]],
      )
      assert.equal(preserved.rows[0]?.count, '3')
    } finally {
      await notificationsApp.close()
    }
    core = await createPostgresRuntime({ url: databaseUrl!, schema, maxConnections: 2 })
    const projectApp = createApp({
      appName: 'Gugu',
      isReady: async () => true,
      userAuth: { secret, ...createUserRepository(pool) },
      listProjects: createProjectListing(core, pool),
      listProjectFileCounts: createProjectFileCountListing(pool),
      getProject: createProjectGetter(core, pool),
      events: createEventOperations(pool),
    })

    try {
      const activeResponse = await projectApp.inject({
        method: 'GET',
        url: '/api/v1/projects',
        headers: { authorization: `Bearer ${signedUserToken(secret, userId, 4)}` },
      })
      assert.equal(activeResponse.statusCode, 200)
      assert.deepEqual(activeResponse.json(), [{
        id: activeProjectId,
        name: 'Active owned project',
        client: null,
        status: 'pending',
        startDate: null,
        deadline: null,
        color: '#000000',
        progress: 0,
        stages: [],
        currentStage: null,
        archived: false,
        priority: null,
        version: 1,
        doneAt: null,
        updatedAt: '2026-11-02 00:00:00+00:00',
        deletedAt: null,
        createdAt: '2026-11-02',
        fileCount: 2,
      }])
      const archivedResponse = await projectApp.inject({
        method: 'GET',
        url: '/api/v1/projects?archived=true',
        headers: { authorization: `Bearer ${signedUserToken(secret, userId, 4)}` },
      })
      assert.equal(archivedResponse.statusCode, 200)
      assert.deepEqual(archivedResponse.json().map((project: { id: number }) => project.id), [archivedProjectId])
      const fileCountsResponse = await projectApp.inject({
        method: 'GET',
        url: '/api/v1/projects/file-counts',
        headers: { authorization: `Bearer ${signedUserToken(secret, userId, 4)}` },
      })
      assert.equal(fileCountsResponse.statusCode, 200)
      assert.deepEqual(fileCountsResponse.json(), [
        { projectId: activeProjectId, fileCount: 2 },
        { projectId: archivedProjectId, fileCount: 0 },
      ])
      const projectDetail = await projectApp.inject({
        method: 'GET',
        url: `/api/v1/projects/${activeProjectId}`,
        headers: { authorization: `Bearer ${signedUserToken(secret, userId, 4)}` },
      })
      assert.equal(projectDetail.statusCode, 200)
      assert.equal(projectDetail.json().id, activeProjectId)
      assert.equal(projectDetail.json().fileCount, 2)
      const otherProjectDetail = await projectApp.inject({
        method: 'GET',
        url: `/api/v1/projects/${otherProjectId}`,
        headers: { authorization: `Bearer ${signedUserToken(secret, userId, 4)}` },
      })
      assert.equal(otherProjectDetail.statusCode, 404)
      const recentDeletedProjectId = await insertProject(userId, 'Recent deleted project', false)
      const expiredDeletedProjectId = await insertProject(userId, 'Expired deleted project', false)
      const otherDeletedProjectId = await insertProject(otherUserId, 'Other owner deleted project', false)
      await pool.query('UPDATE projects SET deleted_at = $1 WHERE id = $2', [
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), recentDeletedProjectId,
      ])
      await pool.query('UPDATE projects SET deleted_at = $1 WHERE id = $2', [
        new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(), expiredDeletedProjectId,
      ])
      await pool.query('UPDATE projects SET deleted_at = $1 WHERE id = $2', [
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), otherDeletedProjectId,
      ])
      const deletedProjects = await projectApp.inject({
        method: 'GET',
        url: '/api/v1/projects?deleted=true',
        headers: { authorization: `Bearer ${signedUserToken(secret, userId, 4)}` },
      })
      assert.equal(deletedProjects.statusCode, 200)
      assert.deepEqual(deletedProjects.json().map((project: { id: number }) => project.id), [recentDeletedProjectId])

      const insertEvent = async (owner: string, title: string, date: string, deletedAt: string | null = null) => {
        const result = await pool.query<{ id: number }>(
          `INSERT INTO calendar_events
            (user_id, title, date, time, end_time, type, contact_name, project_id, description,
             version, created_at, deleted_at, idempotency_key, idempotency_fingerprint)
           VALUES ($1, $2, $3, '09:15', '10:00', 'event', 'Synthetic contact', NULL,
                   'Synthetic description', 1, '2026-11-02T00:00:00Z', $4, NULL, NULL)
           RETURNING id`,
          [owner, title, date, deletedAt],
        )
        return result.rows[0]!.id
      }
      const octoberEventId = await insertEvent(userId, 'October owned event', '2026-10-03')
      const novemberEventId = await insertEvent(userId, 'November owned event', '2026-11-12')
      const deletedEventId = await insertEvent(userId, 'Deleted owned event', '2026-11-13', new Date().toISOString())
      const otherEventId = await insertEvent(otherUserId, 'Other owner event', '2026-11-14')
      const events = await projectApp.inject({
        method: 'GET', url: '/api/v1/events',
        headers: { authorization: `Bearer ${signedUserToken(secret, userId, 4)}` },
      })
      assert.equal(events.statusCode, 200)
      assert.deepEqual(events.json().map((event: { id: number }) => event.id), [octoberEventId, novemberEventId])
      const novemberEvents = await projectApp.inject({
        method: 'GET', url: '/api/v1/events?year=2026&month=11',
        headers: { authorization: `Bearer ${signedUserToken(secret, userId, 4)}` },
      })
      assert.equal(novemberEvents.statusCode, 200)
      assert.deepEqual(novemberEvents.json(), [{
        id: novemberEventId,
        title: 'November owned event',
        date: '2026-11-12',
        time: '09:15',
        endTime: '10:00',
        type: 'event',
        client: 'Synthetic contact',
        projectId: null,
        description: 'Synthetic description',
        version: 1,
      }])
      const ownEvent = await projectApp.inject({
        method: 'GET', url: `/api/v1/events/${novemberEventId}`,
        headers: { authorization: `Bearer ${signedUserToken(secret, userId, 4)}` },
      })
      assert.equal(ownEvent.statusCode, 200)
      const otherEvent = await projectApp.inject({
        method: 'GET', url: `/api/v1/events/${otherEventId}`,
        headers: { authorization: `Bearer ${signedUserToken(secret, userId, 4)}` },
      })
      assert.equal(otherEvent.statusCode, 404)
      const deletedEvent = await projectApp.inject({
        method: 'GET', url: `/api/v1/events/${deletedEventId}`,
        headers: { authorization: `Bearer ${signedUserToken(secret, userId, 4)}` },
      })
      assert.equal(deletedEvent.statusCode, 404)
    } finally {
      await projectApp.close()
    }

    const clientApp = createApp({
      appName: 'Gugu',
      isReady: async () => true,
      userAuth: { secret, ...createUserRepository(pool) },
      clients: createClientOperations(core),
    })
    try {
      const invalidCreate = await clientApp.inject({
        method: 'POST',
        url: '/api/v1/clients',
        headers: { authorization: `Bearer ${signedUserToken(secret, userId, 4)}` },
        payload: { name: '   ' },
      })
      assert.equal(invalidCreate.statusCode, 422)
      const createResponse = await clientApp.inject({
        method: 'POST',
        url: '/api/v1/clients',
        headers: { authorization: `Bearer ${signedUserToken(secret, userId, 4)}` },
        payload: { name: 'Synthetic Core client', contact: 'Test contact' },
      })
      assert.equal(createResponse.statusCode, 201)
      const createdClient = createResponse.json()
      assert.deepEqual(createdClient, {
        id: createdClient.id,
        name: 'Synthetic Core client',
        contact: 'Test contact',
        email: null,
        phone: null,
        notes: '',
      })
      const otherClient = await pool.query<{ id: number }>(
        `INSERT INTO clients (user_id, name, contact, email, phone, notes, created_at)
         VALUES ($1, 'Other owner client', NULL, NULL, NULL, '', '2026-11-02T00:00:00Z')
         RETURNING id`,
        [otherUserId],
      )
      const ownerList = await clientApp.inject({
        method: 'GET',
        url: '/api/v1/clients',
        headers: { authorization: `Bearer ${signedUserToken(secret, userId, 4)}` },
      })
      assert.equal(ownerList.statusCode, 200)
      assert.deepEqual(ownerList.json().map((client: { id: number }) => client.id), [createdClient.id])
      const crossOwnerDelete = await clientApp.inject({
        method: 'DELETE',
        url: `/api/v1/clients/${otherClient.rows[0]!.id}`,
        headers: { authorization: `Bearer ${signedUserToken(secret, userId, 4)}` },
      })
      assert.equal(crossOwnerDelete.statusCode, 404)
      const ownDelete = await clientApp.inject({
        method: 'DELETE',
        url: `/api/v1/clients/${createdClient.id}`,
        headers: { authorization: `Bearer ${signedUserToken(secret, userId, 4)}` },
      })
      assert.equal(ownDelete.statusCode, 204)
      const remaining = await pool.query<{ name: string }>('SELECT name FROM clients ORDER BY id')
      assert.deepEqual(remaining.rows.map((row) => row.name), ['Other owner client'])
    } finally {
      await clientApp.close()
    }

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId, 4)}` },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      id: userId,
      username: 'integration-user',
      display_name: '合成集成用户',
      email: 'integration@example.test',
      is_active: true,
      avatar_url: null,
      created_at: '2026-11-02',
      im_channels: ['qq'],
      timezone: 'Asia/Shanghai',
      email_subscribed: false,
    })
    const stored = await pool.query<{ last_active_at: Date | null }>(
      'SELECT last_active_at FROM users WHERE id = $1',
      [userId],
    )
    assert.ok(stored.rows[0]?.last_active_at instanceof Date)
  } finally {
    await app.close()
    await core?.close()
    await pool.end()
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  }
})
