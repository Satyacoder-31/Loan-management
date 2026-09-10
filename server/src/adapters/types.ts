/**
 * SNIPER Integration Hub — adapter catalog & driver contracts.
 *
 * Every external provider SNIPER can talk to is described by an AdapterDef in
 * the catalog below. A driver implementation (mock / digitap / pending) turns
 * an integration row + an input into a normalized AdapterResult. The CRM never
 * depends on a provider's raw response shape — mappers normalize per adapter.
 *
 * SECURITY: no secret ever lives in an AdapterDef / integration row. Credentials
 * are read from the process environment only (server/.env, git-ignored).
 */

export type AdapterScope = "identity" | "credit" | "business" | "banking" | "payments" | "documents" | "communication";

/** Effective operational state of an adapter, computed from config + live probes. */
export type AdapterStatus = "connected" | "sandbox" | "error" | "not_configured" | "awaiting_enablement";

/** How the adapter is being driven right now. */
export type AdapterMode = "mock" | "live" | "pending";

export interface DigitapSuite {
  /** Digitap product family (KYC Validation, Onboarding, Alternate Data, ...) */
  family: string;
  /** Product/suite display name inside that family */
  product: string;
  /** Set once Digitap has enabled the suite for this client AND we hold its API doc */
  enabled: boolean;
  /** Human note shown in the hub (what to ask Digitap for, etc.) */
  note: string;
}

export interface AdapterDef {
  /** Stable code — matches integrations.code rows and client grouping */
  code: string;
  name: string;
  category: AdapterScope;
  /** True when the customer asked this adapter to stay out of live scope */
  excluded: boolean;
  /** Who powers it (always Digitap per product decision; null = unmapped) */
  digitap: DigitapSuite | null;
  /** Adapter driver family: "digitap" once a live driver exists, else "pending" */
  driver: "digitap" | "pending" | "local";
  /** Whether provider calls for this adapter need an explicit consent record */
  needsConsent: boolean;
}

/**
 * Adapter availability. The KYC Validation Suite v4.91 doc is held in-repo
 * (docs/KYC-Validation-API-Suite-v4.91.pdf), so every suite in that doc is
 * mapped to a live driver; its hub Test probe decides Connected vs Error.
 * Suites in OTHER Digitap docs (credit bureau, GST, BSA, AA, eSign, OCR, CKYC)
 * stay `enabled: false` until their doc lands + Digitap enables them.
 */
const KYC_ENABLED = { panBasic: true, suiteDoc: true, rest: false };

export const ADAPTER_CATALOG: AdapterDef[] = [
  // ---------- Identity ----------
  {
    code: "pan_verify", name: "PAN Verification", category: "identity", excluded: false,
    digitap: { family: "KYC Validation", product: "PAN Basic (V1/V2)", enabled: KYC_ENABLED.panBasic, note: "Credentials configured? Click Test — a passing live probe turns this adapter Connected." },
    driver: "digitap", needsConsent: true
  },
  {
    code: "pan_details", name: "PAN Details (full profile)", category: "identity", excluded: false,
    digitap: { family: "KYC Validation", product: "PAN Details / Details Plus", enabled: KYC_ENABLED.suiteDoc, note: "Doc held (KYC suite v4.91) — run Test; turns Connected on a passing probe." },
    driver: "digitap", needsConsent: true
  },
  {
    code: "pan_enrichment", name: "PAN Enrichment (name/father/profile)", category: "identity", excluded: false,
    digitap: { family: "KYC Validation", product: "PAN to Name / F'Name / Profile", enabled: KYC_ENABLED.suiteDoc, note: "Doc held (KYC suite v4.91) — run Test." },
    driver: "digitap", needsConsent: true
  },
  {
    code: "ckyc", name: "CKYC", category: "identity", excluded: false,
    digitap: { family: "KYC Validation", product: "CKYC (fetch/update)", enabled: false, note: "Separate CKYC suite — needs CERSAI institution cert + key + Digitap enablement." },
    driver: "pending", needsConsent: true
  },
  {
    code: "aadhaar_ovd", name: "Aadhaar mapping (masked PAN)", category: "identity", excluded: false,
    digitap: { family: "KYC Validation", product: "Aadhaar to Masked/Unmasked PAN", enabled: KYC_ENABLED.suiteDoc, note: "Doc held (KYC suite v4.91) — run Test. Raw Aadhaar never persisted." },
    driver: "digitap", needsConsent: true
  },
  {
    code: "pan_206ab", name: "PAN 206AB Compliance", category: "identity", excluded: false,
    digitap: { family: "KYC Validation", product: "206AB Compliance Status", enabled: KYC_ENABLED.suiteDoc, note: "Doc held — run Test. Higher-TDS specified-person check." },
    driver: "digitap", needsConsent: true
  },
  {
    code: "pan_itr", name: "PAN ITR Status", category: "identity", excluded: false,
    digitap: { family: "KYC Validation", product: "ITR Basic (filing history)", enabled: KYC_ENABLED.suiteDoc, note: "Doc held — run Test." },
    driver: "digitap", needsConsent: true
  },
  {
    code: "pan_aadhaar_link", name: "PAN–Aadhaar Link", category: "identity", excluded: false,
    digitap: { family: "KYC Validation", product: "PAN Aadhaar Link Status", enabled: KYC_ENABLED.suiteDoc, note: "Doc held — run Test. Requires customer Aadhaar (consent-gated, never stored)." },
    driver: "digitap", needsConsent: true
  },
  {
    code: "pan_account_link", name: "PAN–Bank Account Link", category: "identity", excluded: false,
    digitap: { family: "KYC Validation", product: "PAN Account Linkage (misc suite)", enabled: KYC_ENABLED.suiteDoc, note: "Doc held — run Test. PAN vs bank account ownership." },
    driver: "digitap", needsConsent: true
  },
  {
    code: "voter_verify", name: "Voter ID (EPIC)", category: "identity", excluded: false,
    digitap: { family: "KYC Validation", product: "Voter ID Validation", enabled: KYC_ENABLED.suiteDoc, note: "Doc held — run Test." },
    driver: "digitap", needsConsent: true
  },
  {
    code: "passport_verify", name: "Passport", category: "identity", excluded: false,
    digitap: { family: "KYC Validation", product: "Passport Validation", enabled: KYC_ENABLED.suiteDoc, note: "Doc held — run Test. Needs file number + DOB." },
    driver: "digitap", needsConsent: true
  },
  {
    code: "dl_verify", name: "Driving Licence", category: "identity", excluded: false,
    digitap: { family: "KYC Validation", product: "DL / DL Plus", enabled: KYC_ENABLED.suiteDoc, note: "Doc held — run Test. Needs DL number + DOB." },
    driver: "digitap", needsConsent: true
  },
  {
    code: "udid_verify", name: "Unique Disability ID", category: "identity", excluded: false,
    digitap: { family: "KYC Validation", product: "UDID Verification", enabled: KYC_ENABLED.suiteDoc, note: "Doc held — run Test. UDID or linked mobile." },
    driver: "digitap", needsConsent: true
  },
  // ---------- Credit ----------
  {
    code: "cibil", name: "TransUnion CIBIL", category: "credit", excluded: false,
    digitap: { family: "Credit Bureau", product: "CIBIL CIR", enabled: false, note: "Awaiting Credit Bureau suite doc + enablement (credit score API doc pending from client)." },
    driver: "pending", needsConsent: true
  },
  {
    code: "experian", name: "Experian", category: "credit", excluded: false,
    digitap: { family: "Credit Bureau", product: "Experian CIR", enabled: false, note: "Ask Digitap for the Credit Bureau suite doc + enablement." },
    driver: "pending", needsConsent: true
  },
  {
    code: "equifax", name: "Equifax", category: "credit", excluded: false,
    digitap: { family: "Credit Bureau", product: "Equifax CIR", enabled: false, note: "Ask Digitap for the Credit Bureau suite doc + enablement." },
    driver: "pending", needsConsent: true
  },
  {
    code: "crif", name: "CRIF High Mark", category: "credit", excluded: false,
    digitap: { family: "Credit Bureau", product: "CRIF High Mark CIR", enabled: false, note: "Ask Digitap for the Credit Bureau suite doc + enablement." },
    driver: "pending", needsConsent: true
  },
  // ---------- Business ----------
  {
    code: "gst", name: "GSTN", category: "business", excluded: false,
    digitap: { family: "Business Data", product: "GSTN profile", enabled: false, note: "Ask Digitap for the business-data suite doc + enablement." },
    driver: "pending", needsConsent: true
  },
  {
    code: "mca", name: "MCA", category: "business", excluded: false,
    digitap: { family: "Business Data", product: "MCA21 registry", enabled: false, note: "Ask Digitap for the business-data suite doc + enablement." },
    driver: "pending", needsConsent: true
  },
  {
    code: "udyam", name: "Udyam", category: "business", excluded: false,
    digitap: { family: "Business Data", product: "Udyam registration", enabled: false, note: "Ask Digitap for the business-data suite doc + enablement." },
    driver: "pending", needsConsent: true
  },
  // ---------- Banking ----------
  {
    code: "account_aggregator", name: "Account Aggregator", category: "banking", excluded: false,
    digitap: { family: "Account Aggregator (TSP/FIU)", product: "AA consent flow", enabled: false, note: "Digitap is a certified AA TSP — ask for the AA suite doc + enablement." },
    driver: "pending", needsConsent: true
  },
  {
    code: "bank_statement", name: "Bank Statement Parser", category: "banking", excluded: false,
    digitap: { family: "Alternate Data", product: "Bank Statement Analyzer", enabled: false, note: "Ask Digitap for the Alternate Data / BSA suite doc + enablement." },
    driver: "pending", needsConsent: true
  },
  // ---------- Payments (excluded from live scope per business decision) ----------
  { code: "upi", name: "UPI (PG)", category: "payments", excluded: true, digitap: { family: "Payments", product: "UPI collect/refund", enabled: false, note: "Out of scope for this integration pass." }, driver: "pending", needsConsent: false },
  { code: "nach", name: "NACH / eNACH", category: "payments", excluded: true, digitap: { family: "Payments", product: "NACH mandate", enabled: false, note: "Out of scope for this integration pass." }, driver: "pending", needsConsent: true },
  { code: "neft_imps", name: "NEFT / IMPS", category: "payments", excluded: true, digitap: { family: "Payments", product: "Bank transfer", enabled: false, note: "Out of scope for this integration pass." }, driver: "pending", needsConsent: false },
  // ---------- Documents ----------
  {
    code: "esign", name: "E-Sign Provider", category: "documents", excluded: false,
    digitap: { family: "Onboarding Suite", product: "Aadhaar / OTP eSign", enabled: false, note: "Ask Digitap for the Onboarding (eSign) suite doc + enablement." },
    driver: "pending", needsConsent: true
  },
  {
    code: "ocr", name: "OCR Engine", category: "documents", excluded: false,
    digitap: { family: "Onboarding Suite", product: "OCR & OVD validation", enabled: false, note: "Ask Digitap for the Onboarding (OCR) suite doc + enablement." },
    driver: "pending", needsConsent: true
  },
  // ---------- Communication (excluded from live scope per business decision) ----------
  { code: "whatsapp", name: "WhatsApp Business", category: "communication", excluded: true, digitap: { family: "Communication", product: "WhatsApp API", enabled: false, note: "Out of scope for this integration pass." }, driver: "pending", needsConsent: false },
  { code: "sms", name: "SMS Gateway", category: "communication", excluded: true, digitap: { family: "Communication", product: "SMS API", enabled: false, note: "Out of scope for this integration pass." }, driver: "pending", needsConsent: false },
  { code: "email", name: "Email Service", category: "communication", excluded: true, digitap: { family: "Communication", product: "Transactional email", enabled: false, note: "Out of scope for this integration pass." }, driver: "pending", needsConsent: false }
];

export const CATALOG_BY_CODE = new Map(ADAPTER_CATALOG.map((a) => [a.code, a]));

/** Normalized result handed back to CRM code — never raw provider JSON. */
export interface AdapterResult {
  ok: boolean;
  /** machine + human readable status */
  status: "verified" | "invalid" | "not_found" | "provider_error" | "consent_required" | "not_enabled" | "sandbox";
  message: string;
  /** normalized, minimal, purpose-limited data (masked where sensitive) */
  data?: Record<string, unknown>;
  /** provider-side references (request_id etc.) for audit trail */
  providerRef?: string;
  /** adapter + suite that produced this result */
  provider: string;
  /** true when produced by the labelled mock driver (never in prod config) */
  sandbox?: boolean;
  /** latency of the provider call in ms (mock = 0) */
  latencyMs?: number;
  /** provider-side error code when !ok */
  errorCode?: string;
}

export interface AdapterContext {
  tenantId: number;
  userId: number;
  clientIp?: string;
}

/** Mapper output kept purpose-limited: no full Aadhaar ever leaves the backend. */
export interface PanVerification {
  panMasked: string;
  panStatus: "Active" | "Invalid" | "Unknown";
  statusCode: string;
  nameMatch: boolean | null;
  nameMatchScore: number | null;
  dobMatch: boolean | null;
  seedingStatus: string;
  nameFromPan: string;
  panDisplayName: string;
}
