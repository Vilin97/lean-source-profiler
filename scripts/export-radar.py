"""Export a verified Radar Mathlib benchmark to the shared flame explorer."""

import argparse
import gzip
import hashlib
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


def read_json(path: Path):
    return json.loads(path.read_text())


def write_compressed(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
    path.write_bytes(gzip.compress(raw, mtime=0))
    return hashlib.sha256(path.read_bytes()).hexdigest()


def module_measurements(measurements):
    """Read the two exact Mathlib module metrics without dependency values."""
    modules = defaultdict(dict)
    for entry in measurements["comparison"]["measurements"]:
        metric = entry["metric"]
        if not metric.startswith("build/module/") or entry.get("second") is None:
            continue
        module, submetric = metric.removeprefix("build/module/").split("//")
        if module != "Mathlib" and not module.startswith("Mathlib."):
            continue
        if submetric not in {"instructions", "lines"}:
            continue
        value = entry["second"]
        if value < 0 or not float(value).is_integer():
            raise ValueError("Expected a nonnegative integer measurement")
        if submetric in modules[module]:
            raise ValueError("Duplicate measurement")
        modules[module][submetric] = int(value)
    return modules


def source_files(modules, source_tree, sha):
    """Match every measured module to the complete source inventory."""
    tracked = {
        item["path"]: item["sha"] for item in source_tree["tree"]
        if item["type"] == "blob" and item["path"].endswith(".lean")
        and (item["path"].startswith("Mathlib/") or item["path"] == "Mathlib.lean")
    }
    files = {}
    for module, values in sorted(modules.items()):
        source = module.replace(".", "/") + ".lean"
        if set(values) != {"instructions", "lines"} or source not in tracked:
            raise ValueError("Incomplete or unknown module: " + module)
        files[source] = {
            "id": str(len(files)), "module": module, **values,
            "sourceBlob": tracked[source],
            "sourceUrl": f"https://github.com/leanprover-community/mathlib4/blob/{sha}/{source}",
        }
    if set(files) != set(tracked):
        raise ValueError("Missing source files: " + str(sorted(set(tracked) - set(files))))
    return files


def write_snapshot(output, overview, measurements):
    """Write the validated dataset and its coverage and asset hashes."""
    overview_sha = write_compressed(output / "data/overview.json.gz", overview)
    raw_sha = write_compressed(output / "data/radar-measurements.json.gz", measurements)
    coverage = {
        "result": "PASS", "commit": overview["commit"], "trackedFiles": len(overview["files"]),
        "measuredFiles": len(overview["files"]), "missing": [], "unknown": [],
        "metrics": ["instructions", "lines"], "totals": overview["totals"],
        "rootModuleIncluded": True, "dependenciesIncluded": False,
        "declarationMeasurements": False, "sourceLineMeasurements": False,
    }
    output.mkdir(parents=True, exist_ok=True)
    (output / "coverage.json").write_text(json.dumps(coverage, indent=2) + "\n")
    manifest = {
        **coverage, "kind": "radar-benchmark", "run": overview["run"],
        "leanVersion": overview["leanVersion"], "benchmarkTime": overview["capturedAt"],
        "radarUrl": overview["radarUrl"],
        "measurementApi": f"https://radar.lean-lang.org/api/compare/mathlib4/{overview['commit']}/{overview['commit']}/",
        "assets": {"data/overview.json.gz": overview_sha, "data/radar-measurements.json.gz": raw_sha},
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(coverage))


def export(inputs: Path, output: Path):
    """Validate the benchmark and export it without estimating missing data."""
    commit = read_json(inputs / "latest-commit.json")
    measurements = read_json(inputs / "measurements.json")
    source_tree = read_json(inputs / "source-tree.json")
    sha = commit["commit"]["chash"]
    if source_tree["truncated"] or source_tree["sha"] != sha:
        raise ValueError("Source inventory must be complete and match the benchmark")
    if measurements["chashSecond"] != sha:
        raise ValueError("Measurements do not match the source commit")
    run = next(r for r in commit["runs"] if r["name"] == "main")
    if not run.get("finished") or run["finished"]["exitCode"] != 0:
        raise ValueError("Benchmark must have completed successfully")
    files = source_files(module_measurements(measurements), source_tree, sha)
    overview = {
        "kind": "radar-benchmark", "name": "Mathlib", "commit": sha,
        "title": commit["commit"]["title"], "files": files,
        "leanVersion": (inputs / "lean-toolchain").read_text().strip(),
        "radarUrl": f"https://radar.lean-lang.org/repos/mathlib4/commits/{sha}",
        "run": run,
        "totals": {key: sum(f[key] for f in files.values()) for key in ("instructions", "lines")},
        "capturedAt": datetime.fromtimestamp(run["finished"]["endTime"], timezone.utc).isoformat(),
    }
    write_snapshot(output, overview, measurements)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", type=Path)
    parser.add_argument("output", type=Path)
    arguments = parser.parse_args()
    export(arguments.inputs, arguments.output)
