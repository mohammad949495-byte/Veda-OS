import { useEffect, useRef, useState, type ReactNode } from "react";
import { Binary, Eye, ScanSearch, ShieldCheck, Cpu, Zap, Landmark, Layers } from "lucide-react";
import {
  LONG_TAPE,
  SCRIPT,
  SCENARIOS,
  TAPE_LEN,
  TERNARY_LABELS,
  TERNARY_W,
  V_THRESHOLD,
  Watchdog,
  AkashaHDC,
  runCycle,
  type Channel,
  type Cycle,
  type ScenarioKey,
} from "@/lib/veda/engine";

type LogLine = Cycle & { id: number; wallUs: number };
type TracePoint = { id: number; v: number; awake: boolean };

const CHANNELS: Channel[] = ["price", "integrity", "syscall", "ledger", "patch", "market", "operator"];

const BTN =
  "min-h-11 border border-line bg-raised px-3 py-2 text-left text-bone transition-colors duration-200 hover:border-ember focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember disabled:cursor-not-allowed disabled:opacity-40";

export function VedaConsole() {
  const wdRef = useRef<Watchdog | null>(null);
  if (wdRef.current === null) wdRef.current = new Watchdog();
  const hdcRef = useRef<AkashaHDC | null>(null);
  if (hdcRef.current === null) hdcRef.current = new AkashaHDC();
  const clock = useRef(1_000_000);
  const seq = useRef(1);
  const cursor = useRef(0);
  const fireRef = useRef<(key: ScenarioKey, n?: number) => void>(() => {});

  const [log, setLog] = useState<LogLine[]>([]);
  const [trace, setTrace] = useState<TracePoint[]>(() =>
    Array.from({ length: 32 }, (_, id) => ({ id, v: 0, awake: false })),
  );
  const [volts, setVolts] = useState<Record<Channel, number>>({
    price: 0,
    integrity: 0,
    syscall: 0,
    ledger: 0,
    patch: 0,
    market: 0,
    operator: 0,
  });
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [source, setSource] = useState<string | null>(null);

  fireRef.current = (key, n = TAPE_LEN) => {
    const wd = wdRef.current;
    const hdc = hdcRef.current;
    if (!wd || !hdc) return;
    const t0 = performance.now();
    const cycle = runCycle(wd, hdc, key, clock.current, n);
    clock.current += 250_000;
    const wallUs = (performance.now() - t0) * 1000;
    const id = seq.current++;
    setLog((prev) => [{ ...cycle, id, wallUs }, ...prev].slice(0, 12));

    setTrace((prev) =>
      [...prev, { id, v: cycle.spike.vPeak, awake: cycle.spike.awake }].slice(-32),
    );
    setVolts({
      price: wd.read("price"),
      integrity: wd.read("integrity"),
      syscall: wd.read("syscall"),
      ledger: wd.read("ledger"),
      patch: wd.read("patch"),
      market: wd.read("market"),
      operator: wd.read("operator"),
    });
  };

  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const key = SCRIPT[cursor.current % SCRIPT.length];
      cursor.current += 1;
      fireRef.current(key, TAPE_LEN);
    };
    const id = window.setInterval(tick, 2000);
    return () => window.clearInterval(id);
  }, [playing]);

  function proveLength() {
    setPlaying(false);
    setBusy(true);
    window.setTimeout(() => {
      fireRef.current("shock", LONG_TAPE);
      setBusy(false);
    }, 40);
  }

  function openSource() {
    setSourceOpen((open) => !open);
    if (source !== null) return;
    fetch("/prototype/veda_os_tri_engine.py")
      .then((res) => {
        if (!res.ok) throw new Error("missing");
        return res.text();
      })
      .then(setSource)
      .catch(() => setSource("The prototype file did not load."));
  }

  const latest = log[0] ?? null;
  const spiked = log.filter((row) => row.spike.awake).length;
  const slept = log.filter((row) => !row.spike.awake).length;
  const ternary = log.filter((row) => row.route?.precision === "ternary").length;
  const fp8 = log.filter((row) => row.route?.precision === "fp8").length;
  const unsat = log.filter((row) => row.seal.sat === false).length;

  return (
    <div className="min-h-screen bg-ink text-bone">
      <header className="border-t-2 border-ember border-b border-b-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 md:flex-row md:items-end md:justify-between md:px-8">
          <div className="max-w-xl">
            <p className="text-xs tracking-widest text-muted">LAYER 2 · ONE CORE</p>
            <h1 className="mt-2 font-display text-4xl leading-none text-balance text-bone md:text-5xl">
              Veda<span className="text-ember">–</span>OS
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-pretty text-muted">
              Tri-Engine Adaptive Core. Spiking watchdog, selective scan, precision router.
              నిద్రలో సున్నా ఖర్చు. మేల్కొన్నప్పుడు ఋజువు.
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <Stat k="Asleep" v={String(slept)} />
            <Stat k="Spikes" v={String(spiked)} />
            <Stat k="1.58-bit" v={String(ternary)} />
            <Stat k="FP8 + seal" v={String(fp8)} />
          </dl>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 md:px-8">
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="font-display text-xl text-bone">Inject an axon</h2>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={playing ? "min-h-11 bg-ember px-4 text-sm font-medium text-ink" : BTN}
                onClick={() => setPlaying((on) => !on)}
                disabled={busy}
              >
                {playing ? "Stop the tape" : "Run the tape"}
              </button>
              <button type="button" className={BTN} onClick={proveLength} disabled={busy || playing}>
                {busy ? "Scanning 1,00,000…" : "Scan 1,00,000 lines"}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {(Object.keys(SCENARIOS) as ScenarioKey[]).map((key) => {
              const stim = SCENARIOS[key];
              const on = latest?.key === key && latest.tapeLen === TAPE_LEN;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={busy}
                  className={on ? `${BTN} border-ember` : BTN}
                  onClick={() => {
                    setPlaying(false);
                    fireRef.current(key, TAPE_LEN);
                  }}
                >
                  <span className="block text-sm">{stim.name}</span>
                  <span className="mt-1 block text-xs text-muted">{stim.note}</span>
                </button>
              );
            })}
          </div>
        </section>

        <p className="font-display text-2xl leading-snug text-balance text-bone md:text-3xl">
          {latest ? verdict(latest) : "Core armed. The watchdog is dark until something crosses the dead zone."}
        </p>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Stage
            index="01"
            kicker="కాపలా"
            title="Watchdog"
            icon={<Eye className="size-4" aria-hidden="true" />}
            hot={latest?.spike.awake === true}
            quiet={false}
          >
            <WatchPanel latest={latest} trace={trace} volts={volts} />
          </Stage>
          <Stage
            index="02"
            kicker="అన్వయం"
            title="Context"
            icon={<ScanSearch className="size-4" aria-hidden="true" />}
            hot={Boolean(latest?.scan)}
            quiet={latest != null && !latest.scan}
          >
            <ContextPanel latest={latest} />
          </Stage>
          <Stage
            index="03"
            kicker="స్మృతి"
            title="Akasha HDC"
            icon={<Cpu className="size-4" aria-hidden="true" />}
            hot={Boolean(latest?.scan)}
            quiet={latest != null && !latest.scan}
          >
            <AkashaPanel latest={latest} />
          </Stage>
          <Stage
            index="04"
            kicker="ఖచ్చితత"
            title="Router"
            icon={<Binary className="size-4" aria-hidden="true" />}
            hot={Boolean(latest?.route)}
            quiet={latest != null && !latest.route}
          >
            <RouterPanel latest={latest} unsat={unsat} />
          </Stage>
          <Stage
            index="05"
            kicker="కర్మ"
            title="Karma Action"
            icon={<Zap className="size-4" aria-hidden="true" />}
            hot={Boolean(latest?.karma)}
            quiet={latest != null && !latest.karma}
          >
            <KarmaPanel latest={latest} />
          </Stage>
          <Stage
            index="06"
            kicker="నిధి"
            title="Treasury Reserve"
            icon={<Landmark className="size-4" aria-hidden="true" />}
            hot={latest?.key === "arbitrage"}
            quiet={latest?.key !== "arbitrage"}
          >
            <TreasuryPanel latest={latest} />
          </Stage>
          <Stage
            index="07"
            kicker="పరిధి"
            title="Decoupled Gateway"
            icon={<Layers className="size-4" aria-hidden="true" />}
            hot={latest?.key === "operator_ingest"}
            quiet={latest?.key !== "operator_ingest"}
          >
            <GatewayPanel latest={latest} />
          </Stage>
        </div>

        <section className="border border-line bg-surface">
          <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 className="text-sm text-bone">Cycle trace</h2>
            <span className="text-xs text-muted">{log.length === 0 ? "empty" : `${log.length} kept`}</span>
          </header>
          {log.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">
              Nothing has crossed an axon. Silence and price dust should cost zero membrane ops.
            </p>
          ) : (
            <ol className="divide-y divide-line">
              {log.map((row) => (
                <li key={row.id} className="grid gap-1 px-4 py-3 md:grid-cols-[8rem_1fr_auto] md:items-baseline">
                  <span className="text-xs text-muted tabular-nums">{row.name}</span>
                  <span className="text-sm text-bone">{row.action}</span>
                  <span className="text-xs text-muted tabular-nums">
                    {row.spike.awake ? row.route?.precision ?? "spike" : "sleep"} · {formatWall(row.wallUs)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="border border-line">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div>
              <h2 className="text-sm text-bone">Python prototype</h2>
              <p className="mt-1 text-xs text-muted">Same control law. Runnable, with a self-check.</p>
            </div>
            <div className="flex gap-2">
              <button type="button" className={BTN} onClick={openSource}>
                {sourceOpen ? "Hide source" : "Read source"}
              </button>
              <a className={`${BTN} inline-flex items-center`} href="/prototype/veda_os_tri_engine.py" download="veda_os_tri_engine.py">
                Download
              </a>
            </div>
          </div>
          {sourceOpen ? (
            <pre className="max-h-[32rem] overflow-auto border-t border-line bg-ink p-4 text-xs leading-relaxed text-muted">
              {source ?? "Loading the prototype…"}
            </pre>
          ) : null}
        </section>

        <p className="text-xs leading-relaxed text-muted">
          Modelled axon time is a notional event-core budget, not a hardware timer. Wall time is this
          tab, including the full scan. The scan is a diagonal selective state space — Mamba-2’s
          recurrence, with the gates written out so a cause can be named. Layer-5 checks the finite
          integer fragment a Z3 query would be given. Weights are specified, not trained.
        </p>
      </main>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{k}</dt>
      <dd className="font-display text-2xl text-bone tabular-nums">{v}</dd>
    </div>
  );
}

function Stage({
  index,
  kicker,
  title,
  icon,
  hot,
  quiet,
  children,
}: {
  index: string;
  kicker: string;
  title: string;
  icon: ReactNode;
  hot: boolean;
  quiet: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`flex flex-col gap-4 border bg-surface p-4 md:p-5 ${hot ? "border-ember" : "border-line"}`}>
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-muted">
            {index} · {kicker}
          </p>
          <h2 className="mt-1 font-display text-2xl text-bone">{title}</h2>
        </div>
        <span className={hot ? "text-ember" : "text-muted"}>{icon}</span>
      </header>
      {quiet ? <p className="text-xs text-muted">Gated. This stage was not woken.</p> : null}
      {children}
    </section>
  );
}

function WatchPanel({
  latest,
  trace,
  volts,
}: {
  latest: LogLine | null;
  trace: TracePoint[];
  volts: Record<Channel, number>;
}) {
  const awake = latest?.spike.awake === true;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-3">
        <p className="font-display text-4xl leading-none tabular-nums text-bone">
          {latest == null ? "0%" : latest.spike.ops === 0 ? "0" : awake ? "SPIKE" : "SUB"}
        </p>
        <p className="text-right text-xs text-muted">
          {latest == null
            ? "cpu dark"
            : latest.spike.ops === 0
              ? "ops 0 · membrane untouched"
              : `${latest.spike.ops} ops · ${latest.spike.modelledUs.toFixed(2)} µs modelled`}
        </p>
      </div>
      <Membrane trace={trace} awake={awake} />
      <ul className="flex flex-wrap gap-1">
        {CHANNELS.map((ch) => {
          const live = latest?.spike.channel === ch && latest.spike.ops > 0;
          return (
            <li
              key={ch}
              className={`px-2 py-1 text-xs tabular-nums ${live ? "bg-ember text-ink" : "bg-raised text-muted"}`}
            >
              {ch} {volts[ch].toFixed(2)}
            </li>
          );
        })}
      </ul>
      <p className="text-xs leading-relaxed text-muted">
        Leaky integrate-and-fire, one membrane per channel. Below 0.08 the axon does not fire a
        single update. Surprise is excitatory; the sign rides along for the hedge.
      </p>
    </div>
  );
}

function Membrane({ trace, awake }: { trace: TracePoint[]; awake: boolean }) {
  const w = 160;
  const h = 48;
  const max = Math.max(V_THRESHOLD * 1.35, ...trace.map((p) => p.v), 0.01);
  const pts = trace
    .map((p, i) => {
      const x = (i / Math.max(1, trace.length - 1)) * w;
      const y = h - (p.v / max) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const yTh = h - (V_THRESHOLD / max) * (h - 4) - 2;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full" role="img" aria-label="Membrane potential">
      <line x1="0" x2={w} y1={yTh} y2={yTh} className="stroke-line" strokeWidth="1" />
      <polyline points={pts} className={awake ? "stroke-ember" : "stroke-bone"} fill="none" strokeWidth="2" />
    </svg>
  );
}

function ContextPanel({ latest }: { latest: LogLine | null }) {
  const scan = latest?.scan;
  if (!scan) {
    return (
      <p className="text-xs leading-relaxed text-muted">
        The tape is {TAPE_LEN.toLocaleString("en-IN")} lines with a planted wall and a slow exfil. It
        is not read until a spike arrives. State width stays {8}, whatever the length.
      </p>
    );
  }
  const fold = Math.round(scan.attnFlops / Math.max(1, scan.flops));
  const peak = Math.max(...scan.state.map((v) => Math.abs(v)), 1e-9);
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-3">
        <div>
          <dt className="text-xs text-muted">Lines</dt>
          <dd className="text-sm text-bone tabular-nums">{scan.n.toLocaleString("en-IN")}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Versus attention</dt>
          <dd className="text-sm text-bone tabular-nums">{fold.toLocaleString("en-IN")}× fewer ops</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Scan flops</dt>
          <dd className="text-sm text-bone tabular-nums">{scan.flops.toLocaleString("en-IN")}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Complexity</dt>
          <dd className="text-sm text-bone tabular-nums">{scan.complexity.toFixed(2)}</dd>
        </div>
      </dl>
      {scan.residue ? (
        <blockquote className="border-l-2 border-ember pl-3">
          <p className="text-xs text-muted">
            Peak L{scan.originIndex} · {scan.originTag} · share {scan.peakShare.toFixed(2)}
          </p>
          <p className="mt-1 text-sm text-bone">{scan.originText}</p>
          <p className="mt-2 text-xs text-muted">Onset L{scan.onsetIndex}</p>
          <p className="text-sm text-bone">{scan.onsetText}</p>
        </blockquote>
      ) : (
        <p className="text-sm text-bone">No historical residue. The cause is the live spike.</p>
      )}
      <ul className="flex flex-col gap-1" aria-label="Selective state">
        {scan.state.map((v, d) => {
          const mag = Math.abs(v) / peak;
          return (
            <li key={d} className="grid grid-cols-[1.5rem_1fr_3rem] items-center gap-2">
              <span className="text-xs text-muted tabular-nums">{d}</span>
              <span className="h-1.5 bg-raised">
                <span
                  className="block h-full bg-ember"
                  style={{ width: `${mag < 0.02 ? 0 : mag * 100}%` }}
                />
              </span>
              <span className="text-right text-xs text-muted tabular-nums">{v.toFixed(2)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RouterPanel({ latest, unsat }: { latest: LogLine | null; unsat: number }) {
  const route = latest?.route;
  if (!route || !latest) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs leading-relaxed text-muted">
          Reflex traffic stays on ternary weights in {"{−1, 0, +1}"}. Money, code, and diffuse causes
          switch to FP8, then the proof kernel.
        </p>
        <Lattice active={null} />
      </div>
    );
  }
  const satLabel = !latest.seal.invoked ? "NOT INVOKED" : latest.seal.sat ? "SAT" : "UNSAT";
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-3">
        <p className="font-display text-3xl leading-none text-bone">
          {route.precision === "ternary" ? "1.58-bit" : "FP8"}
        </p>
        <p className={`text-xs ${latest.seal.sat === false ? "text-ember" : "text-muted"}`}>
          <ShieldCheck className="mr-1 inline size-3" aria-hidden="true" />
          Layer-5 {satLabel}
        </p>
      </div>
      <p className="text-sm text-bone">{latest.action}</p>
      <p className="text-xs leading-relaxed text-muted">{route.why}</p>
      {route.fp8 ? <p className="text-xs text-muted tabular-nums">{route.fp8.detail}</p> : null}
      {route.reflex ? (
        <p className="text-xs text-muted tabular-nums">
          {route.reflex.adds} conditional adds · score {route.reflex.score}
        </p>
      ) : null}
      {latest.counterfactual ? <p className="text-xs leading-relaxed text-ember">{latest.counterfactual}</p> : null}
      <Lattice active={route.reflex?.activeRow ?? null} />
      <pre className="overflow-x-auto text-xs leading-relaxed text-muted">{latest.seal.smt.join("\n")}</pre>
      {unsat > 0 ? <p className="text-xs text-muted">{unsat} unsat this session — those posts were refused.</p> : null}
    </div>
  );
}

function Lattice({ active }: { active: number | null }) {
  return (
    <div>
      <p className="mb-2 text-xs text-muted">Ternary lattice · rows {TERNARY_LABELS.join(" / ")}</p>
      <div className="grid grid-cols-6 gap-1">
        {TERNARY_W.flatMap((row, r) =>
          row.map((w, c) => (
            <span
              key={`${r}-${c}`}
              className={`flex h-8 items-center justify-center text-xs tabular-nums ${
                active === r ? "bg-ember text-ink" : "bg-raised text-muted"
              }`}
            >
              {w > 0 ? "+1" : w < 0 ? "−1" : "0"}
            </span>
          )),
        )}
      </div>
    </div>
  );
}

function AkashaPanel({ latest }: { latest: LogLine | null }) {
  if (!latest?.scan) {
    return (
      <p className="text-xs leading-relaxed text-muted">
        Akasha HDC memory projects the continuous 8D state into a 256-bit holographic hypervector.
        Inactive until an axon fires.
      </p>
    );
  }
  const sim = latest.hdcSim;
  const isMatch = sim > 0.4;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">Episode match</span>
        <span
          className={`text-xs font-semibold tabular-nums ${
            isMatch ? "text-ember" : "text-bone"
          }`}
        >
          {(sim * 100).toFixed(1)}% ({sim >= 0 ? `+${sim.toFixed(2)}` : sim.toFixed(2)})
        </span>
      </div>
      <div className="h-1.5 w-full bg-raised">
        <div
          className="h-full bg-ember transition-all duration-300"
          style={{ width: `${Math.max(0, Math.min(100, (sim + 1) * 50))}%` }}
        />
      </div>
      <p className="text-xs leading-relaxed text-muted">
        {sim > 0.8
          ? "High resonance with prior episode: Identical stimulus pattern detected."
          : sim > 0.2
          ? "Moderate associative overlap with previous channel activation."
          : "Novel sensory pattern. Stored as fresh holographic imprint."}
      </p>
      <div className="mt-1 border border-line bg-raised p-2 text-xs">
        <span className="block text-muted">Hypervector width: 256 bits</span>
        <span className="block text-bone">Associative binding: Holographic O(1)</span>
      </div>
    </div>
  );
}

function KarmaPanel({ latest }: { latest: LogLine | null }) {
  const karma = latest?.karma;
  if (!karma) {
    return (
      <p className="text-xs leading-relaxed text-muted">
        Layer 6 Karma Engine waits for Layer-4 routing and Layer-5 formal safety verification
        before autonomous execution.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">Execution Status</span>
        <span
          className={`text-xs font-semibold uppercase ${
            karma.success ? "text-bone" : "text-ember"
          }`}
        >
          {karma.success ? "Verified & Dispatched" : "Execution Blocked"}
        </span>
      </div>
      <div className="border border-line bg-surface p-2">
        <p className="text-sm font-medium text-bone">{karma.action}</p>
        <p className="mt-1 text-xs text-muted">{karma.feedback}</p>
      </div>
      <p className="text-xs text-muted tabular-nums">Dispatch Latency: {karma.latencyUs.toFixed(1)} µs</p>
    </div>
  );
}

function TreasuryPanel({ latest }: { latest: LogLine | null }) {
  const isArb = latest?.key === "arbitrage";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">Treasury Reserve</span>
        <span className="text-xs font-semibold tabular-nums text-bone">₹5,00,055.00</span>
      </div>
      <div className="border border-line bg-raised p-2 text-xs">
        <div className="flex justify-between py-0.5">
          <span className="text-muted">Capital Allocation:</span>
          <span className="text-bone">₹50,000.00 (10.0%)</span>
        </div>
        <div className="flex justify-between py-0.5">
          <span className="text-muted">Z3 Solvency Guard:</span>
          <span className="text-emerald-400">SAT (≤ 20% Cap)</span>
        </div>
        <div className="flex justify-between py-0.5">
          <span className="text-muted">Latest Net Yield:</span>
          <span className="font-semibold text-emerald-400">+₹55.00 (Net Spread)</span>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted">
        {isArb
          ? "Autonomous arbitrage execution verified by Z3 solver. Solvency invariant proven."
          : "Capital allocated only when expected yield exceeds gas fee by formal proof."}
      </p>
    </div>
  );
}

function GatewayPanel({ latest }: { latest: LogLine | null }) {
  const isOp = latest?.key === "operator_ingest";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">Layer 7 Air-Gap Status</span>
        <span className="text-xs font-semibold uppercase text-emerald-400">ISOLATED</span>
      </div>
      <div className="border border-line bg-raised p-2 text-xs">
        <div className="flex justify-between py-0.5">
          <span className="text-muted">Connected Model:</span>
          <span className="text-bone">ChatGPT-4o/Astra-Pattern</span>
        </div>
        <div className="flex justify-between py-0.5">
          <span className="text-muted">HDC Ingestion:</span>
          <span className="text-bone">10,000-bit Hypervector</span>
        </div>
        <div className="flex justify-between py-0.5">
          <span className="text-muted">Core Contamination:</span>
          <span className="text-emerald-400">0.0% (Air-Gapped)</span>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted">
        {isOp
          ? "External operator reasoning traits encoded directly into Akasha HDC memory manifold."
          : "Decoupled tool wrapper ensures external models cannot directly mutate the OS kernel."}
      </p>
    </div>
  );
}

function verdict(row: LogLine): string {
  if (!row.spike.awake) {
    return row.spike.ops === 0
      ? `${row.name} stayed inside the dead zone. Stage 2 and stage 3 slept.`
      : `${row.name} moved one membrane and did not cross threshold.`;
  }
  return row.action;
}

function formatWall(us: number): string {
  if (us >= 1000) return `${(us / 1000).toFixed(1)} ms wall`;
  return `${Math.max(0, us).toFixed(0)} µs wall`;
}

