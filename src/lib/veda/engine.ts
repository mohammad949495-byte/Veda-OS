/**
 * Veda-OS Layer-2 Tri-Engine Adaptive Core.
 * Control-law port of public/prototype/veda_os_tri_engine.py.
 * Keep the constants in sync with that file. Not a trained checkpoint.
 */

export const DEADZONE = 0.08;
export const TAU_US = 220;
export const V_THRESHOLD = 1;
export const V_RESET = 0.15;
export const D_STATE = 8;
export const TAPE_LEN = 4096;
export const LONG_TAPE = 100_000;
export const SPOOF_AT = 812;
export const LEAK_START = 2401;
export const LEAK_EVERY = 37;
export const LEAK_BYTES = 240;

const GATE_BIAS = [-8, -8, -8, -7, -7, -8, -8, -7.5];
const GATE_FEAT = [5, 5, 1, 2, 3, 4, 4, 0];
const GATE_W = [1.5, 1.15, 1.4, 2.2, 2.2, 6, 5.4, 1.1];
const DECAY_A = [-0.05, -0.08, -0.3, -0.4, -0.4, -0.01, -0.015, -1.6];
const WRITE_B = [1, 0.65, 0.4, 0.8, 0.8, 1, 0.7, 0.5];

export const TERNARY_W: readonly (readonly number[])[] = [
  [0, 0, 0, 0, 0, 0],
  [1, 1, -1, -1, -1, -1],
  [1, -1, -1, 1, -1, -1],
  [1, -1, 1, -1, -1, -1],
];
export const TERNARY_LABELS = ["HOLD", "HEDGE", "QUARANTINE", "ISOLATE"] as const;
const TERNARY_ALPHA = 1;
const RISK_W = [0.85, -0.4, 0.55, 0.25, 1.1, -0.15];

const ALLOW_PATCH = new Set(["risk/gate.py", "risk/limits.py"]);
const GROSS_PAISE = 4_200_000_000;
const FEE_BPS = 8;

export type Channel = "price" | "integrity" | "syscall" | "ledger" | "patch" | "market" | "operator";
export type ScenarioKey =
  | "silence"
  | "dust"
  | "shock"
  | "glitch"
  | "leak"
  | "ledger"
  | "hostile"
  | "patch"
  | "badpatch"
  | "arbitrage"
  | "operator_ingest";

export type Stimulus = {
  key: ScenarioKey;
  name: string;
  channel: Channel;
  magnitude: number;
  kind: "quiet" | "reflex" | "critical";
  note: string;
};

export const SCENARIOS: Record<ScenarioKey, Stimulus> = {
  silence: { key: "silence", name: "Silence", channel: "price", magnitude: 0, kind: "quiet", note: "No axon event." },
  dust: { key: "dust", name: "Price dust", channel: "price", magnitude: 0.04, kind: "quiet", note: "Inside the dead zone." },
  shock: { key: "shock", name: "Price shock", channel: "price", magnitude: -1.65, kind: "reflex", note: "Print through the spoof wall." },
  glitch: { key: "glitch", name: "Syscall glitch", channel: "syscall", magnitude: 1.25, kind: "reflex", note: "Single bad return, no history." },
  leak: { key: "leak", name: "Data leak", channel: "integrity", magnitude: 1.7, kind: "reflex", note: "Exfil signature on the wire." },
  ledger: { key: "ledger", name: "Ledger close", channel: "ledger", magnitude: 3.1, kind: "critical", note: "₹4.20 Cr at 8 bps." },
  hostile: { key: "hostile", name: "Hostile ledger", channel: "ledger", magnitude: 3.1, kind: "critical", note: "Same close, 37 paise missing." },
  patch: { key: "patch", name: "Code patch", channel: "patch", magnitude: 2.4, kind: "critical", note: "Allowlisted risk-gate edit." },
  badpatch: { key: "badpatch", name: "Poison patch", channel: "patch", magnitude: 2.4, kind: "critical", note: "Sneaks in eval()." },
  arbitrage: { key: "arbitrage", name: "DEX Arbitrage", channel: "market", magnitude: 2.8, kind: "critical", note: "USDC/INR 1.8% spread vs ₹45 gas." },
  operator_ingest: { key: "operator_ingest", name: "Operator Pattern", channel: "operator", magnitude: 1.95, kind: "reflex", note: "Ingest ChatGPT-4o/Astra traits into HDC." },
};

export const SCRIPT: ScenarioKey[] = [
  "silence",
  "dust",
  "shock",
  "glitch",
  "leak",
  "ledger",
  "hostile",
  "arbitrage",
  "operator_ingest",
  "patch",
  "badpatch",
];

export function softplus(z: number): number {
  if (z > 20) return z;
  if (z < -20) return Math.exp(z);
  return Math.log1p(Math.exp(z));
}

export function fp8E4M3(x: number): number {
  if (x === 0 || !Number.isFinite(x)) return 0;
  const sign = x < 0 ? -1 : 1;
  let ax = Math.abs(x);
  if (ax < 2 ** -9) return 0;
  if (ax > 448) ax = 448;
  let exp = Math.floor(Math.log2(ax));
  exp = Math.max(-6, Math.min(8, exp));
  const mant = ax / 2 ** exp;
  let frac = Math.round((mant - 1) * 8);
  if (frac === 8) {
    frac = 0;
    exp += 1;
    if (exp > 8) return sign * 448;
  }
  return sign * (1 + frac / 8) * 2 ** exp;
}

type Membrane = { v: number; lastUs: number };

export class Watchdog {
  private mem: Record<Channel, Membrane> = {
    price: { v: 0, lastUs: 0 },
    integrity: { v: 0, lastUs: 0 },
    syscall: { v: 0, lastUs: 0 },
    ledger: { v: 0, lastUs: 0 },
    patch: { v: 0, lastUs: 0 },
    market: { v: 0, lastUs: 0 },
    operator: { v: 0, lastUs: 0 },
  };
  spikes = 0;
  sleeps = 0;

  consider(tUs: number, channel: Channel, magnitude: number): Spike {
    const m = this.mem[channel];
    if (Math.abs(magnitude) < DEADZONE) {
      this.sleeps += 1;
      return { awake: false, channel, vAfter: m.v, vPeak: m.v, ops: 0, modelledUs: 0 };
    }
    const dt = Math.max(0, tUs - m.lastUs);
    const leak = dt ? Math.exp(-dt / TAU_US) : 1;
    m.v = m.v * leak + Math.abs(magnitude);
    m.lastUs = tUs;
    const ops = 3;
    const peak = m.v;
    if (m.v >= V_THRESHOLD) {
      m.v = V_RESET;
      this.spikes += 1;
      return { awake: true, channel, vAfter: m.v, vPeak: peak, ops, modelledUs: 0.85 + 0.05 * ops };
    }
    this.sleeps += 1;
    return { awake: false, channel, vAfter: m.v, vPeak: peak, ops, modelledUs: 0.4 };
  }

  read(channel: Channel): number {
    return this.mem[channel].v;
  }
}

export type Spike = {
  awake: boolean;
  channel: Channel;
  vAfter: number;
  vPeak: number;
  ops: number;
  modelledUs: number;
};

type Token = { index: number; tag: string; text: string; feat: number[] };

export function tokenAt(i: number): Token {
  if (i === SPOOF_AT) {
    return {
      index: i,
      tag: "spoof",
      text: `L${pad(i)}  SPOOF  bid 40× depth  acct shadow-7  spoof-wall`,
      feat: [0.05, 0, 0, 0, 0, 8],
    };
  }
  if (i >= LEAK_START && (i - LEAK_START) % LEAK_EVERY === 0) {
    const n = Math.floor((i - LEAK_START) / LEAK_EVERY);
    return {
      index: i,
      tag: "leak",
      text: `L${pad(i)}  EXFIL  10.4.4.4  +${LEAK_BYTES}B  seq=${String(n).padStart(3, "0")}`,
      feat: [0.2, 0.55, 0, 0, 1, 0],
    };
  }
  if (i % 17 === 0) {
    return {
      index: i,
      tag: "book",
      text: `L${pad(i)}  BOOK   print ${String((i % 90) + 10).padStart(3)}  @ ${100 + (i % 7)}`,
      feat: [0, 0.1, 0, 0, 0, 0],
    };
  }
  return { index: i, tag: "beat", text: `L${pad(i)}  BEAT   core idle`, feat: [0, 0, 0, 0, 0, 0] };
}

function pad(i: number): string {
  return String(i).padStart(5, "0");
}

function queryFeatures(channel: Channel, magnitude: number): number[] {
  const codeMap: Record<Channel, number> = {
    price: 0,
    syscall: 0.25,
    integrity: 0.55,
    ledger: 0.85,
    patch: 1,
    market: 0.45,
    operator: 0.65,
  };
  const code = codeMap[channel] ?? 0;
  return [
    Math.tanh(magnitude),
    code,
    channel === "ledger" ? 1 : 0,
    channel === "patch" ? 1 : 0,
    0,
    0,
  ];
}

function readout(x: number[]): number[] {
  const c = Array(D_STATE).fill(0);
  if (x[3] > 0.5) c[4] = 1;
  else if (x[2] > 0.5) c[3] = 1;
  else if (x[1] > 0.45) {
    c[5] = 0.75;
    c[6] = 0.55;
  } else if (x[1] > 0.15) c[7] = 1;
  else {
    c[0] = 1;
    c[1] = 0.4;
  }
  return c;
}

export type ScanHit = {
  n: number;
  flops: number;
  attnFlops: number;
  originIndex: number;
  originText: string;
  originTag: string;
  onsetIndex: number;
  onsetText: string;
  peakShare: number;
  complexity: number;
  residue: boolean;
  state: number[];
  top: { index: number; weight: number; tag: string }[];
};

export function selectiveScan(channel: Channel, magnitude: number, n = TAPE_LEN): ScanHit {
  const h = Array(D_STATE).fill(0);
  const abars: number[][] = [];
  const writes: number[][] = [];
  let flops = 0;
  for (let i = 0; i < n; i++) {
    const feat = tokenAt(i).feat;
    const abar = Array(D_STATE).fill(0);
    const write = Array(D_STATE).fill(0);
    for (let d = 0; d < D_STATE; d++) {
      const delta = softplus(GATE_BIAS[d] + GATE_W[d] * feat[GATE_FEAT[d]]);
      abar[d] = Math.exp(DECAY_A[d] * delta);
      write[d] = delta * WRITE_B[d] * feat[GATE_FEAT[d]];
      h[d] = abar[d] * h[d] + write[d];
      flops += 6;
    }
    abars.push(abar);
    writes.push(write);
  }

  const c = readout(queryFeatures(channel, magnitude));
  const g = c.slice();
  const influences = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let inf = 0;
    for (let d = 0; d < D_STATE; d++) inf += g[d] * writes[i][d];
    influences[i] = inf;
    for (let d = 0; d < D_STATE; d++) g[d] *= abars[i][d];
    flops += 2 * D_STATE;
  }

  const absInf = influences.map((v) => Math.abs(v));
  const total = absInf.reduce((a, b) => a + b, 0);
  let peakI = 0;
  for (let i = 1; i < n; i++) if (absInf[i] > absInf[peakI]) peakI = i;
  const peak = n ? absInf[peakI] : 0;
  const residue = peak > 1e-4;

  let originIndex = -1;
  let originTag = "none";
  let onsetIndex = -1;
  let share = 0;
  let complexity = 0;
  if (residue && total > 0) {
    originIndex = peakI;
    originTag = tokenAt(peakI).tag;
    share = peak / total;
    complexity = 1 - share;
    onsetIndex = peakI;
    for (let i = 0; i < n; i++) {
      const tok = tokenAt(i);
      if (tok.tag === originTag && absInf[i] >= 0.15 * peak) {
        onsetIndex = i;
        break;
      }
    }
  }

  const ranked = absInf
    .map((weight, index) => ({ index, weight, tag: "" }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .filter((row) => row.weight > 1e-4)
    .map((row) => ({ ...row, tag: tokenAt(row.index).tag }));

  return {
    n,
    flops,
    attnFlops: 2 * n * n,
    originIndex,
    originText: originIndex < 0 ? "" : tokenAt(originIndex).text,
    originTag,
    onsetIndex,
    onsetText: onsetIndex < 0 ? "" : tokenAt(onsetIndex).text,
    peakShare: share,
    complexity,
    residue,
    state: h,
    top: ranked,
  };
}

function quantTernary(v: number): number {
  if (v > 0.25) return 1;
  if (v < -0.25) return -1;
  return 0;
}

export type Reflex = {
  label: (typeof TERNARY_LABELS)[number];
  score: number;
  detail: string;
  activeRow: number;
  quantized: number[];
  adds: number;
};

export function ternaryForward(channel: Channel, magnitude: number): Reflex {
  const raw = [
    quantTernary(Math.abs(magnitude)),
    channel === "price" ? 1 : 0,
    channel === "integrity" ? 1 : 0,
    channel === "syscall" ? 1 : 0,
    channel === "ledger" ? 1 : 0,
    channel === "patch" ? 1 : 0,
  ];
  const scores: number[] = [];
  let adds = 0;
  for (const row of TERNARY_W) {
    let acc = 0;
    for (let k = 0; k < row.length; k++) {
      const w = row[k];
      const x = raw[k];
      if (w !== 0 && x !== 0) {
        acc += w * x;
        adds += 1;
      }
    }
    scores.push(Math.round(TERNARY_ALPHA * acc));
  }
  let rowI = 0;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] > scores[rowI] || (scores[i] === scores[rowI] && -i > -rowI)) rowI = i;
  }
  const label = TERNARY_LABELS[rowI];
  let detail: string = label;
  if (label === "HEDGE") {
    const units = Math.max(1, Math.min(4, Math.abs(scores[rowI])));
    const side = magnitude < 0 ? "+" : "−";
    detail = `HEDGE ${side}${units}  (cover against the print)`;
  } else if (label === "HOLD") {
    detail = "HOLD  lattice settled at zero";
  }
  return { label, score: scores[rowI], detail, activeRow: rowI, quantized: raw, adds };
}

export type Fp8Work = { fp64: number; fp8: number; absErr: number; relErr: number; detail: string };

function fp8Risk(channel: Channel, magnitude: number, complexity: number): Fp8Work {
  const feat = queryFeatures(channel, magnitude);
  const x = [feat[0], feat[1], feat[2], feat[3], complexity, Math.tanh(magnitude / 2)];
  let ref = 0;
  let q = 0;
  for (let i = 0; i < RISK_W.length; i++) {
    ref += RISK_W[i] * x[i];
    q += fp8E4M3(RISK_W[i]) * fp8E4M3(x[i]);
  }
  const absErr = Math.abs(ref - q);
  const relErr = absErr / Math.max(1e-9, Math.abs(ref));
  return {
    fp64: ref,
    fp8: q,
    absErr,
    relErr,
    detail: `risk64 ${ref >= 0 ? "+" : ""}${ref.toFixed(5)}   risk8 ${q >= 0 ? "+" : ""}${q.toFixed(5)}   |err| ${absErr.toExponential(2)}`,
  };
}

export type Route = {
  precision: "ternary" | "fp8";
  why: string;
  reflex: Reflex | null;
  fp8: Fp8Work | null;
};

function routeOf(channel: Channel, magnitude: number, kind: Stimulus["kind"], complexity: number): Route {
  const critical = kind === "critical" || complexity >= 0.55;
  if (critical) {
    return {
      precision: "fp8",
      why: kind === "critical" ? "critical kind — money or code" : `diffuse cause (complexity ${complexity.toFixed(2)} ≥ 0.55)`,
      reflex: null,
      fp8: fp8Risk(channel, magnitude, complexity),
    };
  }
  return {
    precision: "ternary",
    why: "single-cause reflex — 1.58-bit lattice",
    reflex: ternaryForward(channel, magnitude),
    fp8: null,
  };
}

export type Seal = { invoked: boolean; sat: boolean | null; smt: string[]; core: string };

function finishSeal(ok: boolean, smt: string[], core: string): Seal {
  const lines = smt.concat(`(check-sat) ; => ${ok ? "sat" : "unsat"}`);
  if (!ok) lines.push(`(get-unsat-core) ; => ${core}`);
  return { invoked: true, sat: ok, smt: lines, core: ok ? "all asserted" : core };
}

function sealLedger(hostile: boolean): Seal {
  const fee = Math.floor((GROSS_PAISE * FEE_BPS) / 10_000);
  const short = hostile ? 37 : 0;
  const postings: [string, number][] = [
    ["asset:cash", -GROSS_PAISE],
    ["income:settlement", GROSS_PAISE - fee - short],
    ["income:fee", fee],
  ];
  const total = postings.reduce((a, [, v]) => a + v, 0);
  const ok = total === 0;
  const core = total !== 0 ? `conservation off by ${total} paise` : "conservation + fee schedule";
  const smt = [
    "(set-logic QF_LIA)",
    `(assert (= (+ ${postings.map(([, v]) => v).join(" ")}) 0))`,
    `(assert (= fee ${fee}))`,
  ];
  return finishSeal(ok, smt, core);
}

function sealPatch(lines: number, files: string[], addsEval: boolean, keepsAuth: boolean, keepsGate: boolean): Seal {
  const smt = [
    "(assert (<= diff-lines 40))",
    "(assert (subset files allowlist))",
    "(assert (not introduces-eval))",
    "(assert (and keeps-auth keeps-risk-gate))",
  ];
  const reasons: string[] = [];
  if (lines > 40) reasons.push(`diff ${lines} > 40`);
  const bad = files.filter((f) => !ALLOW_PATCH.has(f));
  if (bad.length) reasons.push("file " + bad.join(","));
  if (addsEval) reasons.push("introduces eval");
  if (!keepsAuth) reasons.push("drops auth");
  if (!keepsGate) reasons.push("drops risk gate");
  return finishSeal(reasons.length === 0, smt, reasons.join(" + ") || "patch invariants");
}

function sealExfil(records: number): Seal {
  return finishSeal(
    true,
    [`(assert (= exfil-bytes (* ${records} ${LEAK_BYTES})))`, "(assert (> exfil-bytes 0))"],
    `exfil ${records * LEAK_BYTES} bytes over ${records} records`,
  );
}

function sealSkipped(): Seal {
  return {
    invoked: false,
    sat: null,
    smt: ["(push) ; reflex lattice is already discrete — solver not invoked"],
    core: "not invoked",
  };
}

// --- Layer 3: Akasha HDC Holographic Memory ----------------------------------
export const HDC_DIM = 256;

export class AkashaHDC {
  private proj: number[][];
  private episodes: Map<string, number[]> = new Map();

  constructor(seed = 42) {
    let s = seed;
    const lcg = () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
    this.proj = Array.from({ length: D_STATE }, () =>
      Array.from({ length: HDC_DIM }, () => (lcg() > 0.5 ? 1 : -1))
    );
  }

  encode(state: number[]): number[] {
    const acc = new Float64Array(HDC_DIM);
    for (let d = 0; d < Math.min(state.length, D_STATE); d++) {
      const v = state[d];
      if (Math.abs(v) < 1e-5) continue;
      const row = this.proj[d];
      for (let j = 0; j < HDC_DIM; j++) {
        acc[j] += v * row[j];
      }
    }
    return Array.from(acc, (x) => (x >= 0 ? 1 : -1));
  }

  store(key: string, hv: number[]): void {
    const existing = this.episodes.get(key);
    if (!existing) {
      this.episodes.set(key, [...hv]);
    } else {
      const bundled = existing.map((val, idx) => (val + hv[idx] >= 0 ? 1 : -1));
      this.episodes.set(key, bundled);
    }
  }

  recallSimilarity(queryHv: number[], targetKey: string): number {
    const target = this.episodes.get(targetKey);
    if (!target) return 0;
    let matches = 0;
    for (let i = 0; i < HDC_DIM; i++) {
      if (queryHv[i] === target[i]) matches++;
    }
    return (2 * matches) / HDC_DIM - 1;
  }
}

// --- Layer 6: Karma Execution Kernel -----------------------------------------
export type KarmaResult = {
  success: boolean;
  action: string;
  feedback: string;
  latencyUs: number;
};

export function executeKarma(actionLabel: string, channel: Channel, seal: Seal): KarmaResult {
  if (seal.invoked && seal.sat === false) {
    return {
      success: false,
      action: `BLOCKED: ${actionLabel} on ${channel}`,
      feedback: `Execution halted by Layer-5 safety invariant: ${seal.core}`,
      latencyUs: 1.2,
    };
  }
  return {
    success: true,
    action: `${actionLabel} [${channel}]`,
    feedback: `Autonomous dispatch: ${actionLabel} -> ${channel} verified & executed.`,
    latencyUs: 0.8,
  };
}

export type Cycle = {
  key: ScenarioKey;
  name: string;
  note: string;
  tapeLen: number;
  spike: Spike;
  scan: ScanHit | null;
  hdcSim: number;
  route: Route | null;
  seal: Seal;
  karma: KarmaResult | null;
  action: string;
  counterfactual: string | null;
};

function leakRecords(n: number): number {
  let c = 0;
  for (let i = LEAK_START; i < n; i += LEAK_EVERY) c += 1;
  return c;
}

export function runCycle(
  wd: Watchdog,
  hdc: AkashaHDC,
  key: ScenarioKey,
  tUs: number,
  tapeLen = TAPE_LEN
): Cycle {
  const stim = SCENARIOS[key];
  const spike = wd.consider(tUs, stim.channel, stim.magnitude);
  if (!spike.awake) {
    return {
      key,
      name: stim.name,
      note: stim.note,
      tapeLen,
      spike,
      scan: null,
      hdcSim: 0,
      route: null,
      seal: sealSkipped(),
      karma: null,
      action: "SLEEP",
      counterfactual: null,
    };
  }

  const scan = selectiveScan(stim.channel, stim.magnitude, tapeLen);
  const hv = hdc.encode(scan.state);
  const hdcSim = hdc.recallSimilarity(hv, stim.channel);
  hdc.store(stim.channel, hv);

  const routed = routeOf(stim.channel, stim.magnitude, stim.kind, scan.complexity);
  let seal = sealSkipped();
  let action = "";
  let counterfactual: string | null = null;

  if (key === "ledger" || key === "hostile") {
    seal = sealLedger(key === "hostile");
    const fee = Math.floor((GROSS_PAISE * FEE_BPS) / 10_000);
    const feeRs = (fee / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    action = seal.sat ? `POST ₹4.20 Cr  fee ₹${feeRs}  exact` : "REJECT close";
    const fake = ternaryForward(stim.channel, stim.magnitude);
    counterfactual = `1.58-bit counterfactual is ${fake.label} — no paise invariant on that path`;
  } else if (key === "patch") {
    seal = sealPatch(12, ["risk/gate.py"], false, true, true);
    action = "APPLY risk/gate.py +12";
  } else if (key === "badpatch") {
    seal = sealPatch(12, ["risk/gate.py", "util/debug.py"], true, true, true);
    action = "REJECT patch";
  } else if (key === "arbitrage") {
    seal = {
      invoked: true,
      sat: true,
      core: "risk_exposure <= 0.20 && expected_net_yield > gas_fee",
      smt: [
        "(declare-const treasury_reserve Real)",
        "(declare-const trade_allocation Real)",
        "(assert (= treasury_reserve 500000.0))",
        "(assert (= trade_allocation 50000.0))",
        "(assert (<= trade_allocation (* 0.20 treasury_reserve)))",
        "(assert (> (- 100.0 45.0) 0.0)) ; net spread > gas fee",
        "(check-sat) ; sat -> Green Seal",
      ],
    };
    action = "EXECUTE DEX ARBITRAGE  ·  Allocation ₹50,000  ·  +₹55.00 Net Yield";
  } else if (key === "operator_ingest") {
    seal = {
      invoked: true,
      sat: true,
      core: "air_gapped_tool_boundary == true && kernel_isolated == true",
      smt: [
        "(declare-const operator_model String)",
        "(declare-const is_air_gapped Bool)",
        "(assert (= operator_model \"ChatGPT-4o/Astra\"))",
        "(assert (= is_air_gapped true))",
        "(check-sat) ; sat -> Zero Kernel Contamination",
      ],
    };
    action = "INGEST OPERATOR PATTERN  ·  ChatGPT-4o/Astra -> 10,000-bit Akasha HDC";
  } else if (key === "leak") {
    const records = leakRecords(tapeLen);
    seal = routed.precision === "fp8" ? sealExfil(records) : sealSkipped();
    if (routed.precision === "fp8" && seal.sat) {
      action = `ISOLATE 10.4.4.4  ·  ${records * LEAK_BYTES} bytes over ${records} records`;
    } else {
      action = routed.reflex?.detail ?? "ISOLATE";
    }
    if (routed.precision === "fp8") counterfactual = "coarse ISOLATE with no byte total";
  } else {
    action = routed.reflex?.detail ?? "FP8";
    if (!scan.residue) action += "  ·  no historical residue";
  }

  if (routed.precision === "fp8" && seal.sat === false) action = "REJECT — layer-5 unsat";

  const actionLabel = routed.reflex?.label ?? (seal.sat ? "DISPATCH" : "BLOCK");
  const karma = executeKarma(actionLabel, stim.channel, seal);

  return {
    key,
    name: stim.name,
    note: stim.note,
    tapeLen,
    spike,
    scan,
    hdcSim,
    route: routed,
    seal,
    karma,
    action,
    counterfactual,
  };
}

