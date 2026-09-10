import { useEffect, useMemo, useState } from "react";
import {
  UploadCloud, FileText, Play, Loader2, CheckCircle2, XCircle, FlaskConical, ShieldCheck,
  AlertTriangle, RefreshCw
} from "lucide-react";
import { api, ApiError } from "../lib/api";
import { PageHeader, Card, CardTitle } from "../components/ui";

const DOC_TYPES = ["PAN Card", "Voter ID (EPIC)", "Passport", "Driving Licence", "UDID Card", "Aadhaar"];

const DEFAULT_ADAPTER: Record<string, string> = {
  "PAN Card": "pan_details",
  "Voter ID (EPIC)": "voter",
  "Passport": "passport",
  "Driving Licence": "dl",
  "UDID Card": "udid",
  "Aadhaar": "aadhaar_to_masked_pan"
};

/** Map a sniffed ID kind to the adapter field key it should prefill. */
const ID_FIELD: Record<string, string> = {
  pan: "pan",
  epic: "epic_number",
  passport: "file_number",
  dl: "dl_number",
  udid: "udid_number",
  aadhaar: "aadhaar"
};

/** Detect the document type + ID number straight from the uploaded filename. */
function sniffFile(fileName: string): { doc: string; kind: string; id: string } | null {
  const u = fileName.toUpperCase();
  let m: RegExpMatchArray | null;
  if ((m = u.match(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/))) return { doc: "PAN Card", kind: "pan", id: m[0] };
  if ((m = u.match(/\b[A-Z]{3}[0-9]{7}\b/))) return { doc: "Voter ID (EPIC)", kind: "epic", id: m[0] };
  if ((m = u.match(/\b[A-Z][0-9]{7}\b/))) return { doc: "Passport", kind: "passport", id: m[0] };
  if ((m = u.match(/\b[A-Z]{2}[0-9]{2}[0-9]{11}\b/))) return { doc: "Driving Licence", kind: "dl", id: m[0] };
  if ((m = u.match(/\b[2-9][0-9]{11}\b/))) return { doc: "Aadhaar", kind: "aadhaar", id: m[0] };
  return null;
}

interface LabField { key: string; label: string; required: boolean; placeholder?: string; hint?: string }
interface LabAdapter {
  code: string; name: string; docs: string[]; endpoint: string; fields: LabField[];
  digitapProduct: string | null; digitapEnabled: boolean;
  rowState: { mode: string; lastTestOk: boolean; status: string } | null;
}

interface RunResult {
  ok: boolean;
  adapter?: string;
  docType?: string | null;
  fileName?: string | null;
  latencyMs?: number;
  provider?: string;
  endpoint?: string;
  providerRef?: string;
  result?: any;
  env?: string;
  error?: string;
  code?: string;
  details?: string[];
  status?: number;
}

interface HistoryItem {
  ts: number; adapter: string; name: string; docType: string | null; fileName: string | null;
  ok: boolean; latencyMs?: number; summary: string;
}

const HISTORY_KEY = "sniper_doclab_history";

export default function DocLab() {
  const [adapters, setAdapters] = useState<LabAdapter[]>([]);
  const [env, setEnv] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState<string>("");
  const [adapterCode, setAdapterCode] = useState<string>("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => {
    setLoading(true);
    return api<any>("/lab/adapters")
      .then((d) => { setAdapters(d.adapters ?? []); setEnv(d.env ?? null); setError(null); })
      .catch((e: any) => { setError(e?.message || "Failed to load the lab — check that the API is running."); setAdapters([]); })
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  useEffect(() => {
    try { const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); if (Array.isArray(h)) setHistory(h.slice(0, 10)); } catch { /* ignore */ }
  }, []);

  const flash = (ok: boolean, text: string) => { setToast({ ok, text }); setTimeout(() => setToast(null), 8000); };

  const filtered = useMemo(() => (docType ? adapters.filter((a) => a.docs.includes(docType)) : adapters), [adapters, docType]);
  const adapter = useMemo(() => adapters.find((a) => a.code === adapterCode) ?? null, [adapters, adapterCode]);

  const onFile = (f: File | null) => {
    setFile(f);
    if (!f) return;
    const sniff = sniffFile(f.name);
    if (sniff) {
      setDocType(sniff.doc);
      const def = DEFAULT_ADAPTER[sniff.doc] || "";
      setAdapterCode(def);
      setValues((v) => ({ ...v, [ID_FIELD[sniff.kind]]: sniff.id }));
      flash(true, `Detected ${sniff.doc} — ${sniff.kind.toUpperCase()} ${sniff.id} filled in from the filename.`);
    } else {
      flash(false, "No ID pattern found in the filename — pick the document type and enter the number manually.");
    }
  };

  const pickAdapter = (code: string) => {
    setAdapterCode(code);
    setResult(null);
  };

  const setVal = (key: string, v: string) => setValues((prev) => ({ ...prev, [key]: v }));

  /** Send only populated metadata fields so older API deployments also accept the request. */
  const buildPayload = () => {
    const payload: Record<string, unknown> = { adapter: adapterCode, ...values };
    if (docType) payload.doc_type = docType;
    if (file?.name) payload.file_name = file.name;
    return payload;
  };

  const pushHistory = (item: HistoryItem) => {
    const next = [item, ...history].slice(0, 10);
    setHistory(next);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const run = async () => {
    if (!adapter) return;
    const missing = adapter.fields.filter((f) => f.required && !(values[f.key] || "").trim());
    if (missing.length) { flash(false, `Missing: ${missing.map((f) => f.label).join(", ")}`); return; }
    setRunning(true);
    setResult(null);
    try {
      const out = await api<RunResult>("/lab/test", {
        method: "POST",
        body: buildPayload()
      });
      setResult(out);
      const verified = out.result?.verified;
      pushHistory({
        ts: Date.now(), adapter: adapter.code, name: adapter.name, docType: docType || null, fileName: file?.name ?? null,
        ok: out.ok, latencyMs: out.latencyMs,
        summary: verified !== undefined ? (verified ? "verified" : "not verified") : out.ok ? "success" : (out.error || "failed")
      });
    } catch (e: any) {
      // Preserve the server's validation details instead of collapsing every
      // 400 into the generic "Validation failed" message.
      const body = e instanceof ApiError ? e.body : e?.body;
      const failed: RunResult = {
        ok: false,
        error: body?.error ?? e.message,
        code: body?.code,
        details: Array.isArray(body?.details) ? body.details : undefined,
        status: e instanceof ApiError ? e.status : undefined,
        latencyMs: body?.latencyMs,
        endpoint: body?.endpoint,
        provider: body?.provider
      };
      setResult(failed);
      pushHistory({ ts: Date.now(), adapter: adapter.code, name: adapter.name, docType: docType || null, fileName: file?.name ?? null, ok: false, latencyMs: failed.latencyMs, summary: failed.error || "failed" });
    } finally {
      setRunning(false);
    }
  };

  const statusDot = (a: LabAdapter) => {
    if (a.rowState?.mode === "live" && a.rowState.lastTestOk) return { icon: <CheckCircle2 size={13} className="text-emerald-500" />, label: "live probe passed" };
    if (a.rowState?.mode === "live") return { icon: <FlaskConical size={13} className="text-amber-500" />, label: "live mode, probe pending" };
    return { icon: <FlaskConical size={13} className="text-zinc-400" />, label: "sandbox / not tested" };
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="API Test Lab"
        sub="Upload a document, pick the Digitap API, and run a live verification — results are masked and every run is consent-logged + audited."
      />

      {toast && (
        <div className={`text-xs px-3 py-2 rounded-lg border ${toast.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
          {toast.text}
        </div>
      )}

      <div className="flex items-start gap-2 text-xs px-3 py-2.5 rounded-lg border border-sky-200 bg-sky-50 text-sky-800">
        <ShieldCheck size={14} className="mt-0.5 shrink-0" />
        <div>
          <b>How this works:</b> Digitap KYC products verify by <b>ID number</b>, not by image — the uploaded file is kept as the document
          reference and the check runs on the number entered (auto-detected from the filename when possible). Every run records a consent
          entry + audit event, and provider responses are masked (raw Aadhaar is never stored). Some Digitap products may bill on a successful
          lookup, so test with your own documents.
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs px-3 py-2.5 rounded-lg border border-rose-200 bg-rose-50 text-rose-700">
          <AlertTriangle size={14} /> {error} <button className="ml-auto font-semibold hover:underline" onClick={load}><RefreshCw size={12} className="inline mr-1" />Retry</button>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-5">
        {/* -------- Left: document + API selection -------- */}
        <div className="xl:col-span-2 space-y-5">
          <Card>
            <CardTitle title="Step 1 · Upload document" />
            <label className="mt-3 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-300 hover:border-indigo-400 bg-zinc-50/60 px-4 py-8 cursor-pointer transition-colors">
              <UploadCloud size={26} className="text-zinc-400" />
              <span className="text-sm font-medium text-zinc-700">{file ? file.name : "Drop your document here or click to browse"}</span>
              <span className="text-[11px] text-zinc-500">PAN card · Voter ID · Passport · DL · UDID · Aadhaar — PDF, PNG or JPG (reference only)</span>
              <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
            </label>
            {file && (
              <div className="mt-3 flex items-center gap-2 text-xs text-zinc-600 bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2">
                <FileText size={13} className="text-indigo-500" />
                <span className="truncate font-medium">{file.name}</span>
                <span className="ml-auto text-zinc-400">{(file.size / 1024).toFixed(1)} KB</span>
                <button className="text-rose-500 hover:underline" onClick={() => { setFile(null); }}>remove</button>
              </div>
            )}

            <div className="mt-4 space-y-1.5">
              <label className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Document type</label>
              <select className="w-full input" value={docType} onChange={(e) => { setDocType(e.target.value); setAdapterCode(DEFAULT_ADAPTER[e.target.value] || ""); setResult(null); }}>
                <option value="">— select document type —</option>
                {DOC_TYPES.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          </Card>

          <Card>
            <CardTitle title="Step 2 · Choose the API to test" />
            {loading ? (
              <div className="py-6 text-center text-xs text-zinc-400"><Loader2 size={16} className="inline animate-spin mr-1" /> Loading adapters…</div>
            ) : filtered.length === 0 ? (
              <div className="py-6 text-center text-xs text-zinc-400">Select a document type to see the APIs that can test it.</div>
            ) : (
              <div className="space-y-1.5">
                {filtered.map((a) => {
                  const dot = statusDot(a);
                  return (
                    <button key={a.code} onClick={() => pickAdapter(a.code)}
                      className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${adapterCode === a.code ? "border-indigo-400 bg-indigo-50/70 ring-1 ring-indigo-200" : "border-zinc-200 bg-white hover:border-indigo-300"}`}>
                      <div className="flex items-center gap-1.5 text-[13px] font-medium text-zinc-800">
                        {dot.icon} {a.name}
                        {adapterCode === a.code && <CheckCircle2 size={13} className="ml-auto text-indigo-500" />}
                      </div>
                      <div className="mt-0.5 text-[11px] text-zinc-500 font-mono truncate">{a.endpoint}</div>
                      <div className="mt-0.5 text-[10.5px] text-zinc-400">{dot.label}{a.digitapEnabled ? "" : " · awaiting Digitap enablement"}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        {/* -------- Right: inputs + run + result -------- */}
        <div className="xl:col-span-3 space-y-5">
          <Card>
            <CardTitle title="Step 3 · Verification inputs" />
            {!adapter ? (
              <div className="py-8 text-center text-xs text-zinc-400">Upload a document and pick an API to see its input fields.</div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                  {adapter.fields.map((f) => (
                    <div key={f.key} className={f.key === "pan" ? "md:col-span-1" : ""}>
                      <label className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                        {f.label} {f.required && <span className="text-rose-500">*</span>}
                      </label>
                      <input
                        className="input mt-1"
                        placeholder={f.placeholder ?? ""}
                        value={values[f.key] ?? ""}
                        onChange={(e) => setVal(f.key, e.target.value)}
                        autoComplete="off"
                      />
                      {f.hint && <p className="text-[10.5px] text-zinc-400 mt-0.5">{f.hint}</p>}
                    </div>
                  ))}
                </div>
                {env && (
                  <div className="mt-3 text-[11px] text-zinc-500">
                    Digitap <b>{String(env.digitapEnv || "").toUpperCase()}</b> · credentials{" "}
                    {env.credentialsConfigured ? <span className="text-emerald-600 font-semibold">configured</span> : <span className="text-rose-500 font-semibold">missing</span>}
                  </div>
                )}
                <button className="btn btn-primary mt-4" disabled={running} onClick={run}>
                  {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                  {running ? "Running live verification…" : `Run ${adapter.name}`}
                </button>
              </>
            )}
          </Card>

          {result && (
            <Card>
              <CardTitle title={`Result ${result.ok ? "— success" : "— failed"}`} />
              <div className="mt-3 space-y-2 text-xs">
                <div className="flex flex-wrap gap-2">
                  {result.ok && <span className="badge badge-green">Provider {result.provider}</span>}
                  {result.ok && result.env && <span className="badge badge-blue">env {String(result.env).toUpperCase()}</span>}
                  {typeof result.latencyMs === "number" && <span className="badge badge-indigo">{result.latencyMs} ms</span>}
                  {!result.ok && result.code && <span className="badge badge-red">{result.code}</span>}
                </div>
                {result.endpoint && <div className="text-zinc-600"><b>Endpoint</b> <code className="font-mono bg-zinc-100 px-1 rounded">{result.endpoint}</code></div>}
                {result.providerRef && <div className="text-zinc-600"><b>Request ref</b> <code className="font-mono bg-zinc-100 px-1 rounded">{result.providerRef}</code></div>}
                {!result.ok && result.error && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
                    <div>{result.error}</div>
                    {result.details?.length ? (
                      <ul className="mt-1 list-disc pl-4 text-[11px] text-rose-600">
                        {result.details.map((detail, i) => <li key={i}>{detail}</li>)}
                      </ul>
                    ) : null}
                    {result.status === 400 && !result.details?.length && <div className="mt-1 text-[11px] text-rose-600">Check the required document number and select the correct document type/API.</div>}
                  </div>
                )}
                {result.ok && result.result && (
                  <pre className="mt-2 rounded-xl bg-zinc-900 text-zinc-100 text-[11px] leading-relaxed p-4 overflow-x-auto max-h-96 overflow-y-auto">
{JSON.stringify(result.result, null, 2)}
                  </pre>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* -------- History -------- */}
      {history.length > 0 && (
        <Card>
          <CardTitle title="Recent lab runs" />
          <div className="mt-2 divide-y divide-zinc-100">
            {history.map((h, i) => (
              <div key={i} className="flex items-center gap-2 py-2 text-xs">
                {h.ok ? <CheckCircle2 size={13} className="text-emerald-500" /> : <XCircle size={13} className="text-rose-500" />}
                <span className="font-medium text-zinc-700">{h.name}</span>
                <span className="text-zinc-400">{h.docType}{h.fileName ? ` · ${h.fileName}` : ""}</span>
                <span className="ml-auto text-zinc-500">{h.summary}</span>
                {typeof h.latencyMs === "number" && <span className="text-zinc-400 w-16 text-right">{h.latencyMs} ms</span>}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}