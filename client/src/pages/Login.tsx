import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ShieldCheck, AlertTriangle, Loader2 } from "lucide-react";
import { useAuth } from "../lib/auth";

const DEMO_USERS = [
  { email: "admin@nexus.demo", label: "Admin", desc: "Full platform access" },
  { email: "credit@nexus.demo", label: "Credit", desc: "Underwriting & approvals" },
  { email: "collections@nexus.demo", label: "Collections", desc: "Recovery & PTPs" },
  { email: "dsa@nexus.demo", label: "DSA", desc: "Lead & application intake" },
  { email: "sales@nexus.demo", label: "Sales", desc: "CRM & pipeline" },
  { email: "customer@nexus.demo", label: "Customer", desc: "Customer portal" }
];

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("admin@nexus.demo");
  const [password, setPassword] = useState("demo1234");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

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
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="lg:hidden flex items-center gap-2.5 mb-8">
            <div className="w-9 h-9 rounded-lg bg-brand-600 flex items-center justify-center text-white font-bold">N</div>
            <div>
              <div className="text-[16px] font-bold tracking-tight">SNIPER</div>
              <div className="text-[9.5px] text-zinc-500 uppercase tracking-[0.1em]">Lending OS</div>
            </div>
          </div>
          <h2 className="text-[20px] font-semibold tracking-tight text-zinc-900">Sign in to SNIPER</h2>
          <p className="text-[12.5px] text-zinc-500 mt-1">Your workspace awaits.</p>

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
            <button className="btn-primary w-full py-2" disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : null}
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <div className="mt-6">
            <div className="flex items-center gap-1.5 mb-2.5">
              <AlertTriangle size={12} className="text-amber-500" />
              <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Demo Credentials — One-click Login</span>
            </div>
            <div className="bg-white border border-zinc-200/90 rounded-xl divide-y divide-zinc-100 shadow-sm overflow-hidden">
              {DEMO_USERS.map((d) => (
                <button
                  key={d.email}
                  type="button"
                  className="w-full flex items-center justify-between px-3.5 py-2.5 hover:bg-zinc-50/80 active:bg-zinc-100 transition-colors text-left group cursor-pointer"
                  onClick={() => {
                    setEmail(d.email);
                    setPassword("demo1234");
                  }}
                >
                  <div>
                    <div className="text-[12.5px] font-semibold text-zinc-900 group-hover:text-brand-600 transition-colors">
                      {d.label} <span className="text-zinc-400 font-normal">· {d.email}</span>
                    </div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">{d.desc}</div>
                  </div>
                  <span className="text-[11px] text-zinc-400 font-mono bg-zinc-50 group-hover:bg-brand-50 group-hover:text-brand-600 px-2 py-0.5 rounded border border-zinc-200/60 transition-colors">
                    demo1234
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
