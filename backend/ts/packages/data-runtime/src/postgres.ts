import postgres, { type Sql } from "postgres";

export type PostgresOptions = {
  max?: number;
  idleTimeout?: number;
  connectTimeout?: number;
};

export function createPostgresClient(url: string, options: PostgresOptions = {}): Sql {
  if (!url.trim()) throw new Error("Data Runtime 需要数据库连接地址");
  return postgres(url, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 30,
    connect_timeout: options.connectTimeout ?? 10,
    onnotice: () => undefined,
  });
}

export async function closePostgresClient(client: Sql): Promise<void> {
  await client.end({ timeout: 5 });
}
