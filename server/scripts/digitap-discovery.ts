/**
 * Digitap enablement discovery — probes every endpoint in the KYC Validation
 * Suite v4.91 with SYNTHETIC, format-valid, non-existent inputs.
 *
 *   cd sdacrm/server
 *   npm run test:digitap-discovery
 *
 * Output: console table + docs/digitap-enablement-report.md (committed).
 * Evidence is never fabricated: 200+101/102/103 → enabled; 401 → bad
 * credentials; 403 → egress IP not whitelisted; 412 → product not enabled.
 * One probe per endpoint, 1 attempt, 20s timeout.
 */
import fs from "node:fs";
import path from "node:path";
import { digitapConfig, digitapBaseUrl, probeRaw, PROBE_CATALOG } from "../src/adapters/digitap.js";

/** Load server/.env (same convention as db/connection.ts) before probing. */
function loadEnv(): void {
  if (process.env.DIGITAP_UAT_CLIENT_ID) return;
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#") && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  }
}

type Verdict = "enabled" | "auth_failed" | "ip_blocked" | "not_enabled" | "payload_rejected" | "unreachable" | "unexpected";

function classify(http: number, rc: number | null): Verdict {
  if (http === 200 && (rc === 101 || rc === 102 || rc === 103 || rc === 109)) return "enabled";
  if (http === 503) return "unexpected"; // source busy/maintenance — retry
  if (http === 401) return "auth_failed";
  if (http === 403) return "ip_blocked";
  if (http === 412) return "not_enabled";
  if (http === 400) return "payload_rejected";
  if (http === 0) return "unreachable";
  return "unexpected";
}

interface Row {
  code: string;
  path: string;
  http: number;
  rc: number | null;
  verdict: Verdict;
  ms: number;
  note: string;
}

async function main(): Promise<void> {
  loadEnv();
  const { env, creds } = digitapConfig();
  if (!creds) {
    console.error("Digitap credentials missing — set DIGITAP_UAT_CLIENT_ID/SECRET in server/.env");
    process.exit(1);
  }
  console.log(`Digitap ${env.toUpperCase()} (${digitapBaseUrl(env)}) — client ${creds.clientId}\n`);

  const rows: Row[] = [];
  for (const [code, { path: p, payload }] of Object.entries(PROBE_CATALOG)) {
    try {
      const r = await probeRaw(p, payload);
      const verdict = classify(r.httpStatus, r.resultCode);
      rows.push({ code, path: p, http: r.httpStatus, rc: r.resultCode, verdict, ms: r.latencyMs, note: r.message });
      console.log(`${verdict.padEnd(18)} ${code.padEnd(24)} HTTP ${String(r.httpStatus).padEnd(4)} result ${String(r.resultCode ?? "—").padEnd(5)} ${r.latencyMs}ms ${r.message}`);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      const httpMatch = msg.match(/HTTP (\d+)/);
      const http = httpMatch ? Number(httpMatch[1]) : 0;
      rows.push({ code, path: p, http, rc: null, verdict: classify(http, null), ms: 0, note: msg });
      console.log(`${"unreachable".padEnd(18)} ${code.padEnd(24)} HTTP ${String(http).padEnd(4)} result —     0ms ${msg}`);
    }
  }

  const enabled = rows.filter((r) => r.verdict === "enabled");
  console.log(`\n${enabled.length}/${rows.length} endpoints ENABLED for client ${creds.clientId} (${env.toUpperCase()})`);
  for (const r of enabled) console.log(`  ✓ ${r.code} (${r.path})`);

  const lines = [
    "# Digitap enablement report — KYC Validation Suite v4.91",
    "",
    `Probed: ${new Date().toISOString()} · env **${env.toUpperCase()}** · client **${creds.clientId}** · host \`${digitapBaseUrl(env)}\``,
    "",
    "Synthetic payloads only (format-valid, non-existent records) — no real profile touched,",
    "no customer data sent. One call per endpoint.",
    "",
    "| endpoint | path | HTTP | result_code | verdict | latency | note |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.code} | \`${r.path}\` | ${r.http} | ${r.rc ?? "—"} | ${r.verdict} | ${r.ms}ms | ${r.note.replace(/\|/g, "\\|").slice(0, 120) || "—"} |`),
    "",
    `**Enabled: ${enabled.length}/${rows.length}** — HTTP 200 + result 101/102/103 = credentials OK + product enabled.`,
    "",
    "Legend: 401 = wrong credentials for this env · 403 = whitelist the server egress IP with",
    "Digitap · 412 = ask your RM to enable the product · 400 = endpoint reachable, check payload."
  ];
  const out = path.resolve(process.cwd(), "../docs/digitap-enablement-report.md");
  fs.writeFileSync(out, lines.join("\n"), "utf8");
  console.log(`\nReport written → docs/digitap-enablement-report.md`);
}

main().catch((e) => { console.error(e); process.exit(1); });
