import { definePostgresMigration } from '../runner.js'

export const repairIdentitySequences = definePostgresMigration({
  revision: '0047_repair_identity_sequences',
  prerequisites: ['users'],
  tables: [],
  sql: `
    DO $gugu$
    DECLARE
      target record;
      maximum_id bigint;
      sequence_last bigint;
      sequence_called boolean;
    BEGIN
      FOR target IN
        SELECT table_schema, table_name, column_name,
          pg_get_serial_sequence(format('%I.%I', table_schema, table_name), column_name) AS sequence_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND column_name = 'id'
          AND pg_get_serial_sequence(format('%I.%I', table_schema, table_name), column_name) IS NOT NULL
        ORDER BY table_name
      LOOP
        EXECUTE format('SELECT max(%I)::bigint FROM %I.%I', target.column_name, target.table_schema, target.table_name)
          INTO maximum_id;
        IF maximum_id IS NULL THEN CONTINUE; END IF;

        EXECUTE format('SELECT last_value::bigint, is_called FROM %s', target.sequence_name::regclass)
          INTO sequence_last, sequence_called;
        IF (sequence_called AND sequence_last < maximum_id)
          OR (NOT sequence_called AND sequence_last <= maximum_id) THEN
          PERFORM setval(target.sequence_name::regclass, maximum_id, true);
        END IF;
      END LOOP;
    END
    $gugu$;
  `,
})
