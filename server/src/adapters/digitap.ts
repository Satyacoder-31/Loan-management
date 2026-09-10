/**
 * Digitap API client — server-side only. Credentials never leave the process
 * environment. Implements the endpoints documented in Digitap's KYC Validation
 * API Suite (v4.91 — docs/KYC-Validation-API-Suite-v4.91.pdf):
 *
 *   KYC      POST /validation/kyc/v1|v2/pan_basic            (PAN Basic V1/V2)
 *            POST /validation/kyc/v1/pan_details             (full profile)
 *            POST /validation/kyc/v1/pan_details_bc          (PAN Basic V1-compatible)
 *            POST /validation/kyc/v1/pan_details_plus        (extended profile)
 *            POST /validation/kyc/v1/form206ab_compliance_stat
 *            POST /validation/kyc/v1/itr_basic               (ITR filing status)
 *            POST /validation/kyc/v1/pan_to_name
 *            POST /validation/kyc/v1/pan_to_fname
 *            POST /validation/kyc/v1/pan_profile
 *            POST /validation/kyc/v1/pan_aadhaar_link
 *            POST /validation/kyc/v1/pan_to_masked_aadhaar
 *            POST /validation/kyc/v1/aadhaar_to_masked_pan
 *            POST /validation/kyc/v1/aadhaar_to_unmasked_pan (consent-gated)
 *            POST /validation/kyc/v1/voter
 *            POST /validation/kyc/v1/passport
 *            POST /validation/kyc/v1/dl
 *            POST /validation/kyc/v1/dl_plus
 *            POST /validation/kyc/v1/kyc_udid_verification
 *   MISC     POST /validation/misc/v1/pan-account-linkage
 *
 * Auth: HTTP Basic (client_id:client_secret). Billable only on HTTP 200.
 * Envelope: { http_response_code, client_ref_num, request_id, result_code, result?, message?, error? }
 * result_code: 101 = valid, 102 = invalid/event, 103 = not found.
 *
 * SECURITY RULES (project brief):
 *   - Only MASKED identifiers (PAN `ABCP****4F`, Digitap-masked Aadhaar) may
 *     reach normalized results / API responses / Supabase mirrors.
 *   - Raw Aadhaar may be forwarded to Digitap for linkage checks but is never
 *     logged, never persisted, never returned.
 *   - Provider mobile/email from PAN Details are masked before normalization.
 */

import type { AdapterResult, PanVerification } from "./types.js";

export type DigitapEnv = "uat" | "prod";

export interface DigitapCredentials {
  clientId: string;
  clientSecret: string;
}

export const PAN_REGEX = /^[A-Z]{3}[ABCFGHLJPTE][A-Z][0-9]{4}[A-Z]$/;
/** Aadhaar: 12 digits (Verhoeff check is Digitap's job — we gate format only). */
export const AADHAAR_REGEX = /^\d{12}$/;
/** Voter ID EPIC per doc §13.3. */
export const EPIC_REGEX = /^(([a-zA-Z]{3}\/?\d{6,15})|([a-zA-Z]{2}\/\d{1,3}\/\d{2,3}\/\d{6,7})|([a-zA-Z]{2}\d{10,12}))$/;
/** Driving licence per doc §18.3. */
export const DL_REGEX = /^[a-zA-Z0-9/]{13,25}$/;
/** UDID per doc §20.3 (2 letters + 16 digits). */
export const UDID_REGEX = /^[A-Za-z]{2}\d{16}$/;
/** IFSC per doc §12.3. */
export const IFSC_REGEX = /^[A-Za-z]{4}0\d{6}$/;

export function digitapConfig(): { env: DigitapEnv; creds: DigitapCredentials | null } {
  const env: DigitapEnv = process.env.DIGITAP_ENV === "prod" ? "prod" : "uat";
  const clientId = (env === "prod" ? process.env.DIGITAP_PROD_CLIENT_ID : process.env.DIGITAP_UAT_CLIENT_ID) || "";
  const clientSecret = (env === "prod" ? process.env.DIGITAP_PROD_CLIENT_SECRET : process.env.DIGITAP_UAT_CLIENT_SECRET) || "";
  const creds = clientId && clientSecret ? { clientId, clientSecret } : null;
  return { env, creds };
}

export function digitapBaseUrl(env: DigitapEnv): string {
  return env === "prod" ? "https://svc.digitap.ai" : "https://svcdemo.digitap.work";
}

export function normalizePan(pan: string): string {
  return (pan || "").trim().toUpperCase();
}

export function maskPan(pan: string): string {
  const p = normalizePan(pan);
  if (p.length !== 10) return "*****";
  return `${p.slice(0, 4)}****${p.slice(8)}`;
}

/** Mask a provider-sourced mobile so raw values never enter CRM records. */
export function maskMobile(m: string | null | undefined): string {
  const digits = (m || "").replace(/\D/g, "");
  if (digits.length < 4) return "";
  return `XXXXXX${digits.slice(-4)}`;
}

/** Mask a provider-sourced email: keep domain, hide the local part. */
export function maskEmail(e: string | null | undefined): string {
  const s = (e || "").trim();
  const at = s.indexOf("@");
  if (at <= 0) return "";
  return `${s[0]}***@${s.slice(at + 1)}`;
}

/** Normalize a DOB into Digitap's DD/MM/YYYY contract (accepts ISO + IN formats). */
export function toDigitapDob(dob: string | null | undefined): string | null {
  if (!dob) return null;
  const d = dob.trim();
  const iso = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const ddmm = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmm) {
    const dd = ddmm[1].padStart(2, "0");
    const mm = ddmm[2].padStart(2, "0");
    return `${dd}/${mm}/${ddmm[3]}`;
  }
  return null;
}

export class DigitapError extends Error {
  httpStatus: number;
  resultCode: number | null;
  constructor(httpStatus: number, message: string, resultCode: number | null = null) {
    super(message);
    this.httpStatus = httpStatus;
    this.resultCode = resultCode;
  }
}

interface DigitapEnvelope {
  http_response_code?: number;
  http_status_code?: number;
  client_ref_num?: string;
  request_id?: string;
  result_code?: number;
  message?: string;
  error?: string;
  result?: Record<string, any> | Record<string, any>[];
}

const REQUEST_TIMEOUT_MS = 20_000;
const AUTH_ERR = "Client authentication failed";
const IP_ERR = "Forbidden: IP not allowed — whitelist this server's egress IP with Digitap";
const NOT_ENABLED_ERR = "Feature is not enabled for this client — contact your Digitap RM";

export const AUTH_ERR_MSG = AUTH_ERR;
export const IP_ERR_MSG = IP_ERR;
export const NOT_ENABLED_ERR_MSG = NOT_ENABLED_ERR;

/**
 * POST to a Digitap endpoint with Basic auth. Retried only for network errors
 * and HTTP 5xx (never on 4xx — those are never transient). Timeout 20s.
 */
async function post<T extends DigitapEnvelope = DigitapEnvelope>(
  creds: DigitapCredentials,
  path: string,
  body: Record<string, unknown>,
  attempts = 2
): Promise<{ envelope: T; httpStatus: number }> {
  const url = digitapBaseUrl(process.env.DIGITAP_ENV === "prod" ? "prod" : "uat") + path;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Basic " + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      const text = await res.text();
      let envelope: T;
      try {
        envelope = JSON.parse(text) as T;
      } catch {
        envelope = {} as T;
      }
      if (res.status >= 500 && attempt < attempts) {
        lastErr = new DigitapError(res.status, `Digitap temporary failure (HTTP ${res.status})`);
        continue;
      }
      return { envelope, httpStatus: res.status };
    } catch (e) {
      lastErr = e;
      if (attempt < attempts) continue;
      throw new DigitapError(0, `Digitap unreachable: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof DigitapError ? lastErr : new DigitapError(0, String(lastErr));
}

/** Throws a safe DigitapError for non-2xx HTTP responses. */
function assertHttpOk(httpStatus: number, envelope: DigitapEnvelope): void {
  if (httpStatus === 401) throw new DigitapError(401, envelope.message || AUTH_ERR);
  if (httpStatus === 403) throw new DigitapError(403, IP_ERR);
  if (httpStatus === 412) throw new DigitapError(412, NOT_ENABLED_ERR);
  if (httpStatus === 400) throw new DigitapError(400, envelope.error || "One or more parameters format is wrong");
  if (httpStatus === 422) throw new DigitapError(422, "Digitap source is unable to fetch the response right now");
  if (httpStatus === 429) throw new DigitapError(429, "Digitap rate limit exceeded — retry shortly");
  if (httpStatus !== 200) throw new DigitapError(httpStatus, envelope.message || envelope.error || `Digitap HTTP ${httpStatus}`);
}

/** Shared result_code gate: 101 valid; 102 invalid/event; 103 not found.
 * 109 is ITR-specific "no filing records for the search period" (valid, empty). */
const NO_RECORD_CODES = new Set([103, 109]);
function assertResultOk(envelope: DigitapEnvelope): Record<string, any> | Record<string, any>[] {
  const rc = envelope.result_code;
  if (rc === 102) throw new DigitapError(200, "Invalid ID number or combination of inputs", 102);
  if (rc === 103) throw new DigitapError(200, "No record found for the given input", 103);
  if (rc === 109) return Array.isArray(envelope.result) ? envelope.result : {}; // no ITR records — valid empty
  if (rc !== 101) throw new DigitapError(200, envelope.message || `Unexpected result_code ${rc ?? "—"}`, rc ?? null);
  return envelope.result ?? {};
}

function clientRef(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`.slice(0, 45);
}

async function requireCreds() {
  const { creds } = digitapConfig();
  if (!creds) throw new DigitapError(0, "Digitap credentials are not configured (DIGITAP_*_CLIENT_ID/SECRET)");
  return creds;
}

/* ============================================================
 * PAN Basic V1/V2 (existing behaviour, preserved)
 * ============================================================ */

export interface PanVerifyInput {
  pan: string;
  name?: string | null;
  dob?: string | null;
  /** "fuzzy" | "exact" | "dg_name_match" (V1 only) */
  nameMatchMethod?: string;
  /** V2 adds DOB match; falls back to V1 automatically when V2 is not enabled */
  v2?: boolean;
}

export async function panVerify(input: PanVerifyInput): Promise<{ result: PanVerification; providerRef: string }> {
  const creds = await requireCreds();
  const pan = normalizePan(input.pan);
  if (!PAN_REGEX.test(pan)) throw new DigitapError(400, "Invalid PAN format");

  const refNum = clientRef("snpr");
  const useV2 = !!input.v2 && !!input.dob && !!input.name;

  let path = `/validation/kyc/v1/pan_basic`;
  let payload: Record<string, unknown> = { client_ref_num: refNum, pan };
  if (useV2) {
    path = `/validation/kyc/v2/pan_basic`;
    // Digitap requires DOB as DD/MM/YYYY (single slash format) — the UI/CRM
    // stores ISO dates, so convert before sending.
    payload = { client_ref_num: refNum, pan, name: input.name, dob: toDigitapDob(input.dob) ?? input.dob };
  } else if (input.name) {
    payload.name = input.name;
    if (input.nameMatchMethod) payload.name_match_method = input.nameMatchMethod;
  }

  const { envelope, httpStatus } = await post(creds, path, payload);
  assertHttpOk(httpStatus, envelope);
  const requestId = envelope.request_id || envelope.client_ref_num || refNum;
  const r = assertResultOk(envelope) as Record<string, any>;

  if (useV2) {
    // V2: name / dob are match flags Y/N; status comes from status_code.
    const statusCode = String(r.status_code || (r.status === "Active" ? "E" : "N"));
    const active = r.status === "Active" || statusCode === "E" || String(statusCode).startsWith("E");
    return {
      providerRef: requestId,
      result: {
        panMasked: maskPan(pan),
        panStatus: active ? "Active" : "Invalid",
        statusCode,
        nameMatch: r.name === "Y" ? true : r.name === "N" ? false : null,
        nameMatchScore: r.name === "Y" ? 100 : r.name === "N" ? 0 : null,
        dobMatch: r.dob === "Y" ? true : r.dob === "N" ? false : null,
        seedingStatus: r.seeding_status || "",
        nameFromPan: "",
        panDisplayName: ""
      }
    };
  }

  // V1: status field is Active/Invalid; result may include name + display name.
  const active = r.status === "Active";
  const nameMatch = typeof r.name_match === "boolean" ? r.name_match : null;
  const nameScore = typeof r.name_match_score === "number" ? r.name_match_score : null;
  return {
    providerRef: requestId,
    result: {
      panMasked: maskPan(pan),
      panStatus: active ? "Active" : "Invalid",
      statusCode: active ? "E" : "N",
      nameMatch,
      nameMatchScore: nameScore,
      dobMatch: null,
      seedingStatus: r.seeding_status || "",
      nameFromPan: r.name || "",
      panDisplayName: r.pan_display_name || ""
    }
  };
}

export { AUTH_ERR };

/** Map normalized pan verification to AdapterResult used by routes + hub. */
export function panAdapterResult(pan: string, v: PanVerification, providerRef: string, latencyMs: number, env: DigitapEnv): AdapterResult {
  return {
    ok: v.panStatus === "Active",
    status: v.panStatus === "Active" ? "verified" : "invalid",
    message: v.panStatus === "Active" ? "PAN verified — active on the NSDL/ITD database" : "PAN is invalid / inactive on the ITD database",
    provider: `DIGITAP-PAN-BASIC-${env.toUpperCase()}`,
    providerRef,
    latencyMs,
    data: {
      panMasked: maskPan(pan),
      panStatus: v.panStatus,
      statusCode: v.statusCode,
      nameMatch: v.nameMatch,
      nameMatchScore: v.nameMatchScore,
      dobMatch: v.dobMatch,
      seedingStatus: v.seedingStatus,
      nameFromPan: v.nameFromPan,
      panDisplayName: v.panDisplayName
    }
  };
}

/* ============================================================
 * PAN Details / Details Plus — full profile (doc §5, §6)
 * ============================================================ */

export interface PanDetailsInput {
  pan: string;
  /** return father's name (flag "true"/"false" as string, per doc) */
  fatherName?: boolean;
  /** return the name displayed on the PAN */
  panDisplayName?: boolean;
  /** name to match against the PAN record */
  name?: string | null;
  nameMatchMethod?: "fuzzy" | "exact" | "dg_name_match";
  /** use the V1-compatible endpoint (pan_details_bc) */
  backwardCompatible?: boolean;
  /** use pan_details_plus */
  plus?: boolean;
}

export interface PanDetailsResult {
  panMasked: string;
  panType: string;
  fullName: string;
  firstName: string;
  middleName: string;
  lastName: string;
  fatherName: string;
  panDisplayName: string;
  gender: string;
  dob: string;
  aadhaarSeedingStatus: string;
  aadhaarNumberMasked: string;
  aadhaarLinked: boolean | null;
  mobileMasked: string;
  emailMasked: string;
  address: Record<string, string> | null;
  nameMatch: boolean | null;
  nameMatchScore: number | null;
}

type RawPanDetails = Record<string, any>;

function normalizePanDetails(pan: string, r: RawPanDetails): PanDetailsResult {
  const addr = r.address && typeof r.address === "object" ? (r.address as Record<string, any>) : null;
  const address: Record<string, string> | null = addr
    ? Object.fromEntries(
        ["building_name", "locality", "street_name", "pincode", "city", "state", "country"]
          .map((k) => [k, String(addr[k] ?? "")])
          .filter(([, v]) => v !== "")
      )
    : null;
  return {
    panMasked: maskPan(pan),
    panType: String(r.pan_type ?? ""),
    fullName: String(r.fullname ?? ""),
    firstName: String(r.first_name ?? ""),
    middleName: String(r.middle_name ?? ""),
    lastName: String(r.last_name ?? ""),
    fatherName: String(r.father_name ?? ""),
    panDisplayName: String(r.pan_display_name ?? ""),
    gender: String(r.gender ?? ""),
    dob: String(r.dob ?? ""),
    aadhaarSeedingStatus: String(r.aadhaar_seeding_status ?? ""),
    // Digitap masks the aadhaar number itself (XXXXXXXX1234 / 12XXXXXXXX34).
    aadhaarNumberMasked: String(r.aadhaar_number ?? ""),
    aadhaarLinked: typeof r.aadhaar_linked === "boolean" ? r.aadhaar_linked : null,
    mobileMasked: maskMobile(r.mobile),
    emailMasked: maskEmail(r.email),
    address,
    nameMatch: typeof r.name_match === "boolean" ? r.name_match : null,
    nameMatchScore: typeof r.name_match_score === "number" ? r.name_match_score : null
  };
}

export async function panDetails(input: PanDetailsInput): Promise<{ result: PanDetailsResult; providerRef: string; endpoint: string }> {
  const creds = await requireCreds();
  const pan = normalizePan(input.pan);
  if (!PAN_REGEX.test(pan)) throw new DigitapError(400, "Invalid PAN format");

  const path = input.plus
    ? "/validation/kyc/v1/pan_details_plus"
    : input.backwardCompatible
      ? "/validation/kyc/v1/pan_details_bc"
      : "/validation/kyc/v1/pan_details";
  const payload: Record<string, unknown> = { client_ref_num: clientRef("snpr"), pan };
  if (input.fatherName != null) payload.father_name = input.fatherName ? "true" : "false";
  if (input.panDisplayName != null) payload.pan_display_name = input.panDisplayName ? "true" : "false";
  if (input.name) {
    payload.name = input.name;
    payload.name_match_method = input.nameMatchMethod ?? "fuzzy";
  }

  const { envelope, httpStatus } = await post(creds, path, payload);
  assertHttpOk(httpStatus, envelope);
  const r = assertResultOk(envelope) as RawPanDetails;
  return { result: normalizePanDetails(pan, r), providerRef: envelope.request_id || String(payload.client_ref_num), endpoint: path };
}

/* ============================================================
 * PAN 206AB compliance (doc §7)
 * ============================================================ */

export interface Compliance206abResult {
  panMasked: string;
  specifiedPerson: boolean | null;
  operativeStatus: string;
  finYear: string;
  panAllotmentDate: string;
}

export async function pan206abCompliance(pan: string): Promise<{ result: Compliance206abResult; providerRef: string }> {
  const creds = await requireCreds();
  const p = normalizePan(pan);
  if (!PAN_REGEX.test(p)) throw new DigitapError(400, "Invalid PAN format");
  const { envelope, httpStatus } = await post(creds, "/validation/kyc/v1/form206ab_compliance_status", { client_ref_num: clientRef("snpr"), pan: p });
  assertHttpOk(httpStatus, envelope);
  const r = assertResultOk(envelope) as Record<string, any>;
  return {
    providerRef: envelope.request_id || "",
    result: {
      panMasked: maskPan(p),
      specifiedPerson: r.specified_person === "Y" ? true : r.specified_person === "N" ? false : null,
      operativeStatus: String(r.pan_operative_status ?? ""),
      finYear: String(r.fin_year ?? ""),
      panAllotmentDate: String(r.pan_allotment_date ?? "")
    }
  };
}

/* ============================================================
 * PAN ITR status (doc §8) — result is an array of filings
 * ============================================================ */

export interface ItrFiling {
  assessmentYear: string;
  formType: string;
  filingType: string;
  ackNum: string;
  eFilingStatus: string;
  filingDate: string;
  refundAmount: string;
}

function normalizeItr(r: Record<string, any>[]): ItrFiling[] {
  if (!Array.isArray(r)) return [];
  return r.map((f) => ({
    assessmentYear: String(f.assessment_year ?? ""),
    formType: String(f.form_type ?? ""),
    filingType: String(f.filing_type ?? ""),
    ackNum: String(f.ack_num ?? ""),
    eFilingStatus: String(f.e_filing_status ?? ""),
    filingDate: String(f.filing_date ?? ""),
    refundAmount: String(f.refund_amount ?? "")
  }));
}

export async function panItrStatus(pan: string): Promise<{ result: ItrFiling[]; providerRef: string }> {
  const creds = await requireCreds();
  const p = normalizePan(pan);
  if (!PAN_REGEX.test(p)) throw new DigitapError(400, "Invalid PAN format");
  const { envelope, httpStatus } = await post(creds, "/validation/kyc/v1/itr_basic", { client_ref_num: clientRef("snpr"), pan: p });
  assertHttpOk(httpStatus, envelope);
  const r = assertResultOk(envelope);
  return { providerRef: envelope.request_id || "", result: normalizeItr(Array.isArray(r) ? r : []) };
}

/* ============================================================
 * PAN → Name / Father's name (doc §9, §10)
 * ============================================================ */

export async function panToName(pan: string): Promise<{ fullName: string; providerRef: string }> {
  const creds = await requireCreds();
  const p = normalizePan(pan);
  if (!PAN_REGEX.test(p)) throw new DigitapError(400, "Invalid PAN format");
  const { envelope, httpStatus } = await post(creds, "/validation/kyc/v1/pan_to_name", { client_ref_num: clientRef("snpr"), pan: p });
  assertHttpOk(httpStatus, envelope);
  const r = assertResultOk(envelope) as Record<string, any>;
  return { fullName: String(r.full_name ?? r.name ?? r.fullname ?? ""), providerRef: envelope.request_id || "" };
}

export async function panToFatherName(pan: string): Promise<{ fatherName: string; providerRef: string }> {
  const creds = await requireCreds();
  const p = normalizePan(pan);
  if (!PAN_REGEX.test(p)) throw new DigitapError(400, "Invalid PAN format");
  const { envelope, httpStatus } = await post(creds, "/validation/kyc/v1/pan_to_fname", { client_ref_num: clientRef("snpr"), pan: p });
  assertHttpOk(httpStatus, envelope);
  const r = assertResultOk(envelope) as Record<string, any>;
  return { fatherName: String(r.father_name ?? r.father_full_name ?? r.full_name ?? ""), providerRef: envelope.request_id || "" };
}

/* ============================================================
 * PAN Profile (doc §11) — rich profile, individual PANs (P) only
 * ============================================================ */

export async function panProfile(pan: string): Promise<{ result: PanDetailsResult; providerRef: string }> {
  const creds = await requireCreds();
  const p = normalizePan(pan);
  if (!PAN_REGEX.test(p)) throw new DigitapError(400, "Invalid PAN format");
  if (p[3] !== "P") throw new DigitapError(400, "PAN Profile is available for individual PANs only");
  const { envelope, httpStatus } = await post(creds, "/validation/kyc/v1/pan_profile", { client_ref_num: clientRef("snpr"), pan: p });
  assertHttpOk(httpStatus, envelope);
  const r = assertResultOk(envelope) as RawPanDetails;
  return { result: normalizePanDetails(p, r), providerRef: envelope.request_id || "" };
}

/* ============================================================
 * PAN ↔ Account linkage (doc §12, misc suite)
 * ============================================================ */

export interface PanAccountLinkResult {
  linked: boolean | null;
  rawStatus: string;
  bankRef: string;
}

export async function panAccountLink(pan: string, accountNumber: string, ifsc: string): Promise<{ result: PanAccountLinkResult; providerRef: string }> {
  const creds = await requireCreds();
  const p = normalizePan(pan);
  const acct = (accountNumber || "").trim();
  const ifscN = (ifsc || "").trim().toUpperCase();
  if (!PAN_REGEX.test(p)) throw new DigitapError(400, "Invalid PAN format");
  if (!/^\d{9,18}$/.test(acct)) throw new DigitapError(400, "Invalid account number (9-18 digits)");
  if (!IFSC_REGEX.test(ifscN)) throw new DigitapError(400, "Invalid IFSC code");
  const { envelope, httpStatus } = await post(creds, "/validation/misc/v1/pan-account-linkage", {
    client_ref_num: clientRef("snpr"), pan: p, account_number: acct, ifsc_code: ifscN
  });
  assertHttpOk(httpStatus, envelope);
  const r = assertResultOk(envelope) as Record<string, any>;
  const rawStatus = String(r.linkage_status ?? r.status ?? "");
  const linked = typeof r.is_linked === "boolean" ? r.is_linked : rawStatus ? rawStatus.toLowerCase() === "linked" || rawStatus.toLowerCase() === "yes" : null;
  return { providerRef: envelope.request_id || "", result: { linked, rawStatus, bankRef: String(r.bank_code ?? "") } };
}

/* ============================================================
 * OVD set: Voter ID / Passport / DL / DL Plus / UDID (doc §13,14,18,19,20)
 * ============================================================ */

export type OvdKind = "voter" | "passport" | "dl" | "dl_plus" | "udid";

export interface OvdResult {
  kind: OvdKind;
  status: string;
  fields: Record<string, string | number | boolean | null>;
}

/** Keep only scalar, non-sensitive fields from an OVD result. */
function normalizeOvd(kind: OvdKind, r: Record<string, any>): OvdResult {
  const fields: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(r)) {
    if (v == null || ["object", "function"].includes(typeof v)) continue;
    if (/aadhaar(?!_linked)/i.test(k)) continue; // never carry Aadhaar keys
    fields[k] = typeof v === "number" || typeof v === "boolean" ? v : String(v).slice(0, 200);
  }
  const status = String(fields.status ?? fields.epic_status ?? fields.dl_status ?? "").trim();
  return { kind, status, fields };
}

export async function ovdVerify(kind: OvdKind, params: { epicNumber?: string; fileNumber?: string; dlNumber?: string; udidNumber?: string; mobile?: string; dob?: string | null }): Promise<{ result: OvdResult; providerRef: string; endpoint: string }> {
  const creds = await requireCreds();
  const clientRefNum = clientRef("snpr");
  let path: string;
  let payload: Record<string, unknown>;

  if (kind === "voter") {
    const epic = (params.epicNumber || "").trim().toUpperCase();
    if (!EPIC_REGEX.test(epic)) throw new DigitapError(400, "Invalid Voter ID (EPIC) format");
    path = "/validation/kyc/v1/voter";
    payload = { client_ref_num: clientRefNum, epic_number: epic };
  } else if (kind === "passport") {
    const file = (params.fileNumber || "").trim();
    const dob = toDigitapDob(params.dob);
    if (!file || file.length > 30) throw new DigitapError(400, "Invalid passport file number");
    if (!dob) throw new DigitapError(400, "DOB is required (DD/MM/YYYY)");
    path = "/validation/kyc/v1/passport";
    payload = { client_ref_num: clientRefNum, file_number: file, dob };
  } else if (kind === "dl" || kind === "dl_plus") {
    const dl = (params.dlNumber || "").trim().toUpperCase();
    const dob = toDigitapDob(params.dob);
    if (!DL_REGEX.test(dl)) throw new DigitapError(400, "Invalid driving licence number format");
    if (!dob) throw new DigitapError(400, "DOB is required (DD/MM/YYYY)");
    path = kind === "dl" ? "/validation/kyc/v1/dl" : "/validation/kyc/v1/dl_plus";
    payload = { client_ref_num: clientRefNum, dl_number: dl, dob };
  } else {
    const udid = (params.udidNumber || "").trim().toUpperCase();
    const mob = (params.mobile || "").replace(/\D/g, "");
    if (!UDID_REGEX.test(udid) && !mob) throw new DigitapError(400, "UDID (2 letters + 16 digits) or linked mobile is required");
    const dob = toDigitapDob(params.dob);
    path = "/validation/kyc/v1/kyc_udid_verification";
    payload = { client_ref_num: clientRefNum } as Record<string, unknown>;
    if (udid) payload.udid_number = udid;
    if (mob) payload.Mobile_number = mob;
    if (dob) payload.DOB = dob;
  }

  const { envelope, httpStatus } = await post(creds, path, payload);
  assertHttpOk(httpStatus, envelope);
  const r = assertResultOk(envelope) as Record<string, any>;
  return { result: normalizeOvd(kind, r), providerRef: envelope.request_id || clientRefNum, endpoint: path };
}

/* ============================================================
 * PAN ↔ Aadhaar mapping family (doc §15–17, §21)
 * ============================================================ */

export async function panAadhaarLink(pan: string, aadhaar: string): Promise<{ linked: boolean | null; rawStatus: string; providerRef: string }> {
  const creds = await requireCreds();
  const p = normalizePan(pan);
  const a = (aadhaar || "").trim();
  if (!PAN_REGEX.test(p)) throw new DigitapError(400, "Invalid PAN format");
  if (!AADHAAR_REGEX.test(a)) throw new DigitapError(400, "Invalid Aadhaar format (12 digits)");
  const { envelope, httpStatus } = await post(creds, "/validation/kyc/v1/pan_aadhaar_link", { client_ref_num: clientRef("snpr"), pan: p, aadhaar: a });
  assertHttpOk(httpStatus, envelope);
  const r = assertResultOk(envelope) as Record<string, any>;
  const raw = String(r.aadhaar_link_status ?? r.linkage_status ?? r.status ?? "");
  const linked = typeof r.aadhaar_linked === "boolean" ? r.aadhaar_linked : raw ? raw.toLowerCase() === "linked" || raw.toLowerCase() === "yes" : null;
  // NOTE: raw Aadhaar is forwarded to Digitap but never logged or persisted.
  return { linked, rawStatus: raw, providerRef: envelope.request_id || "" };
}

export async function panToMaskedAadhaar(pan: string): Promise<{ maskedAadhaar: string; providerRef: string }> {
  const creds = await requireCreds();
  const p = normalizePan(pan);
  if (!PAN_REGEX.test(p)) throw new DigitapError(400, "Invalid PAN format");
  const { envelope, httpStatus } = await post(creds, "/validation/kyc/v1/pan_to_masked_aadhaar", { client_ref_num: clientRef("snpr"), pan: p });
  assertHttpOk(httpStatus, envelope);
  const r = assertResultOk(envelope) as Record<string, any>;
  return { maskedAadhaar: String(r.aadhaar_number ?? r.masked_aadhaar ?? ""), providerRef: envelope.request_id || "" };
}

export async function aadhaarToMaskedPan(aadhaar: string): Promise<{ maskedPan: string; providerRef: string }> {
  const creds = await requireCreds();
  const a = (aadhaar || "").trim();
  if (!AADHAAR_REGEX.test(a)) throw new DigitapError(400, "Invalid Aadhaar format (12 digits)");
  const { envelope, httpStatus } = await post(creds, "/validation/kyc/v1/aadhaar_to_masked_pan", { client_ref_num: clientRef("snpr"), aadhaar: a });
  assertHttpOk(httpStatus, envelope);
  const r = assertResultOk(envelope) as Record<string, any>;
  return { maskedPan: String(r.pan ?? r.masked_pan ?? ""), providerRef: envelope.request_id || "" };
}

/**
 * Aadhaar → PAN recovery. Per the masking rule the FULL PAN never leaves the
 * backend: callers receive the masked PAN plus an optional match flag against
 * a known PAN. Use only inside the consent flow.
 */
export async function aadhaarToUnmaskedPan(aadhaar: string, knownPan?: string | null): Promise<{ maskedPan: string; matchesKnownPan: boolean | null; providerRef: string }> {
  const creds = await requireCreds();
  const a = (aadhaar || "").trim();
  if (!AADHAAR_REGEX.test(a)) throw new DigitapError(400, "Invalid Aadhaar format (12 digits)");
  const { envelope, httpStatus } = await post(creds, "/validation/kyc/v1/aadhaar_to_unmasked_pan", { client_ref_num: clientRef("snpr"), aadhaar: a });
  assertHttpOk(httpStatus, envelope);
  const r = assertResultOk(envelope) as Record<string, any>;
  const full = String(r.pan ?? "");
  const masked = full ? maskPan(full) : String(r.masked_pan ?? "");
  const matchesKnownPan = knownPan && full ? normalizePan(knownPan) === normalizePan(full) : null;
  return { maskedPan: masked, matchesKnownPan, providerRef: envelope.request_id || "" };
}

/* ============================================================
 * Connection probes — one per hub adapter, all synthetic payloads.
 * Format-valid, non-existent inputs: UAT answers HTTP 200 + result_code
 * 102/103 (never a real profile) when credentials + entitlement are good.
 * HTTP 401 = bad credentials · 403 = egress IP not whitelisted ·
 * 412 = product not enabled. Probes never run against production unless
 * DIGITAP_ALLOW_PROD_PROBE=true.
 * ============================================================ */

export interface ProbeResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  auth: boolean;
  enabled: boolean;
}

/** Shared synthetic probe inputs (format-valid, non-existent records). */
const SYNTH = {
  pan: "ZZZPE0000Z", // 4th char P = individual, not a real PAN
  aadhaar: "999999999999", // 12 digits, Verhoeff-invalid
  epic: "ZZZ0000000", // voter pattern: 3 letters + 6 digits
  passportFile: "Z0000000",
  dl: "ZZ00000000000", // 13 chars alnum
  udid: "ZZ0000000000000000", // 2 letters + 16 digits
  dob: "01/01/1990"
} as const;

/** Raw probe — returns HTTP status + result_code for discovery reporting. */
export async function probeRaw(path: string, payload: Record<string, unknown>): Promise<{ httpStatus: number; resultCode: number | null; message: string; latencyMs: number }> {
  const t0 = Date.now();
  const { creds } = digitapConfig();
  if (!creds) throw new DigitapError(0, "Digitap credentials are not configured");
  const { envelope, httpStatus } = await post(creds, path, { client_ref_num: `probe-${Date.now()}`, ...payload }, 1);
  return { httpStatus, resultCode: envelope.result_code ?? null, message: envelope.message || envelope.error || "", latencyMs: Date.now() - t0 };
}

export async function probeEndpoint(path: string, payload: Record<string, unknown>): Promise<ProbeResult> {
  const { env, creds } = digitapConfig();
  const t0 = Date.now();
  if (!creds) {
    return { ok: false, message: "Digitap credentials not configured — add DIGITAP_UAT_CLIENT_ID/SECRET (or PROD) to server/.env", latencyMs: 0, auth: false, enabled: false };
  }
  if (env === "prod" && process.env.DIGITAP_ALLOW_PROD_PROBE !== "true") {
    return { ok: false, message: "Production probe disabled — exercise this product through a real consent flow instead (set DIGITAP_ALLOW_PROD_PROBE=true to override)", latencyMs: 0, auth: true, enabled: true };
  }
  try {
    const { envelope, httpStatus } = await post(creds, path, { client_ref_num: `probe-${Date.now()}`, ...payload }, 1);
    const latencyMs = Date.now() - t0;
    if (httpStatus === 200 && [101, 102, 103, 109].includes(envelope.result_code as number)) {
      return { ok: true, message: `Digitap ${env.toUpperCase()} reachable — credentials OK, product enabled`, latencyMs, auth: true, enabled: true };
    }
    if (httpStatus === 503) return { ok: false, message: "Digitap source temporarily busy / in maintenance (HTTP 503) — credentials accepted, retry the Test shortly", latencyMs, auth: true, enabled: true };
    if (httpStatus === 401) return { ok: false, message: "Digitap authentication failed — wrong client_id/secret for this environment", latencyMs, auth: false, enabled: false };
    if (httpStatus === 403) return { ok: false, message: IP_ERR, latencyMs, auth: false, enabled: false };
    if (httpStatus === 412) return { ok: false, message: `Digitap reports this product is not enabled for client ${creds.clientId} — contact your RM`, latencyMs, auth: true, enabled: false };
    if (httpStatus === 400) return { ok: false, message: "Probe payload rejected (HTTP 400) — endpoint reachable but verify the request contract", latencyMs, auth: false, enabled: false };
    if (httpStatus === 422) return { ok: false, message: "Digitap source temporarily unable to fetch (HTTP 422) — auth OK, retry the Test", latencyMs, auth: true, enabled: true };
    if (httpStatus === 429) return { ok: false, message: "Digitap rate limit exceeded (HTTP 429) — retry shortly", latencyMs, auth: true, enabled: true };
    return { ok: false, message: `Unexpected probe response (HTTP ${httpStatus}, result ${envelope.result_code ?? "—"})`, latencyMs, auth: httpStatus >= 500, enabled: false };
  } catch (e) {
    const latencyMs = Date.now() - t0;
    return { ok: false, message: `Digitap probe failed: ${(e as Error).message}`, latencyMs, auth: false, enabled: false };
  }
}

function prodGuard(): ProbeResult | null {
  const { env, creds } = digitapConfig();
  if (!creds) return { ok: false, message: "Digitap credentials not configured — add DIGITAP_UAT_CLIENT_ID/SECRET (or PROD) to server/.env", latencyMs: 0, auth: false, enabled: false };
  if (env === "prod" && process.env.DIGITAP_ALLOW_PROD_PROBE !== "true") {
    return { ok: false, message: "Production probe disabled — exercise this product through a real consent flow instead (set DIGITAP_ALLOW_PROD_PROBE=true to override)", latencyMs: 0, auth: true, enabled: true };
  }
  return null;
}

/** PAN Basic probe (preserved from the original hub). */
export async function probePanBasic(): Promise<ProbeResult> {
  const guarded = prodGuard();
  if (guarded) return guarded;
  return probeEndpoint(`/validation/kyc/v1/pan_basic`, { pan: SYNTH.pan });
}

/** Catalog of hub-adapter probes: code → live probe against one endpoint. */
export const PROBE_TARGETS: Record<string, () => Promise<ProbeResult>> = {
  pan_verify: () => probePanBasic(),
  pan_details: () => probeEndpoint("/validation/kyc/v1/pan_details", { pan: SYNTH.pan, name: "SYNTHETIC PROBE", name_match_method: "fuzzy" }),
  pan_enrichment: () => probeEndpoint("/validation/kyc/v1/pan_to_name", { pan: SYNTH.pan }),
  pan_206ab: () => probeEndpoint("/validation/kyc/v1/form206ab_compliance_status", { pan: SYNTH.pan }),
  pan_itr: () => probeEndpoint("/validation/kyc/v1/itr_basic", { pan: SYNTH.pan }),
  pan_aadhaar_link: () => probeEndpoint("/validation/kyc/v1/pan_aadhaar_link", { pan: SYNTH.pan, aadhaar: SYNTH.aadhaar }),
  pan_account_link: () => probeEndpoint("/validation/misc/v1/pan-account-linkage", { pan: SYNTH.pan, account_number: "000000000", ifsc_code: "SBIN0000000" }),
  aadhaar_ovd: () => probeEndpoint("/validation/kyc/v1/aadhaar_to_masked_pan", { aadhaar: SYNTH.aadhaar }),
  voter_verify: () => probeEndpoint("/validation/kyc/v1/voter", { epic_number: SYNTH.epic }),
  passport_verify: () => probeEndpoint("/validation/kyc/v1/passport", { file_number: SYNTH.passportFile, dob: SYNTH.dob }),
  dl_verify: () => probeEndpoint("/validation/kyc/v1/dl", { dl_number: SYNTH.dl, dob: SYNTH.dob }),
  udid_verify: () => probeEndpoint("/validation/kyc/v1/kyc_udid_verification", { udid_number: SYNTH.udid })
};

/** Metadata for the discovery script (code → endpoint + synthetic payload). */
export const PROBE_CATALOG: Record<string, { path: string; payload: Record<string, unknown> }> = {
  pan_basic_v1: { path: "/validation/kyc/v1/pan_basic", payload: { pan: SYNTH.pan } },
  pan_basic_v2: { path: "/validation/kyc/v2/pan_basic", payload: { pan: SYNTH.pan, name: "SYNTHETIC PROBE", dob: SYNTH.dob } },
  pan_details: { path: "/validation/kyc/v1/pan_details", payload: { pan: SYNTH.pan } },
  pan_details_bc: { path: "/validation/kyc/v1/pan_details_bc", payload: { pan: SYNTH.pan } },
  pan_details_plus: { path: "/validation/kyc/v1/pan_details_plus", payload: { pan: SYNTH.pan } },
  pan_206ab: { path: "/validation/kyc/v1/form206ab_compliance_status", payload: { pan: SYNTH.pan } },
  pan_itr: { path: "/validation/kyc/v1/itr_basic", payload: { pan: SYNTH.pan } },
  pan_to_name: { path: "/validation/kyc/v1/pan_to_name", payload: { pan: SYNTH.pan } },
  pan_to_fname: { path: "/validation/kyc/v1/pan_to_fname", payload: { pan: SYNTH.pan } },
  pan_profile: { path: "/validation/kyc/v1/pan_profile", payload: { pan: SYNTH.pan } },
  pan_account_linkage: { path: "/validation/misc/v1/pan-account-linkage", payload: { pan: SYNTH.pan, account_number: "000000000", ifsc_code: "SBIN0000000" } },
  voter: { path: "/validation/kyc/v1/voter", payload: { epic_number: SYNTH.epic } },
  passport: { path: "/validation/kyc/v1/passport", payload: { file_number: SYNTH.passportFile, dob: SYNTH.dob } },
  pan_aadhaar_link: { path: "/validation/kyc/v1/pan_aadhaar_link", payload: { pan: SYNTH.pan, aadhaar: SYNTH.aadhaar } },
  pan_to_masked_aadhaar: { path: "/validation/kyc/v1/pan_to_masked_aadhaar", payload: { pan: SYNTH.pan } },
  aadhaar_to_masked_pan: { path: "/validation/kyc/v1/aadhaar_to_masked_pan", payload: { aadhaar: SYNTH.aadhaar } },
  aadhaar_to_unmasked_pan: { path: "/validation/kyc/v1/aadhaar_to_unmasked_pan", payload: { aadhaar: SYNTH.aadhaar } },
  dl: { path: "/validation/kyc/v1/dl", payload: { dl_number: SYNTH.dl, dob: SYNTH.dob } },
  dl_plus: { path: "/validation/kyc/v1/dl_plus", payload: { dl_number: SYNTH.dl, dob: SYNTH.dob } },
  udid: { path: "/validation/kyc/v1/kyc_udid_verification", payload: { udid_number: SYNTH.udid } }
};
