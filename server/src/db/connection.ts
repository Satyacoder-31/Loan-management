import pg from "pg";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

if (!process.env.DATABASE_URL) {
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, "utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (!process.env[key]) process.env[key] = val;
        }
      }
    }
  } catch {}
}

const isSqliteMode = process.env.USE_SQLITE === "true" || !process.env.DATABASE_URL || process.env.DATABASE_URL.includes(".db");
const exportPgPath = process.env.EXPORT_PG_SQL ? path.resolve(process.cwd(), process.env.EXPORT_PG_SQL) : null;

let sqliteDbInstance: DatabaseSync | null = null;
if (isSqliteMode) {
  const dbDir = path.resolve(process.cwd(), "demo-data");
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  const dbFile = path.resolve(dbDir, "sniper.db");
  sqliteDbInstance = new DatabaseSync(dbFile);
}

function appendPgSql(pgSql: string) {
  if (!exportPgPath) return;
  const clean = pgSql.trim();
  if (!clean) return;
  fs.appendFileSync(exportPgPath, clean + ";\n", "utf8");
}

function resolveSsl(): pg.PoolConfig["ssl"] | undefined {
  const flag = process.env.DATABASE_SSL;
  if (flag === "true") return { rejectUnauthorized: false };
  if (flag === "false") return undefined;
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname;
    return /^(127\.0\.0\.1|localhost|::1)$/i.test(host) ? undefined : { rejectUnauthorized: false };
  } catch {
    return { rejectUnauthorized: false };
  }
}

pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1700, (v: string) => Number(v));

export const TEST_SCHEMA: string | undefined = (() => {
  const raw = process.env.NEXUS_DB;
  if (!raw) return undefined;
  const hash = createHash("md5").update(raw).digest("hex").slice(0, 8);
  return `nx_${process.pid.toString(36)}_${hash}`;
})();

const pool = isSqliteMode ? null : new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveSsl(),
  ...(TEST_SCHEMA ? { options: `-c search_path=${TEST_SCHEMA}` } : {})
});

if (pool) {
  pool.on("error", (err) => {
    console.error("[db] pooled connection error:", err.message);
  });
}

const transactionStorage = new AsyncLocalStorage<pg.PoolClient>();

async function getClient(): Promise<pg.Pool | pg.PoolClient> {
  return transactionStorage.getStore() || pool!;
}

function sqliteToPgSql(sql: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let paramIndex = 1;
  let result = "";
  
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (char === "'" && sql[i - 1] !== "\\") {
      inSingleQuote = !inSingleQuote;
      result += char;
    } else if (char === '"' && sql[i - 1] !== "\\") {
      inDoubleQuote = !inDoubleQuote;
      result += char;
    } else if (char === "`" && sql[i - 1] !== "\\") {
      inBacktick = !inBacktick;
      result += char;
    } else if (char === "?" && !inSingleQuote && !inDoubleQuote && !inBacktick) {
      result += `$${paramIndex++}`;
    } else {
      result += char;
    }
  }
  return result;
}

export function translateSql(sql: string): string {
  let s = sql.trim();
  
  s = s.replace(/\bdate\('now'\s*\)/gi, "CURRENT_DATE");
  s = s.replace(/\bdate\('now',\s*'([^']+)'\)/gi, (_m, interval) => `(CURRENT_DATE + INTERVAL '${interval}')`);
  s = s.replace(/\bdate\(([A-Za-z_][A-Za-z0-9_.]*)\)/gi, "CAST($1 AS DATE)");
  s = s.replace(/\bdate\('now',\s*([^)]+)\)/gi, (_m, val) => {
    if (val.trim() === "?") return `(CURRENT_DATE + CAST(? AS INTERVAL))`;
    return _m;
  });
  s = s.replace(/\bdatetime\('now'\s*\)/gi, "CURRENT_TIMESTAMP");
  s = s.replace(/\bdatetime\('now',\s*'([^']+)'\)/gi, (_m, interval) => `(CURRENT_TIMESTAMP + INTERVAL '${interval}')`);

  s = s.replace(/THEN CURRENT_TIMESTAMP(?=\s+ELSE\s+[A-Za-z_][A-Za-z0-9_.]*\s+END)/gi,
    "THEN TO_CHAR(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')");
  s = s.replace(/\bdatetime\('now',\s*([^)]+)\)/gi, (_m, val) => {
    if (val.trim() === "?") return `(CURRENT_TIMESTAMP + CAST(? AS INTERVAL))`;
    return _m;
  });

  s = s.replace(/\bjulianday\('now'\)/gi, "(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)/86400.0)");
  s = s.replace(/\bjulianday\(([^()]+)\)/gi, (_m, arg) => `(EXTRACT(EPOCH FROM CAST(${arg} AS TIMESTAMP))/86400.0)`);

  s = s.replace(/\bstrftime\('%Y-%m-%d',\s*([^()]+)\)/gi, (_m, arg) => `TO_CHAR(CAST(${arg} AS TIMESTAMP), 'YYYY-MM-DD')`);
  s = s.replace(/\bstrftime\('%Y-%m',\s*([^()]+)\)/gi, (_m, arg) => `TO_CHAR(CAST(${arg} AS TIMESTAMP), 'YYYY-MM')`);

  if (/INSERT OR IGNORE INTO gn_attendance/i.test(s)) {
    s = s.replace(/INSERT OR IGNORE INTO gn_attendance/i, "INSERT INTO gn_attendance");
    s += " ON CONFLICT DO NOTHING";
  } else if (/INSERT OR IGNORE INTO gn_payroll/i.test(s)) {
    s = s.replace(/INSERT OR IGNORE INTO gn_payroll/i, "INSERT INTO gn_payroll");
    s += " ON CONFLICT (user_id, month) DO NOTHING";
  } else if (/INSERT OR IGNORE INTO/i.test(s)) {
    s = s.replace(/INSERT OR IGNORE INTO/i, "INSERT INTO");
    s += " ON CONFLICT DO NOTHING";
  }

  if (/INSERT OR REPLACE INTO system_config/i.test(s)) {
    s = s.replace(/INSERT OR REPLACE INTO system_config/i, "INSERT INTO system_config");
    s += " ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at";
  } else if (/INSERT OR REPLACE INTO gn_payroll/i.test(s)) {
    s = s.replace(/INSERT OR REPLACE INTO gn_payroll/i, "INSERT INTO gn_payroll");
    s += " ON CONFLICT (user_id, month) DO UPDATE SET basic = EXCLUDED.basic, hra = EXCLUDED.hra, allowance = EXCLUDED.allowance, gross = EXCLUDED.gross, tds = EXCLUDED.tds, net = EXCLUDED.net, status = EXCLUDED.status";
  } else if (/INSERT OR REPLACE INTO gn_roles/i.test(s)) {
    s = s.replace(/INSERT OR REPLACE INTO gn_roles/i, "INSERT INTO gn_roles");
    s += " ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, designation = EXCLUDED.designation, partner_type = EXCLUDED.partner_type, is_system = EXCLUDED.is_system";
  } else if (/INSERT OR REPLACE INTO gn_role_permissions/i.test(s)) {
    s = s.replace(/INSERT OR REPLACE INTO gn_role_permissions/i, "INSERT INTO gn_role_permissions");
    s += " ON CONFLICT (tenant_id, role_id, module, action) DO UPDATE SET scope = EXCLUDED.scope, allowed = EXCLUDED.allowed";
  }

  s = s.replace(/sqlite_master/gi, "pg_tables");
  s = s.replace(/\bMAX\s*\(\s*0\s*,\s*/gi, "GREATEST(0, ");
  s = s.replace(/\bjson_extract\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*,\s*'\$\.([A-Za-z0-9_]+)'\s*\)/gi,
    (_m, col, key) => `(CAST(${col} AS jsonb) ->> '${key}')`);

  s = sqliteToPgSql(s);

  if (s.trim().toUpperCase().startsWith("INSERT ") && !s.toUpperCase().includes("RETURNING ")) {
    s += " RETURNING id";
  }

  return s;
}

function translateDdl(sql: string): string {
  let s = sql;
  s = s.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, "SERIAL PRIMARY KEY");
  s = s.replace(/\(datetime\('now'\)\)/gi, "CURRENT_TIMESTAMP");
  s = s.replace(/datetime\('now'\)/gi, "CURRENT_TIMESTAMP");
  s = s.replace(/PRAGMA journal_mode\s*=\s*WAL;/gi, "");
  s = s.replace(/PRAGMA foreign_keys\s*=\s*\w+;/gi, "");
  return s;
}

function escapeSqlVal(v: any): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function formatSqlParams(sql: string, params: unknown[] = []): string {
  if (!params || params.length === 0) return sql;
  let paramIdx = 0;
  let res = sql.replace(/\$([0-9]+)/g, (_, num) => {
    const idx = parseInt(num, 10) - 1;
    return escapeSqlVal(params[idx]);
  });
  res = res.replace(/\?/g, () => escapeSqlVal(params[paramIdx++]));
  return res;
}

class PostgresDbWrapper {
  async exec(sql: string): Promise<void> {
    if (isSqliteMode && sqliteDbInstance) {
      const sqliteSql = sql
        .replace(/SELECT pg_advisory_xact_lock\([^)]+\);?/gi, "")
        .replace(/\bCASCADE;/gi, ";");
      sqliteDbInstance.exec(sqliteSql);
      appendPgSql(translateDdl(sql));
      return;
    }
    const translated = translateDdl(sql);
    const client = await getClient();
    await client.query(translated);
    appendPgSql(translated);
  }
}

const _db = new PostgresDbWrapper();

export function db(): PostgresDbWrapper {
  return _db;
}

export type Row = Record<string, any>;
export const DB_PATH = process.env.DATABASE_URL || "";
export const TEST_SCHEMA_REGEX = /^nx_[a-z0-9_]+$/;

export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (isSqliteMode && sqliteDbInstance) {
    const stmt = sqliteDbInstance.prepare(sql);
    const rows = stmt.all(...(params as any[]));
    appendPgSql(formatSqlParams(translateSql(sql), params));
    return rows as T[];
  }
  const translated = translateSql(sql);
  const client = await getClient();
  const res = await client.query(translated, params);
  appendPgSql(formatSqlParams(translated, params));
  return res.rows as T[];
}

export async function q1<T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  if (isSqliteMode && sqliteDbInstance) {
    const stmt = sqliteDbInstance.prepare(sql);
    const row = stmt.get(...(params as any[]));
    appendPgSql(formatSqlParams(translateSql(sql), params));
    return row as T | undefined;
  }
  const rows = await q<T>(sql, params);
  return rows[0];
}

export async function run(sql: string, params: unknown[] = []) {
  if (isSqliteMode && sqliteDbInstance) {
    const stmt = sqliteDbInstance.prepare(sql);
    const info = stmt.run(...(params as any[]));
    appendPgSql(formatSqlParams(translateSql(sql), params));
    return { lastId: Number(info.lastInsertRowid), changes: info.changes };
  }
  const translated = translateSql(sql);
  const client = await getClient();
  const res = await client.query(translated, params);
  appendPgSql(formatSqlParams(translated, params));
  const lastId = res.rows[0]?.id ? Number(res.rows[0].id) : 0;
  return { lastId, changes: res.rowCount ?? 0 };
}

export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (isSqliteMode && sqliteDbInstance) {
    sqliteDbInstance.exec("BEGIN TRANSACTION");
    appendPgSql("BEGIN");
    try {
      const res = await fn();
      sqliteDbInstance.exec("COMMIT");
      appendPgSql("COMMIT");
      return res;
    } catch (e) {
      sqliteDbInstance.exec("ROLLBACK");
      appendPgSql("ROLLBACK");
      throw e;
    }
  }
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    appendPgSql("BEGIN");
    const result = await transactionStorage.run(client, fn);
    await client.query("COMMIT");
    appendPgSql("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    appendPgSql("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function now(): Promise<string> {
  return new Date().toISOString();
}

export async function withSessionLock<T>(key: number, fn: () => Promise<T>): Promise<T> {
  if (isSqliteMode) {
    return await fn();
  }
  const client = await pool!.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [key]);
    return await fn();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [key]).catch(() => {});
    client.release();
  }
}
