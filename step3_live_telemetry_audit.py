#!/usr/bin/env python3
"""
STEP 3 AUDIT: REAL LIVE OS TELEMETRY INGESTION & SCAN
Replaces synthetic token_at(i) tape with real live Windows OS telemetry:
- Live Process List & CPU Metrics
- Live Active TCP/UDP Network Sockets
- Feed real telemetry vectors into SNN Watchdog, Mamba-2 SSM, and Akasha HDC
"""

import os
import sys
import psutil
import time
from typing import List, Dict, Any

sys.path.append(os.path.join(os.path.dirname(__file__), "public", "prototype"))
from veda_os_core import VedaOSCore, TelemetryEvent

# ANSI Colors
GREEN = "\033[92m"
RED = "\033[91m"
AMBER = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"

def capture_live_telemetry() -> List[Dict[str, Any]]:
    """Capture real-world OS telemetry from the host machine."""
    events = []
    
    # 1. Capture top CPU processes
    for proc in sorted(psutil.process_iter(['pid', 'name', 'cpu_percent', 'memory_percent']), 
                       key=lambda p: p.info.get('cpu_percent') or 0, reverse=True)[:10]:
        events.append({
            "type": "process",
            "name": proc.info['name'] or "unknown",
            "pid": proc.info['pid'],
            "cpu": proc.info['cpu_percent'] or 0.0,
            "mem": proc.info['memory_percent'] or 0.0,
            "metric": (proc.info['cpu_percent'] or 0.0) / 100.0
        })

    # 2. Capture real active network connections
    try:
        conns = psutil.net_connections(kind='inet')
        for c in conns[:10]:
            r_ip = c.raddr.ip if c.raddr else "0.0.0.0"
            r_port = c.raddr.port if c.raddr else 0
            events.append({
                "type": "network",
                "name": f"socket:{r_ip}:{r_port}",
                "status": c.status,
                "metric": 0.55 if c.status == 'ESTABLISHED' else 0.10
            })
    except Exception as e:
        events.append({"type": "network", "name": "socket:permission_filtered", "metric": 0.0})

    return events

def run_step3_live_telemetry_audit():
    print("=" * 80)
    print("  VEDA-OS STEP 3: REAL LIVE SYSTEM TELEMETRY AUDIT")
    print("=" * 80)

    print("[*] Sampling host machine telemetry (Processes, Memory, Network)...")
    live_events = capture_live_telemetry()
    print(f"[*] Successfully captured {len(live_events)} live OS telemetry frames from Windows host.")

    veda = VedaOSCore()
    t_us = int(time.time() * 1e6)

    print("\n[+] Processing real host frames through Veda-OS 6-layer Neuro-Symbolic Core:")
    spikes_count = 0
    sleeps_count = 0

    for i, ev in enumerate(live_events):
        channel = "integrity" if ev["type"] == "network" else "syscall"
        signal_val = ev["metric"]
        label = f"{ev['type'].upper()}: {ev['name']}"

        res = veda.cycle(channel, signal_val, label, t_us)
        t_us += 50_000

        if not res["awake"]:
            sleeps_count += 1
            print(f"  • Frame {i+1:02d} [{channel:9}] {label:35} -> {DIM}SNN ASLEEP (0 ops / quiescent){RESET}")
        else:
            spikes_count += 1
            sc = res["scan"]
            rt = res["route"]
            dp = res["dispatch"]
            print(f"  • Frame {i+1:02d} [{channel:9}] {label:35} -> {AMBER}SPIKE DETECTED{RESET} | Route: {rt.precision.upper()} | Karma: {dp.action}")

    print("\n" + "=" * 80)
    print(f"[*] Live Telemetry Audit Summary:")
    print(f"    • Total Real Frames Ingested : {len(live_events)}")
    print(f"    • Quiescent Frames (Asleep)  : {GREEN}{sleeps_count} frames{RESET} (Zero compute wasted)")
    print(f"    • Evaluated Frames (Spikes)  : {AMBER}{spikes_count} frames{RESET} (Evaluated via Mamba-2 & HDC)")
    print("=" * 80)

if __name__ == "__main__":
    run_step3_live_telemetry_audit()
