# Digitap enablement report — KYC Validation Suite v4.91

Probed: 2026-09-10T20:35:54.609Z · env **UAT** · client **07625809** · host `https://svcdemo.digitap.work`

Synthetic payloads only (format-valid, non-existent records) — no real profile touched,
no customer data sent. One call per endpoint.

| endpoint | path | HTTP | result_code | verdict | latency | note |
|---|---|---|---|---|---|---|
| pan_basic_v1 | `/validation/kyc/v1/pan_basic` | 200 | 103 | enabled | 4770ms | No record found for the given input |
| pan_basic_v2 | `/validation/kyc/v2/pan_basic` | 200 | 103 | enabled | 2599ms | No record found for the given input |
| pan_details | `/validation/kyc/v1/pan_details` | 200 | 103 | enabled | 4026ms | No record found for the given input |
| pan_details_bc | `/validation/kyc/v1/pan_details_bc` | 412 | — | not_enabled | 189ms | PAN Status Check is not Enabled. Please contact support/RM |
| pan_details_plus | `/validation/kyc/v1/pan_details_plus` | 200 | 103 | enabled | 12820ms | No record found for the given input |
| pan_206ab | `/validation/kyc/v1/form206ab_compliance_status` | 200 | 102 | enabled | 917ms | Invalid ID number or combination of inputs |
| pan_itr | `/validation/kyc/v1/itr_basic` | 200 | 109 | enabled | 6086ms | No ITR filing records found for the PAN for the search period |
| pan_to_name | `/validation/kyc/v1/pan_to_name` | 200 | 103 | enabled | 5205ms | No record found for the given input |
| pan_to_fname | `/validation/kyc/v1/pan_to_fname` | 503 | — | unexpected | 13475ms | Source is busy or unavailable. Try again later |
| pan_profile | `/validation/kyc/v1/pan_profile` | 503 | — | unexpected | 3504ms | Service briefly unavailable for scheduled maintenance |
| pan_account_linkage | `/validation/misc/v1/pan-account-linkage` | 503 | — | unexpected | 47ms | — |
| voter | `/validation/kyc/v1/voter` | 200 | 103 | enabled | 3337ms | No record found for the given input |
| passport | `/validation/kyc/v1/passport` | 200 | 103 | enabled | 4759ms | No Records Found for the Given ID or Combination of Inputs |
| pan_aadhaar_link | `/validation/kyc/v1/pan_aadhaar_link` | 200 | 103 | enabled | 7987ms | — |
| pan_to_masked_aadhaar | `/validation/kyc/v1/pan_to_masked_aadhaar` | 200 | 102 | enabled | 3272ms | Invalid ID Number or Combination of Inputs |
| aadhaar_to_masked_pan | `/validation/kyc/v1/aadhaar_to_masked_pan` | 200 | 101 | enabled | 3296ms | — |
| aadhaar_to_unmasked_pan | `/validation/kyc/v1/aadhaar_to_unmasked_pan` | 401 | — | auth_failed | 249ms | Client Authentication Failed |
| dl | `/validation/kyc/v1/dl` | 400 | — | payload_rejected | 3315ms | One or more parameters format is wrong or missing |
| dl_plus | `/validation/kyc/v1/dl_plus` | 400 | — | payload_rejected | 270ms | One or more parameters format is wrong or missing |
| udid | `/validation/kyc/v1/kyc_udid_verification` | 401 | — | auth_failed | 3251ms | Client Authentication Failed |

**Enabled: 12/20** — HTTP 200 + result 101/102/103 = credentials OK + product enabled.

Legend: 401 = wrong credentials for this env · 403 = whitelist the server egress IP with
Digitap · 412 = ask your RM to enable the product · 400 = endpoint reachable, check payload.