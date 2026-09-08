import mysql from 'mysql2/promise';
import { getMysqlEnvVars } from '@/lib/env';

const globalForDb = globalThis as unknown as {
  pool: mysql.Pool | undefined;
};

export function getPool(): mysql.Pool {
  // 接続プールがグローバルにあればそのまま返す
  if (globalForDb.pool) {
    return globalForDb.pool;
  }

  const vars = getMysqlEnvVars();
  const pool = mysql.createPool({
    host: vars.host,
    port: vars.port,
    user: vars.user,
    password: vars.password,
    database: vars.database,
    waitForConnections: true,
    connectionLimit: 3,
    queueLimit: 0,
    // MySQLはUTCで返し、表示側のtoLocaleStringでJSTへ変換する。
    // ここをサーバのtime_zoneとずらすと日時が9時間ずれるため'Z'固定。
    timezone: 'Z',
  });

  // 開発環境(npm run dev)で、ホットリロードによるコード変更の度に新しい接続プール作成を回避
  if (process.env.NODE_ENV !== 'production') {
    globalForDb.pool = pool;
  }

  return pool;
}
