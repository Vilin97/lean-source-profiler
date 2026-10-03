"""Sequential paired end-to-end benchmark, including capture decoding and publication.

Usage: python3 scripts/benchmark-capture.py PLAN.json OUTPUT.json [repeats=4]
Plan is an array of {project, file, setup?} absolute paths. Imports must already be built.
Each mode gets one discarded warmup. Order rotates between repeats. Driver compilation
and environment discovery are reported separately, never silently included/excluded.
On Linux the outer clock is CLOCK_MONOTONIC_RAW; frontend clocks are Lean monotonic.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import time


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def main():
    plan = json.loads(Path(sys.argv[1]).read_text())
    destination = Path(sys.argv[2])
    repeats = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    clock = lambda: time.clock_gettime_ns(time.CLOCK_MONOTONIC_RAW)
    root = Path(__file__).resolve().parent.parent
    implementation = {name: digest(root / name) for name in [
        'lean/SourceProfiler.lean', 'lean/Clock.c', 'out/capture.js', 'out/query.js',
        'scripts/benchmark-worker.cjs', 'scripts/benchmark-capture.py']}
    report = {"platform": platform.platform(), "cpu": platform.processor(),
              "outerClock": "CLOCK_MONOTONIC_RAW", "repeats": repeats,
              "warmupsPerMode": 1, "implementationSha256": implementation,
              "preparation": [], "files": [], "startedAt": time.time()}
    worker = subprocess.Popen(["node", str(Path(__file__).with_name("benchmark-worker.cjs"))],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    with tempfile.TemporaryDirectory(prefix="lean-capture-benchmark-") as scratch:
        def invoke(request):
            raw_start, mono_start = clock(), time.monotonic_ns()
            worker.stdin.write(json.dumps(request) + "\n")
            worker.stdin.flush()
            result = json.loads(worker.stdout.readline())
            raw_end, mono_end = clock(), time.monotonic_ns()
            if not result.pop("ok"):
                raise RuntimeError(result["error"])
            return {**result, "wallMs": (raw_end - raw_start) / 1e6,
                    "monotonicMs": (mono_end - mono_start) / 1e6}

        for project in dict.fromkeys(item["project"] for item in plan):
            report["preparation"].append({"project": project, **invoke({"project": project, "mode": "prepare"})})
        for index, item in enumerate(plan):
            prepared = next(p for p in report["preparation"] if p["project"] == item["project"])
            item = {**item, "driverSha256": prepared["driverSha256"], "clockSha256": prepared["clockSha256"]}
            source_hash = digest(item["file"])
            setup_hash = digest(item["setup"]) if item.get("setup") else None
            record = {**item, "sourceSha256": source_hash, "setupSha256": setup_hash, "runs": []}
            for repeat in range(-1, repeats):
                modes = ["native", "baseline", "compact"]
                offset = (repeat + index) % len(modes)
                modes = modes[offset:] + modes[:offset]
                for mode in modes:
                    result = invoke({**item, "mode": mode, "output": str(Path(scratch) / "capture.json")})
                    record["runs"].append({"repeat": repeat, "warmup": repeat == -1, "mode": mode, **result})
                print(f"[{index+1}/{len(plan)}] {Path(item['file']).name} repeat {repeat}", flush=True)
            assert digest(item["file"]) == source_hash
            if setup_hash:
                assert digest(item["setup"]) == setup_hash
            report["files"].append(record)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(json.dumps(report, indent=2) + "\n")
        worker.stdin.close()
        assert worker.wait(timeout=10) == 0
    report["completedAt"] = time.time()
    assert all(digest(root / name) == value for name, value in implementation.items())
    destination.write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
