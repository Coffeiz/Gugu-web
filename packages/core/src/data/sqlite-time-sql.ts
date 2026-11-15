import { sql, type RawBuilder } from 'kysely'

/** 只生成SQLite规范微秒时间谓词；调用方须限定owner，并在LIMIT前校验完整排序来源。 */
export function isCanonicalSqliteTime(value: RawBuilder<unknown>): RawBuilder<boolean> {
  return sql<boolean>`COALESCE(
    typeof(${value})='text' AND length(${value})=26 AND instr(${value},char(0))=0
    AND ${value} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]'
    AND substr(${value},1,4) BETWEEN '0001' AND '9999'
    AND substr(${value},6,2) BETWEEN '01' AND '12'
    AND substr(${value},9,2) BETWEEN '01' AND '31'
    AND CAST(substr(${value},9,2) AS INTEGER) <= CASE
      WHEN substr(${value},6,2)='02' THEN CASE
        WHEN CAST(substr(${value},1,4) AS INTEGER)%400=0
          OR (CAST(substr(${value},1,4) AS INTEGER)%4=0 AND CAST(substr(${value},1,4) AS INTEGER)%100<>0) THEN 29 ELSE 28 END
      WHEN substr(${value},6,2) IN ('04','06','09','11') THEN 30 ELSE 31 END
    AND date(substr(${value},1,10),'+0 days')=substr(${value},1,10)
    AND substr(${value},12,2) BETWEEN '00' AND '23'
    AND substr(${value},15,2) BETWEEN '00' AND '59'
    AND substr(${value},18,2) BETWEEN '00' AND '59',0)`
}
