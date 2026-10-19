#!/usr/bin/env python3
"""Veda-OS Layer-2 — Tri-Engine Adaptive Core (runnable prototype).

One unified core, three stages, no single-engine dependency:

  Stage 1  Event-driven LIF spiking watchdog.
           Subthreshold input does not touch a membrane. Cost is zero.
  Stage 2  Selective diagonal state-space scan in the Mamba-2 style.
           Memory is O(D). A full attribution pass is O(N·D), never O(N²).
  Stage 3  Dynamic precision router.
           Reflex actions use 1.58-bit ternary weights (adds, almost no muls).
           Critical or diffuse causes switch to an FP8 E4M3 working set.
  Layer 5  Integer proof kernel in the Z3 role. Critical posts are
           accepted only when the finite linear fragment is sat.

This is a control-law prototype: the recurrences are real, the weights are
specified, and nothing here is a trained foundation-model checkpoint.

Run:  python3 veda_os_tri_engine.py
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field

# --- shared constants (mirror src/lib/veda/engine.ts) ----------------------

DEADZONE = 0.08
TAU_US = 220.0
V_THRESHOLD = 1.0
V_RESET = 0.15
D_STATE = 8
TAPE_LEN = 4096
SPOOF_AT = 812
LEAK_START = 2401
LEAK_EVERY = 37
LEAK_BYTES = 240  # exact integer payload per exfil record

# Per-dimension selective gate: delta = softplus(bias + weight * feature).
# Dims 0-1 listen only to the spoof marker (feature 5).
# Dims 5-6 are slow integrators on entropy (feature 4) — repeated leaks add
# without erasing the onset. Other dims stay available for money / code probes.
GATE_BIAS = [-8.0, -8.0, -8.0, -7.0, -7.0, -8.0, -8.0, -7.5]
GATE_FEAT = [5, 5, 1, 2, 3, 4, 4, 0]
GATE_W = [1.50, 1.15, 1.40, 2.20, 2.20, 6.00, 5.40, 1.10]
DECAY_A = [-0.05, -0.08, -0.30, -0.40, -0.40, -0.01, -0.015, -1.60]
WRITE_B = [1.0, 0.65, 0.40, 0.80, 0.80, 1.0, 0.70, 0.50]

# Reflex lattice. Rows: HOLD, HEDGE, QUARANTINE, ISOLATE.
# Cols: mag, price, integrity, syscall, ledger, patch. Values in {-1, 0, +1}.
TERNARY_W = (
    (0, 0, 0, 0, 0, 0),
    (1, 1, -1, -1, -1, -1),
    (1, -1, -1, 1, -1, -1),
    (1, -1, 1, -1, -1, -1),
)
TERNARY_LABELS = ("HOLD", "HEDGE", "QUARANTINE", "ISOLATE")
TERNARY_ALPHA = 1.0

ALLOW_PATCH_FILES = frozenset({"risk/gate.py", "risk/limits.py"})
GROSS_PAISE = 4_200_000_000  # ₹4.20 Cr
FEE_BPS = 8


def softplus(z: float) -> float:
    if z > 20.0:
        return z
    if z < -20.0:
        return math.exp(z)
    return math.log1p(math.exp(z))


def fp8_e4m3(x: float) -> float:
    """Round to an E4M3-like grid: sign, ~3 mantissa bits, max finite 448."""
    if x == 0.0 or not math.isfinite(x):
        return 0.0
    sign = -1.0 if x < 0.0 else 1.0
    ax = abs(x)
    if ax < 2.0**-9:
        return 0.0
    if ax > 448.0:
        ax = 448.0
    exp = math.floor(math.log2(ax))
    exp = max(-6, min(8, exp))
    mant = ax / (2.0**exp)
    frac = round((mant - 1.0) * 8.0)
    if frac == 8:
        frac = 0
        exp += 1
        if exp > 8:
            return sign * 448.0
    return sign * (1.0 + frac / 8.0) * (2.0**exp)


# --- stage 1: event-driven LIF ---------------------------------------------

CHANNELS = ("price", "integrity", "syscall", "ledger", "patch")


@dataclass
class Membrane:
    v: float = 0.0
    last_us: int = 0
    touched: int = 0


@dataclass
class Spike:
    awake: bool
    channel: str
    v_after: float
    v_peak: float
    ops: int
    modelled_us: float


class Watchdog:
    """One membrane per channel. A quiet axon never wakes the membrane."""

    def __init__(self) -> None:
        self.mem = {c: Membrane() for c in CHANNELS}
        self.spikes = 0
        self.sleeps = 0

    def consider(self, t_us: int, channel: str, magnitude: float) -> Spike:
        if abs(magnitude) < DEADZONE:
            self.sleeps += 1
            m = self.mem[channel]
            return Spike(False, channel, m.v, m.v, 0, 0.0)

        m = self.mem[channel]
        dt = max(0, t_us - m.last_us)
        leak = math.exp(-dt / TAU_US) if dt else 1.0
        # Surprise is excitatory. Sign travels with the event, not the membrane.
        m.v = m.v * leak + abs(magnitude)
        m.last_us = t_us
        m.touched += 1
        ops = 3  # exp, mul, add — one synapse, not the whole net
        peak = m.v
        if m.v >= V_THRESHOLD:
            m.v = V_RESET
            self.spikes += 1
            return Spike(True, channel, m.v, peak, ops, 0.85 + 0.05 * ops)
        self.sleeps += 1
        return Spike(False, channel, m.v, peak, ops, 0.40)


# --- stage 2: selective scan ------------------------------------------------

@dataclass
class Token:
    index: int
    tag: str
    text: str
    feat: list[float]  # length 6: mag, channel, money, code, entropy, marker


def token_at(i: int) -> Token:
    if i == SPOOF_AT:
        return Token(
            i,
            "spoof",
            f"L{i:05d}  SPOOF  bid 40× depth  acct shadow-7  spoof-wall",
            [0.05, 0.00, 0.0, 0.0, 0.0, 8.0],
        )
    if i >= LEAK_START and (i - LEAK_START) % LEAK_EVERY == 0:
        n = (i - LEAK_START) // LEAK_EVERY
        return Token(
            i,
            "leak",
            f"L{i:05d}  EXFIL  10.4.4.4  +{LEAK_BYTES}B  seq={n:03d}",
            [0.20, 0.55, 0.0, 0.0, 1.0, 0.0],
        )
    if i % 17 == 0:
        return Token(
            i,
            "book",
            f"L{i:05d}  BOOK   print {(i % 90) + 10:>3}  @ {100 + (i % 7)}",
            [0.0, 0.10, 0.0, 0.0, 0.0, 0.0],
        )
    return Token(i, "beat", f"L{i:05d}  BEAT   core idle", [0.0, 0.0, 0.0, 0.0, 0.0, 0.0])


def query_features(channel: str, magnitude: float) -> list[float]:
    code = {"price": 0.00, "syscall": 0.25, "integrity": 0.55, "ledger": 0.85, "patch": 1.0}[
        channel
    ]
    return [
        math.tanh(magnitude),
        code,
        1.0 if channel == "ledger" else 0.0,
        1.0 if channel == "patch" else 0.0,
        0.0,
        0.0,
    ]


def readout(x: list[float]) -> list[float]:
    """Query-dependent C. A full Mamba-2 uses C_t = W_c x_t; these are that map, written out."""
    c = [0.0] * D_STATE
    if x[3] > 0.5:
        c[4] = 1.0
    elif x[2] > 0.5:
        c[3] = 1.0
    elif x[1] > 0.45:
        c[5] = 0.75
        c[6] = 0.55
    elif x[1] > 0.15:
        c[7] = 1.0
    else:
        c[0] = 1.0
        c[1] = 0.40
    return c


@dataclass
class ScanHit:
    n: int
    flops: int
    attn_flops: int
    origin_index: int
    origin_text: str
    origin_tag: str
    onset_index: int
    onset_text: str
    peak_share: float
    complexity: float
    residue: bool
    state: list[float]
    top: list[tuple[int, float, str]]
    wall_ms: float


def selective_scan(channel: str, magnitude: float, n: int = TAPE_LEN) -> ScanHit:
    """One forward recurrence + one reverse attribution. Both are O(N·D)."""
    t0 = time.perf_counter()
    h = [0.0] * D_STATE
    abars: list[list[float]] = []
    writes: list[list[float]] = []
    flops = 0
    for i in range(n):
        feat = token_at(i).feat
        abar = [0.0] * D_STATE
        write = [0.0] * D_STATE
        for d in range(D_STATE):
            delta = softplus(GATE_BIAS[d] + GATE_W[d] * feat[GATE_FEAT[d]])
            abar[d] = math.exp(DECAY_A[d] * delta)
            write[d] = delta * WRITE_B[d] * feat[GATE_FEAT[d]]
            h[d] = abar[d] * h[d] + write[d]
            flops += 6
        abars.append(abar)
        writes.append(write)

    c = readout(query_features(channel, magnitude))
    g = c[:]
    influences = [0.0] * n
    for i in range(n - 1, -1, -1):
        influences[i] = sum(g[d] * writes[i][d] for d in range(D_STATE))
        g = [g[d] * abars[i][d] for d in range(D_STATE)]
        flops += 2 * D_STATE

    abs_inf = [abs(v) for v in influences]
    total = sum(abs_inf)
    peak_i = max(range(n), key=lambda i: abs_inf[i]) if n else 0
    peak = abs_inf[peak_i] if n else 0.0
    residue = peak > 1e-4
    if not residue or total == 0.0:
        hit_tag, onset_i, share, complexity = "none", -1, 0.0, 0.0
        origin_i = -1
    else:
        origin_i = peak_i
        hit_tag = token_at(peak_i).tag
        share = peak / total
        complexity = 1.0 - share
        onset_i = peak_i
        for i in range(n):
            tok = token_at(i)
            if tok.tag == hit_tag and abs_inf[i] >= 0.15 * peak:
                onset_i = i
                break

    ranked = sorted(range(n), key=lambda i: abs_inf[i], reverse=True)[:3]
    top = [(i, abs_inf[i], token_at(i).tag) for i in ranked if abs_inf[i] > 1e-4]
    wall_ms = (time.perf_counter() - t0) * 1000.0
    return ScanHit(
        n=n,
        flops=flops,
        attn_flops=2 * n * n,
        origin_index=origin_i,
        origin_text="" if origin_i < 0 else token_at(origin_i).text,
        origin_tag=hit_tag if residue else "none",
        onset_index=onset_i,
        onset_text="" if onset_i < 0 else token_at(onset_i).text,
        peak_share=share,
        complexity=complexity,
        residue=residue,
        state=h,
        top=top,
        wall_ms=wall_ms,
    )


# --- stage 3: precision router ----------------------------------------------

def quant_ternary(v: float) -> int:
    if v > 0.25:
        return 1
    if v < -0.25:
        return -1
    return 0


@dataclass
class Reflex:
    label: str
    score: int
    detail: str
    active_row: int
    quantized: tuple[int, ...]
    adds: int


def ternary_forward(channel: str, magnitude: float) -> Reflex:
    flags = {c: 0 for c in CHANNELS}
    flags[channel] = 1
    raw = [
        quant_ternary(abs(magnitude)),
        flags["price"],
        flags["integrity"],
        flags["syscall"],
        flags["ledger"],
        flags["patch"],
    ]
    scores: list[int] = []
    adds = 0
    for row in TERNARY_W:
        acc = 0
        for w, x in zip(row, raw):
            if w != 0 and x != 0:
                acc += w * x  # both in {-1, +1}: a conditional add/sub, no wide multiply
                adds += 1
        scores.append(int(round(TERNARY_ALPHA * acc)))
    row_i = max(range(len(scores)), key=lambda i: (scores[i], -i))
    label = TERNARY_LABELS[row_i]
    if label == "HEDGE":
        units = max(1, min(4, abs(scores[row_i])))
        side = "+" if magnitude < 0 else "−"
        detail = f"HEDGE {side}{units}  (cover against the print)"
    elif label == "HOLD":
        detail = "HOLD  lattice settled at zero"
    else:
        detail = label
    return Reflex(label, scores[row_i], detail, row_i, tuple(raw), adds)


# FP8 risk dot — dense reference vs quantized working set.
RISK_W = (0.85, -0.40, 0.55, 0.25, 1.10, -0.15)


@dataclass
class Fp8Work:
    fp64: float
    fp8: float
    abs_err: float
    rel_err: float
    detail: str


def fp8_risk(channel: str, magnitude: float, complexity: float) -> Fp8Work:
    feat = query_features(channel, magnitude)
    # Pack a 6-vector the risk head actually consumes.
    x = [feat[0], feat[1], feat[2], feat[3], complexity, math.tanh(magnitude / 2)]
    ref = sum(w * v for w, v in zip(RISK_W, x))
    q = sum(fp8_e4m3(w) * fp8_e4m3(v) for w, v in zip(RISK_W, x))
    err = abs(ref - q)
    rel = err / max(1e-9, abs(ref))
    return Fp8Work(ref, q, err, rel, f"risk64 {ref:+.5f}   risk8 {q:+.5f}   |err| {err:.2e}")


@dataclass
class Route:
    precision: str  # "ternary" | "fp8"
    why: str
    reflex: Reflex | None
    fp8: Fp8Work | None


def route(channel: str, magnitude: float, kind: str, complexity: float) -> Route:
    critical = kind == "critical" or complexity >= 0.55
    if critical:
        why = (
            "critical kind — money or code"
            if kind == "critical"
            else f"diffuse cause (complexity {complexity:.2f} ≥ 0.55)"
        )
        return Route("fp8", why, None, fp8_risk(channel, magnitude, complexity))
    reflex = ternary_forward(channel, magnitude)
    return Route(
        "ternary",
        "single-cause reflex — 1.58-bit lattice",
        reflex,
        None,
    )


# --- layer 5: Z3-role proof kernel ------------------------------------------

@dataclass
class Seal:
    invoked: bool
    sat: bool | None
    smt: list[str]
    core: str


def _seal(ok: bool, smt: list[str], core: str) -> Seal:
    smt = smt + [f"(check-sat) ; => {'sat' if ok else 'unsat'}"]
    if not ok:
        smt.append(f"(get-unsat-core) ; => {core}")
    return Seal(True, ok, smt, core if not ok else "all asserted")


def seal_ledger(postings: list[tuple[str, int]], fee_paise: int, fee_expected: int) -> Seal:
    smt = ["(set-logic QF_LIA)", "(assert (= (+ " + " ".join(str(v) for _, v in postings) + ") 0))"]
    total = sum(v for _, v in postings)
    ok = total == 0 and fee_paise == fee_expected
    for name, value in postings:
        if name.startswith("asset:") and value < -GROSS_PAISE:
            ok = False
    core = "conservation" if total != 0 else "fee-schedule"
    if total != 0:
        core = f"conservation off by {total} paise"
    elif fee_paise != fee_expected:
        core = f"fee {fee_paise} != schedule {fee_expected}"
    else:
        core = "conservation + fee schedule"
    smt.append(f"(assert (= fee {fee_expected}))")
    return _seal(ok, smt, core)


def seal_patch(lines: int, files: list[str], adds_eval: bool, keeps_auth: bool, keeps_gate: bool) -> Seal:
    smt = [
        "(assert (<= diff-lines 40))",
        "(assert (subset files allowlist))",
        "(assert (not introduces-eval))",
        "(assert (and keeps-auth keeps-risk-gate))",
    ]
    reasons = []
    if lines > 40:
        reasons.append(f"diff {lines} > 40")
    bad = [f for f in files if f not in ALLOW_PATCH_FILES]
    if bad:
        reasons.append("file " + ",".join(bad))
    if adds_eval:
        reasons.append("introduces eval")
    if not keeps_auth:
        reasons.append("drops auth")
    if not keeps_gate:
        reasons.append("drops risk gate")
    ok = not reasons
    return _seal(ok, smt, " + ".join(reasons) if reasons else "patch invariants")


def seal_exfil(records: int) -> Seal:
    total = records * LEAK_BYTES
    smt = [
        f"(assert (= exfil-bytes (* {records} {LEAK_BYTES})))",
        "(assert (> exfil-bytes 0))",
    ]
    return _seal(True, smt, f"exfil {total} bytes over {records} records")


def seal_skipped() -> Seal:
    return Seal(False, None, ["(push) ; reflex lattice is already discrete — solver not invoked"], "not invoked")


# --- scenarios ---------------------------------------------------------------

@dataclass
class Stimulus:
    name: str
    channel: str
    magnitude: float
    kind: str  # quiet | reflex | critical
    note: str


SCENARIOS: dict[str, Stimulus] = {
    "silence": Stimulus("Silence", "price", 0.0, "quiet", "No axon event."),
    "dust": Stimulus("Price dust", "price", 0.04, "quiet", "Inside the dead zone."),
    "shock": Stimulus("Price shock", "price", -1.65, "reflex", "Print through the spoof wall."),
    "glitch": Stimulus("Syscall glitch", "syscall", 1.25, "reflex", "Single bad return, no history."),
    "leak": Stimulus("Data leak", "integrity", 1.70, "reflex", "Exfil signature on the wire."),
    "ledger": Stimulus("Ledger close", "ledger", 3.10, "critical", "₹4.20 Cr at 8 bps."),
    "hostile": Stimulus("Hostile ledger", "ledger", 3.10, "critical", "Same close, 37 paise missing."),
    "patch": Stimulus("Code patch", "patch", 2.40, "critical", "Allowlisted risk-gate edit."),
    "badpatch": Stimulus("Poison patch", "patch", 2.40, "critical", "Sneaks in eval()."),
}


@dataclass
class Cycle:
    name: str
    spike: Spike
    scan: ScanHit | None
    route: Route | None
    seal: Seal
    action: str
    counterfactual: str | None = None
    extras: dict = field(default_factory=dict)


def ledger_postings(hostile: bool) -> tuple[list[tuple[str, int]], int, int]:
    fee = GROSS_PAISE * FEE_BPS // 10_000
    short = 37 if hostile else 0
    postings = [
        ("asset:cash", -(GROSS_PAISE)),
        ("income:settlement", GROSS_PAISE - fee - short),
        ("income:fee", fee),
    ]
    return postings, fee, fee


def run_cycle(wd: Watchdog, key: str, t_us: int, tape_len: int = TAPE_LEN) -> Cycle:
    stim = SCENARIOS[key]
    spike = wd.consider(t_us, stim.channel, stim.magnitude)
    if not spike.awake:
        return Cycle(stim.name, spike, None, None, seal_skipped(), "SLEEP")

    scan = selective_scan(stim.channel, stim.magnitude, tape_len)
    routed = route(stim.channel, stim.magnitude, stim.kind, scan.complexity)
    contra = None
    extras: dict = {}

    if key in ("ledger", "hostile"):
        postings, fee_got, fee_exp = ledger_postings(key == "hostile")
        seal = seal_ledger(postings, fee_got, fee_exp)
        if seal.sat:
            action = f"POST ₹4.20 Cr  fee ₹{fee_exp / 100:,.2f}  exact"
        else:
            action = "REJECT close"
        # What the coarse lattice would have done, had we trusted it with money.
        fake = ternary_forward(stim.channel, stim.magnitude)
        contra = f"1.58-bit counterfactual is {fake.label} — no paise invariant on that path"
        extras["postings"] = postings
    elif key == "patch":
        seal = seal_patch(12, ["risk/gate.py"], False, True, True)
        action = "APPLY risk/gate.py +12"
    elif key == "badpatch":
        seal = seal_patch(12, ["risk/gate.py", "util/debug.py"], True, True, True)
        action = "REJECT patch"
    elif key == "leak":
        records = sum(
            1 for i in range(tape_len) if i >= LEAK_START and (i - LEAK_START) % LEAK_EVERY == 0
        )
        seal = seal_exfil(records) if routed.precision == "fp8" else seal_skipped()
        if routed.precision == "fp8" and seal.sat:
            action = f"ISOLATE 10.4.4.4  ·  {records * LEAK_BYTES} bytes over {records} records"
        else:
            action = routed.reflex.detail if routed.reflex else "ISOLATE"
        contra = "coarse ISOLATE with no byte total" if routed.precision == "fp8" else None
        extras["records"] = records
    else:
        seal = seal_skipped()
        action = routed.reflex.detail if routed.reflex else "FP8"
        if not scan.residue:
            action = (routed.reflex.detail if routed.reflex else action) + "  ·  no historical residue"

    if routed.precision == "fp8" and seal.sat is False:
        action = "REJECT — layer-5 unsat"

    return Cycle(stim.name, spike, scan, routed, seal, action, contra, extras)


def demo() -> None:
    wd = Watchdog()
    order = ["silence", "dust", "shock", "glitch", "leak", "ledger", "hostile", "patch", "badpatch"]
    t = 1_000_000
    print("VEDA-OS  ·  TRI-ENGINE ADAPTIVE CORE  ·  prototype")
    print(f"tape {TAPE_LEN} lines   state D={D_STATE}   deadzone {DEADZONE}")
    print("-" * 78)
    for key in order:
        cycle = run_cycle(wd, key, t)
        t += 250_000
        sp = cycle.spike
        print(f"\n[{cycle.name}]")
        if not sp.awake:
            why = "dead zone, membrane not touched" if sp.ops == 0 else "subthreshold, axon stays down"
            print(f"  SNN sleep   ops={sp.ops}   v={sp.v_peak:.2f}   modelled {sp.modelled_us:.2f} µs   {why}")
            continue
        sc = cycle.scan
        assert sc is not None and cycle.route is not None
        print(
            f"  SNN spike   ch={sp.channel}  ops={sp.ops}  modelled {sp.modelled_us:.2f} µs"
        )
        print(
            f"  MAMBA-2     N={sc.n}  flops={sc.flops:,}  vs attention {sc.attn_flops:,}  "
            f"({sc.attn_flops / max(1, sc.flops):.0f}×)  wall {sc.wall_ms:.2f} ms"
        )
        if sc.residue:
            print(f"  origin L{sc.origin_index} [{sc.origin_tag}]  share {sc.peak_share:.2f}")
            print(f"           {sc.origin_text}")
            print(f"  onset  L{sc.onset_index}  {sc.onset_text}")
        else:
            print("  origin      none — live spike has no residue in state")
        print(f"  ROUTER      {cycle.route.precision}  ({cycle.route.why})")
        if cycle.route.fp8:
            print(f"              {cycle.route.fp8.detail}")
        print(f"  ACTION      {cycle.action}")
        if cycle.counterfactual:
            print(f"  COUNTER     {cycle.counterfactual}")
        status = "skipped" if not cycle.seal.invoked else ("sat" if cycle.seal.sat else "unsat")
        print(f"  LAYER-5     {status}")
        if cycle.seal.invoked and not cycle.seal.sat:
            print(f"              core: {cycle.seal.core}")

    # A longer stream, to show the linear scan still finishes.
    long_n = 100_000
    t0 = time.perf_counter()
    long = selective_scan("price", -1.65, long_n)
    elapsed = (time.perf_counter() - t0) * 1000
    print("\n" + "-" * 78)
    print(
        f"long scan N={long_n:,}  flops={long.flops:,}  "
        f"attention would be {long.attn_flops:,.0f}  "
        f"ratio {long.attn_flops / long.flops:.0f}×  elapsed {elapsed:.1f} ms  "
        f"origin L{long.origin_index} {long.origin_tag}"
    )

    # Self-check. These are the architectural claims, pinned.
    wd2 = Watchdog()
    assert run_cycle(wd2, "silence", 0).spike.ops == 0
    assert run_cycle(wd2, "dust", 10).spike.awake is False
    shock = run_cycle(wd2, "shock", 20)
    assert shock.spike.awake and shock.scan and shock.scan.origin_tag == "spoof"
    assert shock.scan.onset_index == SPOOF_AT
    assert shock.route and shock.route.precision == "ternary"
    assert shock.route.reflex and shock.route.reflex.label == "HEDGE"
    leak = run_cycle(wd2, "leak", 30)
    assert leak.scan and leak.scan.origin_tag == "leak"
    assert leak.scan.onset_index == LEAK_START
    assert leak.route and leak.route.precision == "fp8"
    assert leak.seal.sat is True
    clean = run_cycle(wd2, "ledger", 40)
    assert clean.seal.sat is True and clean.route and clean.route.precision == "fp8"
    dirty = run_cycle(wd2, "hostile", 50)
    assert dirty.seal.sat is False
    good = run_cycle(wd2, "patch", 60)
    assert good.seal.sat is True
    bad = run_cycle(wd2, "badpatch", 70)
    assert bad.seal.sat is False
    glitch = run_cycle(wd2, "glitch", 80)
    assert glitch.scan and glitch.scan.residue is False
    assert glitch.route and glitch.route.reflex and glitch.route.reflex.label == "QUARANTINE"
    print("self-check  ok")


if __name__ == "__main__":
    demo()
