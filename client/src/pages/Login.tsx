import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ShieldCheck, AlertTriangle, Loader2, KeyRound } from "lucide-react";
import { useAuth } from "../lib/auth";

const DEMO_USERS = [
  { email: "admin@nexus.demo", label: "Super Admin", desc: "Full platform & system administration", category: "Core" },
  { email: "sales@nexus.demo", label: "Sales Manager", desc: "CRM, lead management & sales pipeline", category: "Acquisition" },
  { email: "dsa@nexus.demo", label: "DSA Partner", desc: "Direct Selling Agent lead & application intake", category: "Acquisition" },
  { email: "telecaller@nexus.demo", label: "Telecaller", desc: "Outbound calling queue & lead qualification", category: "Acquisition" },
  { email: "credit@nexus.demo", label: "Credit Manager", desc: "Underwriting, bureau evaluation & approvals", category: "Underwriting" },
  { email: "underwriting@nexus.demo", label: "Underwriter", desc: "Application workspace, BRE & risk assessment", category: "Underwriting" },
  { email: "ops@nexus.demo", label: "Operations", desc: "Disbursement processing & sanction generation", category: "Operations" },
  { email: "field@nexus.demo", label: "Field Executive", desc: "Field verification, site visits & customer KYC", category: "Operations" },
  { email: "collections@nexus.demo", label: "Collections Head", desc: "NPA management, recovery & PTP tracking", category: "Collections" },
  { email: "agent@nexus.demo", label: "Collection Agent", desc: "Field recovery, payment collection & tasks", category: "Collections" },
  { email: "finance@nexus.demo", label: "Finance & Recon", desc: "Payment reconciliation & accounting ledger", category: "Finance" },
  { email: "compliance@nexus.demo", label: "Compliance Officer", desc: "RBI digital lending, KFS & regulatory audit", category: "Compliance" },
  { email: "auditor@nexus.demo", label: "Auditor", desc: "System audit logs, event trail & security", category: "Compliance" },
  { email: "customer@nexus.demo", label: "Customer Portal", desc: "Borrower self-service portal, loan & application status", category: "Customer" },
];

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("admin@nexus.demo");
  const [password, setPassword] = useState("demo1234");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("All");

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await login(email, password);
      nav("/app");
    } catch (ex: any) {
      setErr(ex.message || "Login failed");
    } finally {
      setBusy(false);
    }
  };

  const categories = ["All", "Core", "Acquisition", "Underwriting", "Operations", "Collections", "Finance", "Compliance", "Customer"];
  const filteredUsers = filter === "All" ? DEMO_USERS : DEMO_USERS.filter((u) => u.category === filter);

  return (
    <div className="min-h-screen flex bg-[#f6f6f7]">
      {/* Brand panel */}
      <div className="hidden lg:flex flex-1 flex-col justify-between p-12 bg-gradient-to-br from-zinc-950 via-zinc-900 to-brand-950 text-white relative overflow-hidden">
        <div className="absolute -top-32 -right-32 w-96 h-96 rounded-full bg-brand-600/20 blur-3xl" />
        <div className="absolute bottom-0 left-0 w-80 h-80 rounded-full bg-violet-600/10 blur-3xl" />
        <div className="flex items-center gap-3 relative">
          <div className="w-10 h-10 rounded-lg bg-brand-600 flex items-center justify-center text-white font-bold text-lg shadow-lg">N</div>
          <div>
            <div className="text-[20px] font-bold tracking-tight leading-none">SNIPER</div>
            <div className="text-[10px] font-medium text-zinc-400 uppercase tracking-[0.12em] mt-1">Intelligent Lending Operating System</div>
          </div>
        </div>
        <div className="relative max-w-md">
          <h1 className="text-[30px] font-semibold leading-tight tracking-tight">India's lending operating system.</h1>
          <p className="text-zinc-400 text-[13.5px] mt-3 leading-relaxed">
            One platform for the complete loan lifecycle — acquisition, origination, credit decisioning, servicing, collections and compliance.
          </p>
          <div className="mt-8 grid grid-cols-3 gap-3">
            {[["LOS", "Origination"], ["LMS", "Servicing"], ["CRM", "Acquisition"]].map(([a, b]) => (
              <div key={a} className="rounded-lg border border-white/10 bg-white/5 backdrop-blur px-3 py-3">
                <div className="text-[18px] font-bold text-brand-300">{a}</div>
                <div className="text-[11px] text-zinc-400 mt-0.5">{b}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="relative flex items-center gap-2 text-[11px] text-zinc-500">
          <ShieldCheck size={13} className="text-emerald-400" />
          India-focused compliance-ready architecture · Multi-tenant · Audit-everything
        </div>
      </div>

      {/* Form panel */}
      <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto max-h-screen">
        <div className="w-full max-w-md py-6">
          <div className="lg:hidden flex items-center gap-2.5 mb-6">
            <div className="w-9 h-9 rounded-lg bg-brand-600 flex items-center justify-center text-white font-bold">N</div>
            <div>
              <div className="text-[16px] font-bold tracking-tight">SNIPER</div>
              <div className="text-[9.5px] text-zinc-500 uppercase tracking-[0.1em]">Lending OS</div>
            </div>
          </div>
          <h2 className="text-[20px] font-semibold tracking-tight text-zinc-900">Sign in to SNIPER</h2>
          <p className="text-[12.5px] text-zinc-500 mt-1">Your workspace awaits. Select any role below for 1-click login.</p>

          <form onSubmit={submit} className="mt-6 space-y-4">
            <div>
              <label className="label">Email</label>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
            </div>
            <div>
              <label className="label">Password</label>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </div>
            {err && <div className="text-[12px] text-rose-600 bg-rose-50 border border-rose-100 rounded-md px-3 py-2">{err}</div>}
            <button className="btn-primary w-full py-2 flex items-center justify-center gap-2" disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : null}
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>

          {/* Default Credentials Section */}
          <div className="mt-8 border-t border-zinc-200/80 pt-6">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-1.5">
                <KeyRound size={14} className="text-brand-600" />
                <span className="text-[12px] font-semibold text-zinc-900 tracking-tight">Default Demo Credentials</span>
              </div>
              <span className="text-[10px] font-mono text-zinc-500 bg-zinc-100 px-2 py-0.5 rounded border border-zinc-200">Password: demo1234</span>
            </div>

            {/* Category tabs */}
            <div className="flex items-center gap-1 overflow-x-auto pb-2 scrollbar-none text-[11px] font-medium text-zinc-500">
              {categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setFilter(cat)}
                  className={`px-2.5 py-1 rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                    filter === cat ? "bg-brand-600 text-white font-semibold shadow-sm" : "hover:bg-zinc-200/60 text-zinc-600"
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>

            {/* Scrollable list of default credentials */}
            <div className="mt-2.5 bg-white border border-zinc-200/90 rounded-xl divide-y divide-zinc-100 shadow-sm max-h-[300px] overflow-y-auto">
              {filteredUsers.map((d) => (
                <button
                  key={d.email}
                  type="button"
                  className={`w-full flex items-center justify-between px-3.5 py-2.5 hover:bg-brand-50/60 active:bg-brand-100/60 transition-colors text-left group cursor-pointer ${
                    email === d.email ? "bg-brand-50/50 border-l-2 border-l-brand-600" : ""
                  }`}
                  onClick={() => {
                    setEmail(d.email);
                    setPassword("demo1234");
                  }}
                >
                  <div className="pr-2 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[12.5px] font-semibold text-zinc-900 group-hover:text-brand-600 transition-colors truncate">
                        {d.label}
                      </span>
                      <span className="text-[9.5px] font-medium px-1.5 py-0.2 rounded bg-zinc-100 text-zinc-500 group-hover:bg-brand-100 group-hover:text-brand-700 transition-colors">
                        {d.category}
                      </span>
                    </div>
                    <div className="text-[11px] text-zinc-400 font-mono mt-0.5 truncate">{d.email}</div>
                    <div className="text-[10.5px] text-zinc-500 mt-0.5 line-clamp-1">{d.desc}</div>
                  </div>
                  <span className="text-[10.5px] text-zinc-500 font-mono bg-zinc-50 group-hover:bg-brand-600 group-hover:text-white px-2 py-1 rounded border border-zinc-200/60 transition-colors shrink-0">
                    Use
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
