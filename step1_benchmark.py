#!/usr/bin/env python3
"""
STEP 1 BENCHMARK: STATISTICAL RIGOR & MEMORY PROFILER
Measures:
- Sample size: 10,000 runs for Idle vs 500 runs for Active SSM
- Metrics: Min, Median (p50), p95, p99, Max latency
- Memory: tracemalloc peak memory allocation
- CPU Process Time: time.process_time_ns()
"""

import os
import sys
import time
import tracemalloc
import statistics

sys.path.append(os.path.join(os.path.dirname(__file__), "public", "prototype"))
from veda_os_core import VedaOSCore

def benchmark_step1():
    print("=" * 80)
    print("  VEDA-OS STEP 1: RIGOROUS STATISTICAL & MEMORY BENCHMARK")
    print("=" * 80)

    # ---------------------------------------------------------
    # 1. Warm-up
    # ---------------------------------------------------------
    veda = VedaOSCore()
    for _ in range(500):
        veda.cycle("price", 0.01, "Warmup", 1000)

    # ---------------------------------------------------------
    # 2. Benchmarking Idle Path (Deadzone: Silence & Dust)
    # ---------------------------------------------------------
    idle_runs = 10_000
    idle_latencies = []
    
    tracemalloc.start()
    t_cpu_idle_start = time.process_time_ns()
    
    for i in range(idle_runs):
        t0 = time.perf_counter_ns()
        veda.cycle("price", 0.02, "Idle Signal", i * 100)
        t1 = time.perf_counter_ns()
        idle_latencies.append((t1 - t0) / 1000.0) # Convert to microseconds (µs)
        
    t_cpu_idle_end = time.process_time_ns()
    idle_peak_mem_bytes = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()

    # ---------------------------------------------------------
    # 3. Benchmarking Active Path (Price Shock -> SNN -> Mamba-2 SSM)
    # ---------------------------------------------------------
    active_runs = 500
    active_latencies = []
    
    tracemalloc.start()
    t_cpu_active_start = time.process_time_ns()
    
    for i in range(active_runs):
        t0 = time.perf_counter_ns()
        veda.cycle("price", -1.65, "Active Shock", i * 100)
        t1 = time.perf_counter_ns()
        active_latencies.append((t1 - t0) / 1000.0) # µs
        
    t_cpu_active_end = time.process_time_ns()
    active_peak_mem_bytes = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()

    # ---------------------------------------------------------
    # 4. Statistical Computations
    # ---------------------------------------------------------
    idle_latencies.sort()
    active_latencies.sort()

    def get_percentiles(data):
        return {
            "min": data[0],
            "p50": statistics.median(data),
            "p95": data[int(len(data) * 0.95)],
            "p99": data[int(len(data) * 0.99)],
            "max": data[-1],
            "mean": statistics.mean(data)
        }

    idle_stats = get_percentiles(idle_latencies)
    active_stats = get_percentiles(active_latencies)

    print("\n[+] 1. IDLE PATH (<0.08 Deadzone - SNN Sleeps) - 10,000 Iterations:")
    print(f"    • Mean Latency   : {idle_stats['mean']:.3f} µs")
    print(f"    • Median (p50)   : {idle_stats['p50']:.3f} µs")
    print(f"    • p95 Latency    : {idle_stats['p95']:.3f} µs")
    print(f"    • p99 Latency    : {idle_stats['p99']:.3f} µs")
    print(f"    • Peak Mem Usage : {idle_peak_mem_bytes / 1024:.2f} KB")
    print(f"    • CPU User Time  : {(t_cpu_idle_end - t_cpu_idle_start) / 1e6:.2f} ms total")

    print("\n[+] 2. ACTIVE PATH (Spike -> 4,096 SSM Tape Scan) - 500 Iterations:")
    print(f"    • Mean Latency   : {active_stats['mean'] / 1000:.3f} ms")
    print(f"    • Median (p50)   : {active_stats['p50'] / 1000:.3f} ms")
    print(f"    • p95 Latency    : {active_stats['p95'] / 1000:.3f} ms")
    print(f"    • p99 Latency    : {active_stats['p99'] / 1000:.3f} ms")
    print(f"    • Peak Mem Usage : {active_peak_mem_bytes / 1024:.2f} KB")
    print(f"    • CPU User Time  : {(t_cpu_active_end - t_cpu_active_start) / 1e6:.2f} ms total")

    speedup_median = (active_stats['p50'] / max(1e-6, idle_stats['p50']))
    print("\n[+] 3. COMPARATIVE VERDICT:")
    print(f"    • Median Latency Ratio : {speedup_median:.1f}x Faster during Idle")
    print(f"    • Memory Overhead Diff : {abs(active_peak_mem_bytes - idle_peak_mem_bytes) / 1024:.2f} KB delta")
    print("=" * 80)

if __name__ == "__main__":
    benchmark_step1()
