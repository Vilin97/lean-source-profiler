"""Publish audited whole-pool summaries without exposing local machine paths."""

import argparse
import gzip
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path


FILE_FIELDS = {
    "id", "name", "kind", "path", "value", "sourceValue", "captureWallMs",
    "eventCount", "thresholdMs", "leanVersion", "profilingOptions", "exporter",
    "exporterDriverSha256",
    "captureMode", "sourceClock", "configurationMode", "moduleOptions",
}
SESSION_FIELDS = {
    "schemaVersion", "kind", "startedAt", "completedAt", "status", "wallMs",
    "plannedFileCount", "leanVersions", "configurationMode", "excluded",
}


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(content):
    return hashlib.sha256(content).hexdigest()


def source_nodes(nodes, source_path):
    """Virtualize source locations while retaining every timing and source span."""
    result = []
    for original in nodes:
        node = dict(original)
        if "range" in node:
            node["range"] = {**node["range"], "file": source_path}
        if "children" in node:
            node["children"] = source_nodes(node["children"], source_path)
        result.append(node)
    return result


def write_compressed(path, value):
    content = json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                         allow_nan=False).encode("utf-8")
    compressed = gzip.compress(content, compresslevel=6, mtime=0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(compressed)
    assert gzip.decompress(compressed) == content
    return {"sha256": digest(compressed), "bytes": len(compressed)}


def export_file(base, destination, entry, expected_source):
    source = read_json(base / "full" / "summaries" / f"{entry['id']}.json")
    assert source["path"] == entry["path"]
    source_hash = digest(source["source"].encode("utf-8"))
    assert source_hash == expected_source["sha256"], entry["path"]
    published = {key: value for key, value in source.items() if key in FILE_FIELDS}
    published["source"] = source["source"]
    published["children"] = source_nodes(source["children"], entry["path"])
    asset = f"data/files/{entry['id']}.json.gz"
    metadata = write_compressed(destination / asset, published)
    return {"id": entry["id"], "path": entry["path"], "sourceSha256": source_hash,
            "asset": asset, **metadata}


def export_dataset(base, destination):
    inventory = read_json(base / "inventory.json")
    overview = read_json(base / "full" / "overview.json")
    coverage = read_json(base / "final-coverage.json")
    session = overview["session"]
    expected = {file["path"]: file for project in inventory["projects"]
                for file in project["files"]}
    entries = session["files"]
    assert session["status"] == "complete" and coverage["result"] == "PASS"
    assert len(entries) == len(expected) == inventory["files"]
    assert all(entry["status"] == "ok" for entry in entries)
    assert {entry["path"] for entry in entries} == set(expected)
    manifests = []
    for entry in entries:
        manifests.append(export_file(base, destination, entry, expected[entry["path"]]))
        if len(manifests) % 500 == 0:
            print(json.dumps({"exported": len(manifests), "total": len(entries)}), flush=True)
    public_session = {key: value for key, value in session.items() if key in SESSION_FIELDS}
    public_session["files"] = [{"id": entry["id"], "path": entry["path"], "status": "ok"}
                               for entry in entries]
    public_overview = {**overview, "session": public_session,
                       "files": {path: {key: value for key, value in file.items()
                                        if key in FILE_FIELDS}
                                 for path, file in overview["files"].items()}}
    overview_asset = write_compressed(destination / "data/overview.json.gz", public_overview)
    return inventory, session, coverage, manifests, overview_asset


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recording", type=Path)
    parser.add_argument("destination", type=Path)
    arguments = parser.parse_args()
    base, destination = arguments.recording.resolve(), arguments.destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    inventory, session, coverage, files, overview = export_dataset(base, destination)
    manifest = {
        "schemaVersion": 1, "kind": "leanpool-public-source-profile",
        "builtAt": datetime.now(timezone.utc).isoformat(),
        "commit": inventory["commit"], "profilerCommit": inventory["profilerCommit"],
        "fileCount": len(files), "projectGroups": len(inventory["projects"]),
        "startedAt": session["startedAt"], "completedAt": session["completedAt"],
        "elapsedMs": session["wallMs"], "overview": overview, "files": files,
        "includes": ["projects", "folders", "files", "declarations", "source-lines"],
        "rawOperationTracesIncluded": False,
    }
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (destination / "coverage.json").write_text(json.dumps(coverage, indent=2) + "\n")
    badge = {"schemaVersion": 1, "label": "source profile",
             "message": session["completedAt"][:10], "color": "166a94"}
    (destination / "badge.json").write_text(json.dumps(badge, indent=2) + "\n")
    repository = Path(inventory["repository"])
    for source, target in [("LICENSE", "LEANPOOL-LICENSE"), ("NOTICE", "LEANPOOL-NOTICE")]:
        shutil.copyfile(repository / source, destination / target)
    registry = repository / "LeanPool/projects.yml"
    if registry.exists():
        shutil.copyfile(registry, destination / "projects.yml")
    else:
        shutil.copytree(repository / "LeanPool/projects", destination / "projects",
                        dirs_exist_ok=True)
    print(json.dumps({"result": "PASS", "files": len(files),
                      "compressedBytes": sum(file["bytes"] for file in files) + overview["bytes"],
                      "sourceHashesVerified": len(files)}), flush=True)


if __name__ == "__main__":
    main()
