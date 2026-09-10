# SNIPER × Digitap + Supabase — Integration Hub documentation

This document describes how the SNIPER Integration Hub connects to real
provider APIs through a single **Digitap** account, with integration/compliance
records persisted to a **Supabase** project while the CRM core stays on its own
Postgres (or SQLite in local dev). It reflects what is **verified live** (each
claim backed by a probe in `digitap-enablement-report.md`), what is **awaiting
enablement**, and exactly what must happen for each remaining adapter to go
live. Nothing here is fabricated: an adapter shows Connected only after a
passing live probe.

---

## 1. Architecture

```
Browser (React)  ──►  SNIPER API (Express, server/.env holds secrets)
                          │
                          ├── CRM core data ──► primary DB (DATABASE_URL; SQLite fallback in dev)
                          │
                          ├── adapter layer (server/src/adapters)
                          │      registry → driver (digitap | mock | pending)
                          │         │
                          │         ▼
                          │   Digitap (svcdemo.digitap.work UAT / svc.digitap.ai prod)
                          │   Basic auth client_id:client_secret  ·  billable on HTTP 200
                          │
                          └── provider store (server/src/db/supabase.ts) ──► Supabase
                                 integration_state · provider_requests ·
                                 consent_records · verification_results · credit_pulls
```

Digitap APIs are called **only** from the SNIPER backend. No Digitap
credential, Supabase service key, raw provider response or unmasked Aadhaar
value is ever sent to the browser.

## 2. Credentials & environment (verified 2026-09-10)

`server/.env` holds the Sniper LLP **UAT** pair (`DIGITAP_ENV=uat`,
`DIGITAP_UAT_CLIENT_ID=07625809`, `DIGITAP_UAT_CLIENT_SECRET=…`, git-ignored).
The discovery probe against `svcdemo.digitap.work` returned **HTTP 200 +
result_code 101/102/103/109** on **12 of 20** endpoints — the earlier 401
problem is **resolved** with this pair. Keep `DIGITAP_ENV=uat` until production keys are
issued per product. The Digitap dashboard login shown during onboarding is
browser-only and is never stored in the repo.

## 3. Held API doc — KYC Validation Suite v4.91

`docs/KYC-Validation-API-Suite-v4.91.pdf` (20 endpoints, all `POST`, Basic
auth, envelope `{http_response_code, client_ref_num, request_id, result_code,
result?, message?, error?}`, `result_code` 101 valid / 102 invalid-event /
103 not found / 109 no ITR records for the period). All endpoints are
implemented in `server/src/adapters/digitap.ts`.

## 4. Live status (as of this build — probe evidence in §5)

| # | Hub adapter | Code | Digitap API | Driver | State |
|---|---|---|---|---|---|
| 1 | PAN Verification | `pan_verify` | `pan_basic` V1/V2 | digitap | ✅ Probe-passing (200/103) |
| 2 | PAN Details (full profile) | `pan_details` | `pan_details` | digitap | ✅ Probe-passing (200/103) — primary KYC engine |
| 3 | PAN Enrichment | `pan_enrichment` | `pan_to_name` / `pan_to_fname` / `pan_profile` | digitap | ✅ to_name probe-passing; fname/profile 503 at probe time (transient source) |
| 4 | Aadhaar mapping (masked PAN) | `aadhaar_ovd` | `aadhaar_to_masked_pan` / `pan_to_masked_aadhaar` | digitap | ✅ Probe-passing (200/101, 200/102) |
| 5 | PAN 206AB Compliance | `pan_206ab` | `form206ab_compliance_status` | digitap | ✅ Probe-passing (200/102) |
| 6 | PAN ITR Status | `pan_itr` | `itr_basic` | digitap | ✅ Probe-passing (200/109 = no records for synthetic PAN) |
| 7 | PAN–Aadhaar Link | `pan_aadhaar_link` | `pan_aadhaar_link` | digitap | ✅ Probe-passing (200/103) |
| 8 | PAN–Bank Account Link | `pan_account_link` | `misc/v1/pan-account-linkage` | digitap | ⚠ 503 at probe time — retry Test; source-side |
| 9 | Voter ID (EPIC) | `voter_verify` | `voter` | digitap | ✅ Probe-passing (200/103) |
| 10 | Passport | `passport_verify` | `passport` | digitap | ✅ Probe-passing (200/103) |
| 11 | Driving Licence | `dl_verify` | `dl` / `dl_plus` | digitap | ⚠ 400 with the synthetic DL — endpoint reachable; confirm accepted DL format with Digitap |
| 12 | Unique Disability ID | `udid_verify` | `kyc_udid_verification` | digitap | ⏳ 401 — product not enabled for this client yet |
| 13–16 | CIBIL / Experian / Equifax / CRIF | `cibil`… | Credit Bureau suite | pending | ⏳ **Credit score API doc awaited from client** + enablement |
| 17 | CKYC | `ckyc` | CKYC suite | pending | ⏳ Needs CERSAI institution cert + key + enablement |
| 18–20 | GSTN / MCA / Udyam | `gst`… | Business Data suite | pending | ⏳ Awaiting doc + enablement |
| 21 | Account Aggregator | `account_aggregator` | AA (TSP/FIU) suite | pending | ⏳ Awaiting doc + enablement |
| 22 | Bank Statement Parser | `bank_statement` | Alternate Data (BSA) suite | pending | ⏳ Awaiting doc + enablement |
| 23 | E-Sign Provider | `esign` | Onboarding (eSign) suite | pending | ⏳ Awaiting doc + enablement |
| 24 | OCR Engine | `ocr` | Onboarding (OCR) suite | pending | ⏳ Awaiting doc + enablement |
| 25–30 | Payments (UPI/NACH/NEFT) + Comms (WhatsApp/SMS/Email) | — | — | excluded | 🚫 Out of live scope by design |

Endpoints of note: `pan_details_bc` returned **412 "PAN Status Check is not
Enabled"** (variant not enabled; `pan_details` itself is enabled), and
`aadhaar_to_unmasked_pan` returned **401** (unmasked-PAN recovery not enabled
— masked variant is live). Neither is wired to a driver.

## 5. Enablement evidence (2026-09-10)

`docs/digitap-enablement-report.md` — produced by
`npm run test:digitap-discovery` (in `server/scripts/digitap-discovery.ts`):
one synthetic, format-valid, non-existent payload per endpoint (e.g. PAN
`ZZZPE0000Z`), single attempt. Verdicts: 200 + 101/102/103/109 = **enabled** ·
401 = credentials/product · 403 = egress IP not whitelisted · 412 = product
not enabled · 503 = source busy (retry). Re-run the script any time; it
overwrites the report.

## 6. LOS wiring (live paths)

- **PAN KYC** (`POST /api/applications/:id/kyc` `{type:"pan"}`): if
  `pan_details` is live + Test-passed → PAN Details engine (name match ≥80
  fuzzy, DOB consistency) and record `{…, live:true, sandbox:false}`;
  else if `pan_verify` is live → PAN Basic V2 (name+DOB) / V1 fallback; else
  the labelled sandbox path. Consent ledger row + Supabase mirror + audit on
  every call; failures record `failed` and return 422 with a safe reason.
- **OVD** (`{type:"voter"|"passport"|"dl"|"udid"}` + per-type fields incl.
  optional `dob`, `aadhaar` etc.): live when the adapter's row is live +
  Test-passed; advances the stage like PAN.
- **Compliance/enrichment** (`{type:"206ab"|"itr"|"pan_aadhaar_link"|"aadhaar_pan"}`):
  recorded in `kyc_records` but never auto-advance the stage. Aadhaar inputs
  are forwarded to Digitap for the check only — never logged or persisted.
- The workspace KYC button label resolves `pan_details` first, then
  `pan_verify` ("Verify PAN (Digitap)" only when that adapter is Connected).

## 7. Hub API

- `GET /api/admin/integrations` — 30 rows, computed `effectiveStatus`
  (connected | sandbox | awaiting_enablement | error | not_configured), counts,
  env summary. Admins cannot mark Connected manually.
- `PATCH /api/admin/integrations/:id` `{mode}` — sandbox/live switch (audited).
- `POST /api/admin/integrations/:id/test` — per-adapter live probe via
  `PROBE_TARGETS` (synthetic payloads); non-driver suites report awaiting
  enablement without a network call; probe outcome persists on the row config.
- Client: `client/src/pages/Integrations.tsx` renders from the catalog.

## 8. Security model (unchanged)

Consent before every provider-backed KYC call · masked PAN only in results ·
raw Aadhaar forwarded for a check but never stored/logged/returned ·
provider mobile/email masked (`maskMobile`/`maskEmail`) · secrets only in
`server/.env` · retries only on network errors/5xx · fresh `client_ref_num`
per call · Supabase writes fail open.

## 9. Testing

`npm run typecheck` (server + client) · `npm run test -w server`
(`src/test/adapters.test.ts` — 11 tests incl. catalog integrity of 30
adapters, extended identifiers, PII masking, computed statuses) ·
`npm run test:hub` (API smoke; updated to 30 adapters) ·
`npm run test:digitap-discovery` (live enablement evidence). Known
pre-existing PG-dependent GN tests are unrelated and tracked separately.

## 10. Next steps

1. **Credit score API** — paste the doc; the bureau adapters (`cibil` etc.)
   become live drivers the same way (function + mapper + probe + LOS hook).
2. Ask Digitap for: UDID enablement (401), `aadhaar_to_unmasked_pan`
   enablement (401), DL accepted format (400), `pan_details_bc` enablement
   (412) — and re-probe `pan_to_fname`/`pan_profile`/`pan_account_linkage`
   (503 at probe time).
3. CKYC: obtain CERSAI institution cert (.pem/.pfx) + private key + financial
   code, then Digitap enablement.
4. Remaining suites (bureau/GST/BSA/AA/eSign/OCR): request docs + enablement
   from your RM (client 07625809, UAT).
