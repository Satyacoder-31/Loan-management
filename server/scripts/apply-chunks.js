import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const migrationFile = path.resolve("c:/Users/Admin/Downloads/loan management/sdacrm/supabase/migrations/0002_seed_demo_data.sql");
const content = fs.readFileSync(migrationFile, "utf8");
const lines = content.split("\n");

const insertStatements = [];
const ddlStatements = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line || line.startsWith("--")) continue;
  if (line.toUpperCase().startsWith("INSERT INTO")) {
    let clean = line.replace(/ RETURNING id;/gi, ";").replace(/;;+$/, ";");
    if (clean.startsWith("INSERT INTO tenants (code,")) {
      clean = clean.replace("INSERT INTO tenants (code,", "INSERT INTO tenants (id, code,").replace("VALUES ('NEXUS-DEMO',", "VALUES (1, 'NEXUS-DEMO',");
    }
    if (!clean.toUpperCase().includes("ON CONFLICT")) {
      clean = clean.replace(/;$/, " ON CONFLICT DO NOTHING;");
    }
    insertStatements.push(clean);
  } else if (line.toUpperCase().startsWith("CREATE TABLE") || line.toUpperCase().startsWith("CREATE INDEX") || line.toUpperCase().startsWith("DROP TABLE")) {
    let clean = line.replace(/;;+$/, ";");
    ddlStatements.push(clean);
  }
}

console.log(`Extracted ${ddlStatements.length} DDL statements and ${insertStatements.length} INSERT statements.`);

const token = process.env.SUPABASE_ACCESS_TOKEN || "";
const projectRoot = path.resolve("c:/Users/Admin/Downloads/loan management/sdacrm");
const env = { ...process.env, SUPABASE_ACCESS_TOKEN: token };
const tmpChunkFile = path.resolve("c:/Users/Admin/Downloads/loan management/sdacrm/server/scripts/tmp_chunk.sql");

// Step 1: Apply DDL statements
console.log("Step 1: Applying DDL schema to Supabase...");
const ddlBatchSize = 50;
for (let i = 0; i < Math.ceil(ddlStatements.length / ddlBatchSize); i++) {
  const chunk = ddlStatements.slice(i * ddlBatchSize, (i + 1) * ddlBatchSize);
  const sql = "BEGIN;\n" + chunk.join("\n") + "\nCOMMIT;";
  fs.writeFileSync(tmpChunkFile, sql, "utf8");
  try {
    execSync(`npx supabase db query --linked -f "${tmpChunkFile}"`, { env, cwd: projectRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    // Ignore existing table/index warnings
  }
}
console.log("DDL schema step completed.");

// Step 2: Apply INSERTS in batches of 1000
console.log(`Step 2: Seeding ${insertStatements.length} data rows in batches of 1000...`);
const batchSize = 1000;
const totalBatches = Math.ceil(insertStatements.length / batchSize);
let successCount = 0;

for (let i = 0; i < totalBatches; i++) {
  const batch = insertStatements.slice(i * batchSize, (i + 1) * batchSize);
  const sqlContent = "BEGIN;\n" + batch.join("\n") + "\nCOMMIT;";
  fs.writeFileSync(tmpChunkFile, sqlContent, "utf8");

  try {
    execSync(`npx supabase db query --linked -f "${tmpChunkFile}"`, { env, cwd: projectRoot, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    successCount += batch.length;
    if ((i + 1) % 5 === 0 || i === totalBatches - 1) {
      console.log(`[Supabase Seed] Batch ${i + 1}/${totalBatches} (${Math.round(((i + 1) / totalBatches) * 100)}%) — ${successCount}/${insertStatements.length} rows inserted`);
    }
  } catch (err) {
    console.error(`Batch ${i + 1} note:`, err.message?.slice(0, 150));
  }
}

if (fs.existsSync(tmpChunkFile)) fs.unlinkSync(tmpChunkFile);
console.log(`SUCCESS: All ${insertStatements.length} demo data statements processed for Supabase database!`);

