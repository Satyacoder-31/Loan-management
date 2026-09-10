/**
 * API Test Lab — a standalone dashboard for testing every Digitap driver
 * against documents the user uploads.
 *
 * How it works:
 *   - Digitap KYC products verify by ID NUMBER (PAN / EPIC / passport / DL /
 *     Aadhaar), not by document image. The lab takes the uploaded file as the
 *     document reference (name/type recorded) and runs the provider on the
 *     number entered (or auto-extracted from the filename by the client).
 *   - Every run records a consent entry + audit event and mirrors the request
 *     + masked result to the Supabase provider store (fail-open).
 *   - PII is masked by the drivers before anything is persisted or returned;
 *     raw Aadhaar is never stored.
 */
import { Router } from "express";
import { z } from "zod";
import { authRequired, asyncH, clientIp, requirePerm, type AuthedRequest } from "../middleware.js";
import { q } from "../db/connection.js";
import { audit } from "../core/audit.js";
import { saveConsentRecord, logProviderRequest, saveVerificationResult } from "../db/supabase.js";
import {
  CATALOG_BY_CODE, DigitapError, digitapConfig, parseRowConfig,
  panVerify, panDetails, pan206abCompliance, panItrStatus, panToName, panToFatherName,
  panProfile, panAccountLink, ovdVerify, panAadhaarLink, panToMaskedAadhaar,
  aadhaarToMaskedPan, aadhaarToUnmaskedPan, probeRaw
} from "../adapters/index.js";

export const doclabRouter = Router();
doclabRouter.use(authRequired);

/* ------------------------------------------------------------------ */
/* Lab registry: which adapters the lab can drive, their document      */
/* types, input fields and the runner that calls the real driver.      */
/* ------------------------------------------------------------------ */

interface LabField { key: string; label: string; required: boolean; placeholder?: string; hint?: string }

interface LabAdapter {
  docs: string[];
  endpoint: string;
  fields: LabField[];
  /** `result` is the driver's already-masked provider result — the lab renders it as-is. */
  run: (input: Record<string, any>) => Promise<{ result: any; providerRef: string; endpoint: string }>;
}

/** Every PAN field carries the holder-type rule, because the provider rejects a
 *  PAN whose 4th character is not a holder type — and "ABCDE1234F", the sample
 *  everyone copies, is exactly such a PAN. */
const PAN_HINT = "4th letter is the holder type (A/B/C/F/G/H/J/L/P/T) — the sample \"ABCDE1234F\" has \"D\" and is rejected by the provider. Enter the PAN printed on the card.";
const DOB_HINT = "Accepts YYYY-MM-DD or DD/MM/YYYY — unpadded parts are fixed automatically.";

const PAN_FIELDS: LabField[] = [
  { key: "pan", label: "PAN number", required: true, placeholder: "ABCPE1234F", hint: PAN_HINT },
  { key: "name", label: "Full name (match check)", required: false, placeholder: "Name printed on the card" },
  { key: "dob", label: "DOB (match check)", required: false, placeholder: "1990-01-31", hint: DOB_HINT }
];

const LAB_ADAPTERS: Record<string, LabAdapter> = {
  pan_verify: {
    docs: ["PAN Card"], endpoint: "/validation/kyc/v1|v2/pan_basic", fields: PAN_FIELDS,
    run: async (i) => {
      const useV2 = !!(i.name && i.dob);
      const r = await panVerify({ pan: i.pan, name: i.name || null, dob: i.dob || null, v2: useV2, nameMatchMethod: "fuzzy" });
      const result = r.result;
      // Only judge name/DOB when they were supplied — Digitap returns
      // name_match:false when there is nothing to compare, which must not be
      // read as a failed verification of an Active PAN.
      const nameOk = !i.name || result.nameMatch !== false;
      const dobOk = !i.dob || result.dobMatch !== false;
      return {
        result: {
          ...result,
          verified: result.panStatus === "Active" && nameOk && dobOk,
          checked: { panStatus: true, nameMatch: !!i.name, dobMatch: !!i.dob }
        },
        providerRef: r.providerRef, endpoint: useV2 ? "/validation/kyc/v2/pan_basic" : "/validation/kyc/v1/pan_basic"
      };
    }
  },
  pan_details: {
    docs: ["PAN Card"], endpoint: "/validation/kyc/v1/pan_details", fields: [
      { key: "pan", label: "PAN number", required: true, placeholder: "ABCPE1234F", hint: PAN_HINT },
      { key: "name", label: "Full name (name-match scoring)", required: false, placeholder: "Name printed on the card" },
      { key: "dob", label: "DOB", required: false, placeholder: "1990-01-31", hint: DOB_HINT }
    ],
    run: async (i) => {
      const r = await panDetails({ pan: i.pan, panDisplayName: true, name: i.name || null, nameMatchMethod: "fuzzy" });
      const d = r.result;
      const score = d.nameMatchScore as number | null | undefined;
      // Same rule as pan_verify: an unsupplied name is not a failed match.
      const nameOk = !i.name || (d.nameMatch !== false && (score == null || score >= 80));
      const dobOk = !i.dob || !d.dob || d.dob === i.dob;
      return { result: { ...d, verified: nameOk && dobOk, nameThreshold: 80, dobConsistent: dobOk }, providerRef: r.providerRef, endpoint: r.endpoint };
    }
  },
  pan_details_plus: {
    docs: ["PAN Card"], endpoint: "/validation/kyc/v1/pan_details_plus",
    fields: [{ key: "pan", label: "PAN number", required: true, placeholder: "ABCPE1234F", hint: PAN_HINT }],
    run: async (i) => {
      const p = await probeRaw("/validation/kyc/v1/pan_details_plus", { pan: i.pan });
      return { result: { httpStatus: p.httpStatus, resultCode: p.resultCode, message: p.message }, providerRef: `probe-${Date.now()}`, endpoint: "/validation/kyc/v1/pan_details_plus" };
    }
  },
  pan_206ab: {
    docs: ["PAN Card"], endpoint: "/validation/kyc/v1/form206ab_compliance_status",
    fields: [{ key: "pan", label: "PAN number", required: true, placeholder: "ABCPE1234F", hint: PAN_HINT }],
    run: async (i) => { const r = await pan206abCompliance(i.pan); return { result: r.result, providerRef: r.providerRef, endpoint: "/validation/kyc/v1/form206ab_compliance_status" }; }
  },
  pan_itr: {
    docs: ["PAN Card"], endpoint: "/validation/kyc/v1/itr_basic",
    fields: [{ key: "pan", label: "PAN number", required: true, placeholder: "ABCPE1234F", hint: PAN_HINT }],
    run: async (i) => { const r = await panItrStatus(i.pan); return { result: { filings: r.result }, providerRef: r.providerRef, endpoint: "/validation/kyc/v1/itr_basic" }; }
  },
  pan_to_name: {
    docs: ["PAN Card"], endpoint: "/validation/kyc/v1/pan_to_name",
    fields: [{ key: "pan", label: "PAN number", required: true, placeholder: "ABCPE1234F", hint: PAN_HINT }],
    run: async (i) => { const r = await panToName(i.pan); return { result: { fullName: r.fullName }, providerRef: r.providerRef, endpoint: "/validation/kyc/v1/pan_to_name" }; }
  },
  pan_to_fname: {
    docs: ["PAN Card"], endpoint: "/validation/kyc/v1/pan_to_father_name",
    fields: [{ key: "pan", label: "PAN number", required: true, placeholder: "ABCPE1234F", hint: PAN_HINT }],
    run: async (i) => { const r = await panToFatherName(i.pan); return { result: { fatherName: r.fatherName }, providerRef: r.providerRef, endpoint: "/validation/kyc/v1/pan_to_father_name" }; }
  },
  pan_profile: {
    docs: ["PAN Card"], endpoint: "/validation/kyc/v1/pan_profile",
    fields: [{ key: "pan", label: "PAN number", required: true, placeholder: "ABCPE1234F", hint: PAN_HINT }],
    run: async (i) => { const r = await panProfile(i.pan); return { result: r.result, providerRef: r.providerRef, endpoint: "/validation/kyc/v1/pan_profile" }; }
  },
  pan_account_linkage: {
    docs: ["PAN Card"], endpoint: "/validation/kyc/v1/pan_to_bank_account_linkage",
    fields: [
      { key: "pan", label: "PAN number", required: true, placeholder: "ABCPE1234F", hint: PAN_HINT },
      { key: "account_number", label: "Bank account number", required: true },
      { key: "ifsc", label: "IFSC code", required: true, placeholder: "HDFC0001234" }
    ],
    run: async (i) => {
      const r = await panAccountLink(i.pan, i.account_number, i.ifsc);
      return { result: r.result, providerRef: r.providerRef, endpoint: "/validation/kyc/v1/pan_to_bank_account_linkage" };
    }
  },
  voter: {
    docs: ["Voter ID (EPIC)"], endpoint: "/validation/kyc/v1/voter",
    fields: [
      { key: "epic_number", label: "EPIC number", required: true, placeholder: "ABC1234567" },
      { key: "mobile", label: "Mobile (optional)", required: false },
      { key: "dob", label: "DOB (YYYY-MM-DD, optional)", required: false }
    ],
    run: async (i) => { const r = await ovdVerify("voter", { epicNumber: i.epic_number, mobile: i.mobile, dob: i.dob }); return { result: r.result, providerRef: r.providerRef, endpoint: r.endpoint }; }
  },
  passport: {
    docs: ["Passport"], endpoint: "/validation/kyc/v1/passport",
    fields: [
      { key: "file_number", label: "Passport file number", required: true, placeholder: "Z1234567" },
      { key: "dob", label: "DOB (YYYY-MM-DD)", required: false }
    ],
    run: async (i) => { const r = await ovdVerify("passport", { fileNumber: i.file_number, dob: i.dob }); return { result: r.result, providerRef: r.providerRef, endpoint: r.endpoint }; }
  },
  dl: {
    docs: ["Driving Licence"], endpoint: "/validation/kyc/v1/dl",
    fields: [
      { key: "dl_number", label: "DL number", required: true, placeholder: "MH01201234567" },
      { key: "dob", label: "DOB (YYYY-MM-DD, optional)", required: false }
    ],
    run: async (i) => { const r = await ovdVerify("dl", { dlNumber: i.dl_number, dob: i.dob }); return { result: r.result, providerRef: r.providerRef, endpoint: r.endpoint }; }
  },
  udid: {
    docs: ["UDID Card"], endpoint: "/validation/kyc/v1/udid",
    fields: [
      { key: "udid_number", label: "UDID number", required: true },
      { key: "mobile", label: "Mobile", required: false }
    ],
    run: async (i) => { const r = await ovdVerify("udid", { udidNumber: i.udid_number, mobile: i.mobile }); return { result: r.result, providerRef: r.providerRef, endpoint: r.endpoint }; }
  },
  pan_aadhaar_link: {
    docs: ["PAN Card", "Aadhaar"], endpoint: "/validation/kyc/v1/pan_aadhaar_link",
    fields: [
      { key: "pan", label: "PAN number", required: true, placeholder: "ABCPE1234F", hint: PAN_HINT },
      { key: "aadhaar", label: "Aadhaar number (check-only, never stored)", required: true, placeholder: "12 digits" }
    ],
    run: async (i) => { const r = await panAadhaarLink(i.pan, i.aadhaar); return { result: { linked: r.linked, rawStatus: r.rawStatus }, providerRef: r.providerRef, endpoint: "/validation/kyc/v1/pan_aadhaar_link" }; }
  },
  pan_to_masked_aadhaar: {
    docs: ["PAN Card"], endpoint: "/validation/kyc/v1/pan_to_masked_aadhaar",
    fields: [{ key: "pan", label: "PAN number", required: true, placeholder: "ABCPE1234F", hint: PAN_HINT }],
    run: async (i) => { const r = await panToMaskedAadhaar(i.pan); return { result: { maskedAadhaar: r.maskedAadhaar }, providerRef: r.providerRef, endpoint: "/validation/kyc/v1/pan_to_masked_aadhaar" }; }
  },
  aadhaar_to_masked_pan: {
    docs: ["Aadhaar"], endpoint: "/validation/kyc/v1/aadhaar_to_masked_pan",
    fields: [{ key: "aadhaar", label: "Aadhaar number (masked PAN returned; raw never stored)", required: true, placeholder: "12 digits" }],
    run: async (i) => { const r = await aadhaarToMaskedPan(i.aadhaar); return { result: { maskedPan: r.maskedPan }, providerRef: r.providerRef, endpoint: "/validation/kyc/v1/aadhaar_to_masked_pan" }; }
  },
  aadhaar_to_unmasked_pan: {
    docs: ["Aadhaar"], endpoint: "/validation/kyc/v1/aadhaar_to_unmasked_pan",
    fields: [
      { key: "aadhaar", label: "Aadhaar number", required: true, placeholder: "12 digits" },
      { key: "known_pan", label: "Known PAN (match check, optional)", required: false, placeholder: "ABCPE1234F" }
    ],
    run: async (i) => { const r = await aadhaarToUnmaskedPan(i.aadhaar, i.known_pan); return { result: { maskedPan: r.maskedPan, matchesKnownPan: r.matchesKnownPan }, providerRef: r.providerRef, endpoint: "/validation/kyc/v1/aadhaar_to_unmasked_pan" }; }
  }
};

const bodySchema = z.object({
  adapter: z.string().min(1),
  // The client may intentionally send null when no file/type was selected.
  // These are audit metadata only; the provider ID fields below remain the
  // actual verification inputs.
  doc_type: z.string().nullable().optional(),
  file_name: z.string().nullable().optional(),
  pan: z.string().optional(),
  name: z.string().optional(),
  dob: z.string().optional(),
  epic_number: z.string().optional(),
  file_number: z.string().optional(),
  dl_number: z.string().optional(),
  udid_number: z.string().optional(),
  aadhaar: z.string().optional(),
  account_number: z.string().optional(),
  ifsc: z.string().optional(),
  mobile: z.string().optional(),
  known_pan: z.string().optional()
});

/** Map a failure to a human reason, machine code and — crucially — its ORIGIN.
 *  A `local` DigitapError means our own format check rejected the input and the
 *  provider was never called; reporting that as "the provider rejected it" sends
 *  the user hunting for a provider problem that does not exist. */
function failureOf(e: unknown): { reason: string; errCode: string; origin: "input" | "provider" | "network"; hint?: string; providerMessage?: string } {
  if (!(e instanceof DigitapError)) {
    return { reason: (e as Error).message || "Verification failed", errCode: "NETWORK", origin: "network", hint: "The request never completed — retry, and check the API logs if it persists." };
  }
  if (e.local) {
    return {
      reason: e.message,
      errCode: "INVALID_INPUT",
      origin: "input",
      hint: "Nothing was sent to Digitap (0 ms) — correct this field and run again."
    };
  }
  const httpStatus = e.httpStatus;
  const reason =
    httpStatus === 400 ? "Payload rejected by provider — check the input format" :
    httpStatus === 401 ? "Provider authentication failed" :
    httpStatus === 403 ? "Provider blocked this server IP (403) — whitelist the egress IP with Digitap" :
    httpStatus === 412 ? "Product not enabled for this Digitap client — contact your RM" :
    httpStatus === 0 ? "Provider unreachable or timed out — try again" :
    e.message || "Verification failed at the provider";
  const errCode = e.resultCode ? String(e.resultCode) : `HTTP${httpStatus}`;
  return { reason, errCode, origin: httpStatus === 0 ? "network" : "provider", providerMessage: e.message || undefined };
}

/** GET /api/lab/adapters — everything the lab can test, with live row state. */
doclabRouter.get("/lab/adapters", requirePerm("admin.integrations"), asyncH(async (req: AuthedRequest, res) => {
  const rows = await q<Record<string, any>>("SELECT * FROM integrations WHERE tenant_id = ?", [req.user!.tenant_id]);
  const rowByCode = new Map(rows.map((r) => [r.code, r]));
  const list = Object.entries(LAB_ADAPTERS).map(([code, a]) => {
    const row = rowByCode.get(code);
    const cfg = row ? parseRowConfig(row as any) : {};
    const def = CATALOG_BY_CODE.get(code);
    return {
      code, name: def?.name ?? code, docs: a.docs, endpoint: a.endpoint, fields: a.fields,
      digitapProduct: def?.digitap?.product ?? null, digitapEnabled: def?.digitap?.enabled ?? false,
      rowState: row ? { mode: cfg.mode ?? "mock", lastTestOk: cfg.lastTestOk === true, status: row.status } : null
    };
  });
  const { env, creds } = digitapConfig();
  res.json({ adapters: list, env: { digitapEnv: env, credentialsConfigured: !!creds } });
}));

/** POST /api/lab/test — run one adapter against Digitap with the given inputs. */
doclabRouter.post("/lab/test", requirePerm("admin.integrations"), asyncH(async (req: AuthedRequest, res) => {
  const body = bodySchema.parse(req.body);
  const spec = LAB_ADAPTERS[body.adapter];
  if (!spec) { res.status(400).json({ error: `Unknown lab adapter: ${body.adapter}` }); return; }
  const missing = spec.fields.filter((f) => f.required && !(body as Record<string, any>)[f.key]);
  if (missing.length) { res.status(400).json({ error: `Missing required field(s): ${missing.map((f) => f.label).join(", ")}` }); return; }

  const { env, creds } = digitapConfig();
  if (!creds) { res.status(400).json({ error: "Digitap credentials are not configured on this server" }); return; }

  const t0 = Date.now();
  const fileRef = body.file_name || null;

  // Consent entry: running a test IS explicit consent for that single check.
  await saveConsentRecord({
    tenant_id: req.user!.tenant_id,
    purpose: `api_lab_test:${body.adapter}`,
    consent_version: "1.0",
    status: "active",
    captured_by: req.user!.id,
    channel: "api_test_lab",
    payload: { adapter: body.adapter, doc_type: body.doc_type ?? null, file_name: fileRef }
  });

  try {
    const { result, providerRef, endpoint } = await spec.run(body);
    const latencyMs = Date.now() - t0;
    const provider = `DIGITAP-${body.adapter.toUpperCase()}-${env.toUpperCase()}`;
    await audit({ tenantId: req.user!.tenant_id, userId: req.user!.id, action: "lab.test", entityType: "lab", after: { adapter: body.adapter, doc_type: body.doc_type ?? null, file_name: fileRef, provider, requestId: providerRef, latencyMs, ok: true }, ip: clientIp(req) });
    await logProviderRequest({ tenant_id: req.user!.tenant_id, user_id: req.user!.id, adapter: body.adapter, endpoint, request_ref: providerRef, provider_request_id: providerRef, status: "success", latency_ms: latencyMs });
    await saveVerificationResult({ tenant_id: req.user!.tenant_id, adapter: body.adapter, provider, status: "verified", result, provider_request_id: providerRef });
    res.json({ ok: true, adapter: body.adapter, docType: body.doc_type ?? null, fileName: fileRef, latencyMs, provider, endpoint, providerRef, result, env });
    return;
  } catch (e) {
    const latencyMs = Date.now() - t0;
    // Provider verdicts delivered over HTTP 200 (result_code 102 invalid /
    // 103 no-record) are VALID answers for a test lab — show them as results
    // instead of transport failures so the user sees exactly what Digitap said.
    if (e instanceof DigitapError && e.httpStatus === 200 && (e.resultCode === 102 || e.resultCode === 103)) {
      const provider = `DIGITAP-${body.adapter.toUpperCase()}-${env.toUpperCase()}`;
      const result = { result_code: e.resultCode, message: e.message, live: true, sandbox: false };
      await audit({ tenantId: req.user!.tenant_id, userId: req.user!.id, action: "lab.test", entityType: "lab", after: { adapter: body.adapter, doc_type: body.doc_type ?? null, file_name: fileRef, provider, resultCode: e.resultCode, latencyMs, ok: true }, ip: clientIp(req) });
      await logProviderRequest({ tenant_id: req.user!.tenant_id, user_id: req.user!.id, adapter: body.adapter, endpoint: spec.endpoint, status: "success", latency_ms: latencyMs });
      res.json({ ok: true, adapter: body.adapter, docType: body.doc_type ?? null, fileName: fileRef, latencyMs, provider, endpoint: spec.endpoint, providerRef: `rc${e.resultCode}-${Date.now()}`, result, env });
      return;
    }
    const { reason, errCode, origin, hint, providerMessage } = failureOf(e);
    await audit({ tenantId: req.user!.tenant_id, userId: req.user!.id, action: "lab.test_failed", entityType: "lab", after: { adapter: body.adapter, doc_type: body.doc_type ?? null, file_name: fileRef, reason, errCode, origin, latencyMs, ok: false }, ip: clientIp(req) });
    await logProviderRequest({ tenant_id: req.user!.tenant_id, user_id: req.user!.id, adapter: body.adapter, endpoint: spec.endpoint, status: "failed", error_code: errCode, latency_ms: latencyMs });
    res.status(origin === "input" ? 400 : 422).json({ ok: false, error: reason, code: errCode, origin, hint, providerMessage, provider: `DIGITAP-${body.adapter.toUpperCase()}`, endpoint: spec.endpoint, latencyMs, env });
    return;
  }
}));