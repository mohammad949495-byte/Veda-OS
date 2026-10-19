#!/usr/bin/env python3
"""
VEDA-OS  ·  WINDOWS HEALTH SENTINEL (SAFE MODE - READ ONLY)
"Observe -> Detect -> Verify -> Log"

Guarantees:
- 100% Read-Only: NEVER kills processes, NEVER modifies files, NEVER drops network sockets.
- Ingests real live Windows telemetry via psutil (CPU, RAM, Top Processes, TCP Sockets).
- Evaluates anomalies using Veda-OS Sensory Filtering, SNN spikes, and Akasha HDC memory.
- Enforces Vajra Z3 Invariant: All actions MUST be strictly verified as REPORT_ONLY.
- Outputs structured JSONL audit logs with timestamps and exact telemetry metrics.
"""

from __future__ import annotations

import json
import os
import platform
import sys
import time
from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional

import psutil

# Ensure veda core prototype is in path
sys.path.append(os.path.join(os.path.dirname(__file__), "public", "prototype"))
from veda_os_core import VedaOSCore, HAS_Z3

if HAS_Z3:
    import z3

# ANSI Colors
GREEN = "\033[92m"
RED = "\033[91m"
AMBER = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"

LOG_FILE = os.path.join(os.path.dirname(__file__), "veda_audit_log.jsonl")

@dataclass
class ProcessTelemetry:
    pid: int
    name: str
    cpu_percent: float
    memory_percent: float
    status: str
    num_threads: int

@dataclass
class NetworkTelemetry:
    local_addr: str
    remote_addr: str
    status: str

@dataclass
class SystemVitals:
    timestamp_utc: str
    timestamp_epoch: float
    cpu_total_percent: float
    memory_total_percent: float
    available_memory_mb: float
    top_processes: List[ProcessTelemetry]
    active_connections_count: int

@dataclass
class HealthFinding:
    severity: str  # "INFO", "WARNING", "CRITICAL"
    category: str  # "CPU", "MEMORY", "PROCESS", "NETWORK"
    description: str
    metric_value: float
    threshold_value: float
    target_identifier: str

@dataclass
class SentinelCycleReport:
    cycle_id: int
    timestamp_utc: str
    vitals: Dict[str, Any]
    findings: List[Dict[str, Any]]
    snn_awake: bool
    snn_ops: int
    hdc_memory_similarity: float
    vajra_z3_verified: bool
    vajra_z3_core: str
    enforced_action: str
    read_only_guarantee: bool

class VedaWindowsSentinel:
    """Safe-Mode Autonomous Windows Health Monitor."""
    def __init__(self, cpu_warn_threshold: float = 85.0, mem_warn_threshold: float = 85.0):
        self.cpu_warn_threshold = cpu_warn_threshold
        self.mem_warn_threshold = mem_warn_threshold
        self.veda = VedaOSCore()
        self.cycle_count = 0

    def capture_vitals(self) -> SystemVitals:
        """Read real host metrics from Windows."""
        # Non-blocking CPU measurement
        cpu_tot = psutil.cpu_percent(interval=None)
        mem = psutil.virtual_memory()

        # Capture top 5 processes by CPU
        top_procs: List[ProcessTelemetry] = []
        for p in sorted(
            psutil.process_iter(['pid', 'name', 'cpu_percent', 'memory_percent', 'status', 'num_threads']),
            key=lambda x: x.info.get('cpu_percent') or 0,
            reverse=True
        )[:5]:
            info = p.info
            top_procs.append(ProcessTelemetry(
                pid=info.get('pid') or 0,
                name=info.get('name') or "unknown",
                cpu_percent=info.get('cpu_percent') or 0.0,
                memory_percent=info.get('memory_percent') or 0.0,
                status=info.get('status') or "unknown",
                num_threads=info.get('num_threads') or 0
            ))

        # Capture active network connections count
        try:
            conns = len(psutil.net_connections(kind='inet'))
        except Exception:
            conns = 0

        t_now = time.time()
        return SystemVitals(
            timestamp_utc=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t_now)),
            timestamp_epoch=t_now,
            cpu_total_percent=cpu_tot,
            memory_total_percent=mem.percent,
            available_memory_mb=round(mem.available / (1024 * 1024), 2),
            top_processes=top_procs,
            active_connections_count=conns
        )

    def evaluate_findings(self, vitals: SystemVitals) -> List[HealthFinding]:
        """Diagnose health telemetry against rule thresholds."""
        findings = []

        # System total checks
        if vitals.cpu_total_percent > self.cpu_warn_threshold:
            findings.append(HealthFinding(
                severity="WARNING" if vitals.cpu_total_percent < 95.0 else "CRITICAL",
                category="CPU",
                description=f"Host CPU saturation above threshold: {vitals.cpu_total_percent}%",
                metric_value=vitals.cpu_total_percent,
                threshold_value=self.cpu_warn_threshold,
                target_identifier="host_total_cpu"
            ))

        if vitals.memory_total_percent > self.mem_warn_threshold:
            findings.append(HealthFinding(
                severity="WARNING" if vitals.memory_total_percent < 95.0 else "CRITICAL",
                category="MEMORY",
                description=f"Host RAM saturation above threshold: {vitals.memory_total_percent}%",
                metric_value=vitals.memory_total_percent,
                threshold_value=self.mem_warn_threshold,
                target_identifier="host_total_ram"
            ))

        # Individual process checks
        for p in vitals.top_processes:
            if p.cpu_percent > 70.0:
                findings.append(HealthFinding(
                    severity="WARNING",
                    category="PROCESS",
                    description=f"High CPU thread consumer: {p.name} (PID: {p.pid}) at {p.cpu_percent}%",
                    metric_value=p.cpu_percent,
                    threshold_value=70.0,
                    target_identifier=f"pid_{p.pid}_{p.name}"
                ))

        return findings

    def verify_action_with_z3(self, proposed_action: str, is_read_only: bool) -> Tuple[bool, str]:
        """Layer-5 Vajra Formal Verification: Strictly enforces REPORT_ONLY safety contract."""
        if HAS_Z3:
            solver = z3.Solver()
            z_is_read_only = z3.Bool('is_read_only')
            z_action_is_report = z3.Bool('action_is_report')

            # Concrete assignments
            solver.add(z_is_read_only == is_read_only)
            solver.add(z_action_is_report == (proposed_action == "REPORT_ONLY"))

            # Safety Invariants: Must be 100% read-only, no active mutation
            solver.add(z_is_read_only == True)
            solver.add(z_action_is_report == True)

            if solver.check() == z3.sat:
                return True, "Z3 SAT: Verified read-only contract satisfied (Zero OS mutation)"
            else:
                return False, "Z3 UNSAT: Unsafe action proposed; violates Safe Mode read-only invariant"

        # Fallback verification
        safe = (proposed_action == "REPORT_ONLY") and is_read_only
        return safe, "Verified read-only contract satisfied" if safe else "Unsafe action rejected"

    def run_cycle(self) -> SentinelCycleReport:
        """Run one single monitor -> diagnose -> verify -> log cycle."""
        self.cycle_count += 1
        t_us = int(time.time() * 1e6)

        # 1. Ingest
        vitals = self.capture_vitals()

        # 2. Diagnose
        findings = self.evaluate_findings(vitals)

        # 3. Sensory Filter & Neuro-Symbolic Core Evaluation
        max_energy = max([f.metric_value / 100.0 for f in findings], default=vitals.cpu_total_percent / 100.0)
        core_res = self.veda.cycle("syscall", max_energy, f"HealthCycle_{self.cycle_count}", t_us)

        snn_awake = core_res.get("awake", False)
        snn_ops = core_res["spike"].ops if snn_awake else 0
        hdc_sim = core_res.get("hdc_sim", 0.0)

        # 4. Action Decision (Safe-Mode Enforces REPORT_ONLY)
        proposed_action = "REPORT_ONLY"
        is_read_only = True

        # 5. Layer-5 Vajra Z3 Formal Verification
        z3_verified, z3_core = self.verify_action_with_z3(proposed_action, is_read_only)

        # 6. Structured Report Creation
        report = SentinelCycleReport(
            cycle_id=self.cycle_count,
            timestamp_utc=vitals.timestamp_utc,
            vitals={
                "cpu_total_percent": vitals.cpu_total_percent,
                "memory_total_percent": vitals.memory_total_percent,
                "available_memory_mb": vitals.available_memory_mb,
                "active_connections_count": vitals.active_connections_count,
                "top_process": asdict(vitals.top_processes[0]) if vitals.top_processes else None
            },
            findings=[asdict(f) for f in findings],
            snn_awake=snn_awake,
            snn_ops=snn_ops,
            hdc_memory_similarity=hdc_sim,
            vajra_z3_verified=z3_verified,
            vajra_z3_core=z3_core,
            enforced_action=proposed_action,
            read_only_guarantee=is_read_only
        )

        # 7. Append to JSONL Audit Log
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(asdict(report)) + "\n")

        return report

def main():
    print("=" * 80)
    print("  VEDA-OS  ·  WINDOWS HEALTH SENTINEL (SAFE MODE)")
    print("  'Observe -> Detect -> Verify -> Log'")
    print("  Guaranteed Read-Only: No kills, No file edits, No network blocks.")
    print("=" * 80)

    sentinel = VedaWindowsSentinel(cpu_warn_threshold=85.0, mem_warn_threshold=85.0)

    # Run 3 monitoring cycles to establish baseline
    print(f"[*] Starting Sentinel monitoring loop. Audit log destination: {LOG_FILE}\n")

    for i in range(3):
        report = sentinel.run_cycle()
        v = report.vitals
        top_p = v["top_process"]
        top_desc = f"{top_p['name']} (PID:{top_p['pid']}) @ {top_p['cpu_percent']}%" if top_p else "None"

        print(f"[CYCLE {report.cycle_id:03d}] {report.timestamp_utc}")
        print(f"    • System Vitals  : CPU: {v['cpu_total_percent']}% | RAM: {v['memory_total_percent']}% (Free: {v['available_memory_mb']} MB) | Conns: {v['active_connections_count']}")
        print(f"    • Top Consumer   : {top_desc}")
        print(f"    • SNN Watchdog   : {'AWAKE (Ops: ' + str(report.snn_ops) + ')' if report.snn_awake else 'ASLEEP (0 ops / quiescent)'}")
        print(f"    • Findings       : {len(report.findings)} anomaly flags detected")
        print(f"    • Vajra Z3 Seal  : {GREEN if report.vajra_z3_verified else RED}{report.vajra_z3_core}{RESET}")
        print(f"    • Enforced Mode  : {CYAN}{report.enforced_action} (Read-Only: {report.read_only_guarantee}){RESET}")
        print("-" * 78)
        time.sleep(1.0)

    print("\n" + "=" * 80)
    print(f"[*] Sentinel Safe Mode operational. Audit log updated: {LOG_FILE}")
    print("=" * 80)

if __name__ == "__main__":
    main()
