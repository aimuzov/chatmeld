import { DatabaseSync } from "node:sqlite";
import type { SessionStorage } from "../src/index.js";

export function sqliteSessionStorage(
  db: DatabaseSync,
  scope: string,
): SessionStorage {
  db.exec(`CREATE TABLE IF NOT EXISTS chatmeld_sessions (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    value BLOB NOT NULL,
    PRIMARY KEY (scope, key)
  )`);
  const read = db.prepare(
    "SELECT value FROM chatmeld_sessions WHERE scope = ? AND key = ?",
  );
  const write = db.prepare(
    "INSERT INTO chatmeld_sessions (scope, key, value) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value",
  );
  const remove = db.prepare(
    "DELETE FROM chatmeld_sessions WHERE scope = ? AND key = ?",
  );
  return {
    async read(key) {
      const row = read.get(scope, key);
      return row ? new Uint8Array(row.value as Uint8Array) : undefined;
    },
    async writeBatch(changes) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const change of changes) {
          if (change.type === "set") write.run(scope, change.key, change.value);
          else remove.run(scope, change.key);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
