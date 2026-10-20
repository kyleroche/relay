#!/usr/bin/env python3
"""relay's Griptape Nodes shim: run one workflow file headless and turn its end-node outputs into files.

Started by the nodes lane adapter (packages/core/src/lanes/nodes.ts) under the engine's own interpreter (the uv tool
venv behind `griptape-nodes`, or `uv tool run --from griptape-nodes python`), never under relay's Node process:

    run_workflow.py --workflow <path.py> --inputs <inputs.json> --out <dir> [--outputs "End Flow,Stills"]

`inputs.json` is `{ "<start node>": { "<parameter>": value } }`, the engine's flow input. Everything the engine logs
goes to stderr; stdout carries exactly one JSON document, the last line:

    { "ok": bool, "outputs": [ { "node", "parameter", "path", "mime", "bytes", "seconds"?, "provider_job_id"? } ],
      "nodes_run": [ { "node", "type", "library" } ], "engine_version": str, "seconds": float, "error"?: str,
      "workflow_name"?: str }

An end node's parameter value becomes a file when it is an artifact: a URL artifact (Image/Video/AudioUrlArtifact)
is downloaded, a blob artifact (Image/AudioArtifact, BlobArtifact) is written, a list is walked, a text or JSON
artifact is written as .txt/.json only for end nodes the caller listed in --outputs (otherwise text is status, not
an output). Control and status parameters of the end node are skipped. The engine itself is the only dependency.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import importlib.metadata
import json
import logging
import mimetypes
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

SKIPPED_PARAMETERS = {"exec_in", "exec_out", "failed", "execution_environment", "job_group", "was_successful", "result_details"}
TEXT_ARTIFACTS = {"TextArtifact", "JsonArtifact", "InfoArtifact", "BooleanArtifact", "GenericArtifact"}
DOWNLOAD_TIMEOUT_S = 600
MAX_NAME = 80


def safe_name(s: str) -> str:
    """A filename stem: [A-Za-z0-9._-], never empty, never a dotfile, bounded."""
    out = re.sub(r"[^A-Za-z0-9._-]+", "_", s).strip("._") or "output"
    return out[:MAX_NAME]


def ext_for(mime: str | None, fallback: str = "") -> str:
    if not mime:
        return fallback
    base = mime.split(";")[0].strip().lower()
    known = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mp4": ".m4a", "audio/ogg": ".ogg", "application/json": ".json", "text/plain": ".txt"}
    if base in known:
        return known[base]
    return mimetypes.guess_extension(base) or fallback


def mime_for_path(path: str) -> str | None:
    return mimetypes.guess_type(path)[0]


def unique_path(out_dir: Path, stem: str, ext: str) -> Path:
    p = out_dir / f"{stem}{ext}"
    n = 2
    while p.exists():
        p = out_dir / f"{stem}-{n}{ext}"
        n += 1
    return p


def artifact_type_name(v: Any) -> str | None:
    """The griptape artifact class name of v, or None when v is not an artifact (duck-typed: no griptape import needed)."""
    for cls in type(v).__mro__:
        if cls.__name__ == "BaseArtifact":
            return type(v).__name__
    return None


def download(url: str, dest_stem: Path) -> tuple[Path, str | None, int]:
    """Stream a URL to <dest_stem><ext>; the extension comes from the response type, then the URL path."""
    req = urllib.request.Request(url, headers={"user-agent": "relay-nodes-shim"})
    with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT_S) as resp:  # noqa: S310 (the URL came from the engine's output, not an issue)
        ctype = resp.headers.get("content-type") if hasattr(resp, "headers") else None
        if ctype:
            ctype = ctype.split(";")[0].strip()
        url_ext = os.path.splitext(urllib.parse.urlparse(url).path)[1].lower()
        ext = url_ext if url_ext and len(url_ext) <= 5 else ext_for(ctype, ".bin")
        if (ctype in (None, "", "application/octet-stream", "binary/octet-stream")) and url_ext:
            ctype = mime_for_path(url) or ctype
        path = unique_path(dest_stem.parent, dest_stem.name, ext)
        size = 0
        with open(path, "wb") as f:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                size += len(chunk)
    return path, ctype or mime_for_path(str(path)), size


def materialize_value(node: str, param: str, value: Any, out_dir: Path, *, text_ok: bool, index: int | None = None) -> list[dict[str, Any]]:
    """Files for one parameter value (several for a list). Pure except for the writes under out_dir."""
    stem_name = f"{safe_name(node)}-{safe_name(param)}" + (f"-{index + 1}" if index is not None else "")
    stem = out_dir / stem_name
    kind = artifact_type_name(value)
    if kind is None and isinstance(value, dict) and isinstance(value.get("type"), str) and value["type"].endswith("Artifact") and "value" in value:
        # a serialized artifact, as the engine hands them across process boundaries
        kind = value["type"]
        value = _Serialized(value)
    if kind is None:
        if isinstance(value, (list, tuple)):
            out: list[dict[str, Any]] = []
            for i, item in enumerate(value):
                out.extend(materialize_value(node, param, item, out_dir, text_ok=text_ok, index=i))
            return out
        if text_ok and isinstance(value, str) and value.strip():
            path = unique_path(out_dir, stem_name, ".txt")
            path.write_text(value, encoding="utf-8")
            return [{"node": node, "parameter": param, "path": str(path), "mime": "text/plain", "bytes": path.stat().st_size}]
        if text_ok and isinstance(value, (dict, int, float, bool)) and value is not None:
            path = unique_path(out_dir, stem_name, ".json")
            path.write_text(json.dumps(value, indent=2, default=str), encoding="utf-8")
            return [{"node": node, "parameter": param, "path": str(path), "mime": "application/json", "bytes": path.stat().st_size}]
        return []
    if kind == "ListArtifact":
        out = []
        for i, item in enumerate(getattr(value, "value", []) or []):
            out.extend(materialize_value(node, param, item, out_dir, text_ok=text_ok, index=i))
        return out
    if kind in ("ImageUrlArtifact", "VideoUrlArtifact", "AudioUrlArtifact", "UrlArtifact"):
        url = str(getattr(value, "value", ""))
        if not url:
            return []
        path, mime, size = download(url, stem)
        if not mime:
            mime = {"ImageUrlArtifact": "image/png", "VideoUrlArtifact": "video/mp4", "AudioUrlArtifact": "audio/mpeg"}.get(kind, "application/octet-stream")
        return [{"node": node, "parameter": param, "path": str(path), "mime": mime, "bytes": size, "source_url": url}]
    if kind in TEXT_ARTIFACTS:
        if not text_ok:
            return []
        text = value.to_text() if hasattr(value, "to_text") else str(getattr(value, "value", value))
        ext = ".json" if kind == "JsonArtifact" else ".txt"
        path = unique_path(out_dir, stem_name, ext)
        path.write_text(text, encoding="utf-8")
        return [{"node": node, "parameter": param, "path": str(path), "mime": "application/json" if ext == ".json" else "text/plain", "bytes": path.stat().st_size}]
    if kind == "ErrorArtifact":
        return []
    # ImageArtifact, AudioArtifact, BlobArtifact and other binary artifacts: bytes plus a mime from the artifact
    data = value.to_bytes() if hasattr(value, "to_bytes") else getattr(value, "value", b"")
    if isinstance(data, str):
        data = data.encode("utf-8")
    if not data:
        return []
    mime = getattr(value, "mime_type", None) or "application/octet-stream"
    fmt = getattr(value, "format", None)
    ext = f".{fmt}" if isinstance(fmt, str) and fmt else ext_for(mime, ".bin")
    path = unique_path(out_dir, stem_name, ext)
    path.write_bytes(data)
    return [{"node": node, "parameter": param, "path": str(path), "mime": mime, "bytes": len(data)}]


class _Serialized:
    """A dict-shaped artifact ({type, value, format?, mime_type?}) given attribute access for materialize_value."""

    def __init__(self, d: dict[str, Any]) -> None:
        self.value = d.get("value")
        if "format" in d:
            self.format = d["format"]
        if "mime_type" in d:
            self.mime_type = d["mime_type"]
        if isinstance(self.value, str) and d.get("type") not in ("ImageUrlArtifact", "VideoUrlArtifact", "AudioUrlArtifact", "UrlArtifact", "TextArtifact", "JsonArtifact"):
            try:
                import base64

                self.value = base64.b64decode(self.value)
            except Exception:  # noqa: BLE001
                pass

    def to_bytes(self) -> bytes:
        return self.value if isinstance(self.value, bytes) else str(self.value).encode("utf-8")

    def to_text(self) -> str:
        return self.value if isinstance(self.value, str) else json.dumps(self.value)


def materialize(output: dict[str, dict[str, Any]], out_dir: Path, wanted: list[str] | None) -> list[dict[str, Any]]:
    """Every end node's parameters into files under out_dir. `wanted` restricts the nodes and allows their text outputs."""
    out_dir.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    for node, params in (output or {}).items():
        if wanted and node not in wanted:
            continue
        if not isinstance(params, dict):
            continue
        job_id = params.get("generation_id") or params.get("job_id")
        for param, value in params.items():
            if param in SKIPPED_PARAMETERS or value is None:
                continue
            files = materialize_value(node, param, value, out_dir, text_ok=bool(wanted and node in wanted))
            if isinstance(job_id, str) and job_id:
                for f in files:
                    f["provider_job_id"] = job_id
            results.extend(files)
    return results


def engine_version() -> str:
    try:
        return importlib.metadata.version("griptape-nodes")
    except Exception:  # noqa: BLE001
        return "unknown"


def referenced_libraries(workflow: Path) -> list[str]:
    """Library names from the workflow's `# /// script` header (`node_libraries_referenced = [["Name", "ver"], ...]`)."""
    names: list[str] = []
    with contextlib.suppress(Exception):
        head = workflow.read_text(encoding="utf-8", errors="replace")[:20000]
        m = re.search(r"^#\s*node_libraries_referenced\s*=\s*(\[.*?\])\s*$", head, re.M)
        if m:
            for entry in json.loads(m.group(1)):
                if isinstance(entry, list) and entry and isinstance(entry[0], str):
                    names.append(entry[0])
                elif isinstance(entry, str):
                    names.append(entry)
    return names


def library_candidates() -> list[Path]:
    """Library JSON files to register when the engine's own config did not: RELAY_NODES_LIBRARIES (path-separated),
    the user config's `libraries_to_register` read raw (the engine drops the whole file when one field fails its
    schema), then every library synced under the engine's data directory."""
    out: list[Path] = []
    for p in os.environ.get("RELAY_NODES_LIBRARIES", "").split(os.pathsep):
        if p.strip():
            out.append(Path(p.strip()))
    with contextlib.suppress(Exception):
        from griptape_nodes.retained_mode.managers.config_manager import USER_CONFIG_PATH

        cfg = json.loads(Path(USER_CONFIG_PATH).read_text(encoding="utf-8"))
        for p in cfg.get("app_events", {}).get("on_app_initialization_complete", {}).get("libraries_to_register", []) or []:
            if isinstance(p, str) and p.strip():
                out.append(Path(p))
    with contextlib.suppress(Exception):
        from xdg_base_dirs import xdg_data_home

        out.extend(sorted((xdg_data_home() / "griptape_nodes" / "libraries").glob("*/griptape_nodes_library.json")))
    seen: set[Path] = set()
    uniq: list[Path] = []
    for p in out:
        rp = p.expanduser()
        if rp.is_file() and rp not in seen:
            seen.add(rp)
            uniq.append(rp)
    return uniq


def library_name_of(path: Path) -> str | None:
    with contextlib.suppress(Exception):
        name = json.loads(path.read_text(encoding="utf-8")).get("name")
        return name if isinstance(name, str) else None
    return None


async def ensure_libraries(workflow: Path) -> list[str]:
    """Register the libraries the workflow references when the engine's config did not load them. Returns the registered names."""
    from griptape_nodes.retained_mode.events.library_events import ListRegisteredLibrariesRequest, ListRegisteredLibrariesResultSuccess, RegisterLibraryFromFileRequest, RegisterLibraryFromFileResultSuccess
    from griptape_nodes.retained_mode.griptape_nodes import GriptapeNodes

    def registered() -> list[str]:
        r = GriptapeNodes.handle_request(ListRegisteredLibrariesRequest())
        return list(r.libraries) if isinstance(r, ListRegisteredLibrariesResultSuccess) else []

    have = registered()
    wanted = [n for n in referenced_libraries(workflow) if n not in have]
    if not wanted:
        return have
    logging.getLogger("relay").warning("the engine loaded %s; registering the workflow's libraries itself: %s", have or "no libraries", ", ".join(wanted))
    for path in library_candidates():
        name = library_name_of(path)
        if name not in wanted:
            continue
        r = await GriptapeNodes.ahandle_request(RegisterLibraryFromFileRequest(file_path=str(path), load_as_default_library=False))
        if isinstance(r, RegisterLibraryFromFileResultSuccess):
            wanted.remove(name)
            logging.getLogger("relay").info("registered %s from %s", r.library_name, path)
        if not wanted:
            break
    if wanted:
        raise RuntimeError(f"the workflow needs libraries the engine does not have: {', '.join(wanted)} (install them in Griptape Nodes, or point RELAY_NODES_LIBRARIES at their griptape_nodes_library.json files)")
    return registered()


async def run_engine(workflow: Path, inputs: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], str | None, list[str]]:
    """Load and run the workflow under the engine; returns (output, nodes, workflow_name, libraries)."""
    from griptape_nodes.bootstrap.workflow_executors.local_workflow_executor import LocalWorkflowExecutor
    from griptape_nodes.retained_mode.griptape_nodes import GriptapeNodes

    nodes: list[dict[str, Any]] = []
    workflow_name: str | None = None
    async with LocalWorkflowExecutor() as executor:
        libraries = await ensure_libraries(workflow)
        await executor.arun(flow_input=inputs, workflow_path=str(workflow))
        output = executor.output or {}
        with contextlib.suppress(Exception):
            flow = GriptapeNodes.ContextManager().get_current_flow()
            for name, node in flow.nodes.items():
                meta = getattr(node, "metadata", None) or {}
                nodes.append({"node": name, "type": type(node).__name__, "library": meta.get("library") if isinstance(meta, dict) else None})
        with contextlib.suppress(Exception):
            workflow_name = GriptapeNodes.ContextManager().get_current_workflow_name()
    return output, nodes, workflow_name, libraries


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a Griptape Nodes workflow headless and write its outputs as files.")
    parser.add_argument("--workflow", required=True, help="the workflow .py file")
    parser.add_argument("--inputs", required=True, help="JSON file: { node: { parameter: value } }")
    parser.add_argument("--out", required=True, help="directory for the output files")
    parser.add_argument("--outputs", default="", help="comma-separated end-node names to keep (default: every end node; text outputs only for listed nodes)")
    args = parser.parse_args(argv)

    t0 = time.monotonic()
    result: dict[str, Any] = {"ok": False, "outputs": [], "nodes_run": [], "engine_version": engine_version(), "seconds": 0.0}
    real_stdout = sys.stdout
    # the engine prints as it pleases; stdout must end with one JSON document and nothing else
    sys.stdout = sys.stderr
    logging.basicConfig(level=os.environ.get("RELAY_NODES_LOG_LEVEL", "INFO"), stream=sys.stderr, format="%(levelname)s %(name)s: %(message)s")
    try:
        workflow = Path(args.workflow).resolve()
        if not workflow.is_file():
            raise FileNotFoundError(f"workflow file not found: {workflow}")
        with open(args.inputs, encoding="utf-8") as f:
            inputs = json.load(f)
        if not isinstance(inputs, dict):
            raise ValueError("inputs must be a JSON object: { node: { parameter: value } }")
        wanted = [s.strip() for s in args.outputs.split(",") if s.strip()] or None
        out_dir = Path(args.out).resolve()
        out_dir.mkdir(parents=True, exist_ok=True)
        output, nodes, workflow_name, libraries = asyncio.run(run_engine(workflow, inputs))
        result["nodes_run"] = nodes
        result["libraries"] = libraries
        if workflow_name:
            result["workflow_name"] = workflow_name
        if wanted:
            missing = [n for n in wanted if n not in output]
            if missing:
                result["warning"] = f"end node(s) not in the workflow's output: {', '.join(missing)}"
        result["outputs"] = materialize(output, out_dir, wanted)
        result["ok"] = True
    except BaseException as e:  # noqa: BLE001 (every failure must still produce the JSON document)
        result["error"] = f"{type(e).__name__}: {e}"[:2000]
        if isinstance(e, KeyboardInterrupt):
            result["error"] = "interrupted"
    finally:
        result["seconds"] = round(time.monotonic() - t0, 3)
        sys.stdout = real_stdout
        print(json.dumps(result, default=str), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
