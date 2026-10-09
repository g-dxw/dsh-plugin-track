"""Track's persistence adapter. Creative work stays in OpenMontage directors.

No tools, providers or generation are called here. Native schemas/checkpoints
are used with a project-local OS lock and a recoverable atomic write journal.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from uuid import uuid4

STAGES = ("idea", "script", "scene_plan")
ARTIFACTS = {"idea": "brief", "script": "script", "scene_plan": "scene_plan", "assets": "asset_manifest"}
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$")
# The host Session SDK has no environment option. Agent invocations therefore
# bootstrap from this explicit per-project config instead of pretending the
# host inherited PYTHONPATH. Only the bridge's four allowlisted keys apply.
_workspace_environment = Path.cwd() / "track-openmontage-environment.json"
if not os.environ.get("OPENMONTAGE_PROJECTS_DIR") and _workspace_environment.is_file():
    _config = json.loads(_workspace_environment.read_text(encoding="utf-8"))
    for _key in ("PYTHONPATH", "OPENMONTAGE_PROJECTS_DIR", "PYTHONDONTWRITEBYTECODE", "TRACK_OPENMONTAGE_THUMB_CACHE"):
        if isinstance(_config.get(_key), str):
            os.environ[_key] = _config[_key]
    if _config.get("PYTHONPATH"):
        sys.path.insert(0, _config["PYTHONPATH"])
sys.dont_write_bytecode = True
if os.name == "nt":
    # Python's native checkpoint writer also receives the extended-length root.
    # Do this before importing OpenMontage's canonical lib.paths singleton.
    for _key in ("OPENMONTAGE_PROJECTS_DIR", "TRACK_OPENMONTAGE_THUMB_CACHE"):
        _value = os.environ.get(_key)
        if _value and not _value.startswith("\\\\?\\"):
            _absolute = os.path.abspath(_value)
            os.environ[_key] = ("\\\\?\\UNC\\" + _absolute[2:]) if _absolute.startswith("\\\\") else ("\\\\?\\" + _absolute)
ROOT = Path(os.environ.get("OPENMONTAGE_PROJECTS_DIR", "")).resolve()


def display_path(path):
    value = str(path)
    if value.startswith("\\\\?\\UNC\\"):
        return "\\\\" + value[8:]
    return value[4:] if value.startswith("\\\\?\\") else value


class BridgeError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def now():
    return datetime.now(timezone.utc).isoformat()


def identifier(value):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise BridgeError("项目或镜头编号无效")
    return value


def read_json(path, default=None):
    if not path.exists():
        return default
    maximum = 128 * 1024 * 1024 if path.name == ".track-openmontage-transaction.json" else 32 * 1024 * 1024
    if path.is_symlink() or not path.is_file() or path.stat().st_size > maximum:
        raise BridgeError("工程文件不可读取")
    if os.environ.get("OPENMONTAGE_PROJECTS_DIR") and not path.resolve().is_relative_to(ROOT):
        raise BridgeError("工程文件路径超出项目根")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise BridgeError(f"工程 JSON 损坏: {path.name}") from exc


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    # Windows installs often live below long DSH_HOME paths. A sibling temp
    # must not repeat the already-long canonical/history filename.
    tmp = path.with_name(f".t-{uuid4().hex[:16]}.tmp")
    try:
        with tmp.open("x", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        for attempt in range(8):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if attempt == 7:
                    raise
                time.sleep(0.03 * (attempt + 1))
    finally:
        tmp.unlink(missing_ok=True)


def project_path(project_id):
    p = ROOT / identifier(project_id)
    if p.is_symlink() or p.resolve().parent != ROOT or not p.is_dir():
        raise BridgeError("项目不存在", 404)
    return p


def binding(p, track_id):
    value = read_json(p / "track-binding.json")
    if not isinstance(value, dict) or value.get("trackId") != identifier(track_id) or value.get("projectId") != p.name:
        raise BridgeError("项目与当前轨迹不匹配", 404)
    return value


def shot_directory(p, item):
    path = p / "shots" / identifier(item["shot_id"])
    if path.is_symlink() or not path.resolve().is_relative_to(p.resolve()):
        raise BridgeError("镜头目录路径无效")
    path.mkdir(parents=True, exist_ok=True)
    saved = read_json(path / "shot-binding.json")
    if saved is not None and saved != item:
        raise BridgeError("已有镜头目录绑定不同分镜", 409)
    if saved is None:
        atomic_json(path / "shot-binding.json", item)
    return path


@contextmanager
def locked(p):
    """OS releases locks on process death; no stale PID lock can delete data."""
    path = p / ".track-openmontage.lock"
    if path.is_symlink():
        raise BridgeError("工程锁文件无效")
    with path.open("a+b") as handle:
        handle.seek(0, 2)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        deadline = time.monotonic() + 15
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise BridgeError("项目正在由另一个操作写入，请稍后重试", 409)
                time.sleep(0.05)
        try:
            recover(p)
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def recover(p):
    journal = p / ".track-openmontage-transaction.json"
    value = read_json(journal)
    if value is None:
        return
    if not isinstance(value, dict) or not isinstance(value.get("writes"), dict):
        raise BridgeError("项目恢复记录损坏；请保留原文件")
    for relative, content in value["writes"].items():
        target = p / relative
        if Path(relative).is_absolute() or target.resolve().is_relative_to(p.resolve()) is False or target.is_symlink():
            raise BridgeError("项目恢复路径无效")
        atomic_json(target, content)
    journal.unlink()


def transaction(p, writes):
    """Publish all planned JSON writes; interruption rolls forward under lock."""
    for relative in writes:
        path = p / relative
        if not path.resolve().is_relative_to(p.resolve()) or path.is_symlink():
            raise BridgeError("项目写入路径无效")
    atomic_json(p / ".track-openmontage-transaction.json", {"version": 1, "writes": writes})
    recover(p)


def digest(stage, artifact):
    creative = copy.deepcopy(artifact)
    # Routing is editorial plumbing, not a new human-approved creative choice.
    if stage == "scene_plan" and isinstance(creative.get("metadata"), dict):
        creative["metadata"].pop("track_shots", None)
        if not creative["metadata"]:
            creative.pop("metadata")
    encoded = json.dumps(creative, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def native():
    from lib import checkpoint
    from schemas.artifacts import validate_artifact
    return checkpoint, validate_artifact


def artifact(p, stage):
    name = ARTIFACTS[stage]
    value = read_json(p / "artifacts" / f"{name}.json")
    cp = read_json(p / f"checkpoint_{stage}.json")
    if value is None and isinstance(cp, dict):
        value = (cp.get("artifacts") or {}).get(name)
    if value is not None:
        if not isinstance(value, dict):
            raise BridgeError(f"{name}必须为原生 JSON 对象")
        _, validate = native()
        validate(name, value)
    if cp is not None:
        checkpoint, _ = native()
        checkpoint.validate_checkpoint(cp)
        if cp.get("project_id") != p.name or cp.get("pipeline_type") != "hybrid" or cp.get("stage") != stage:
            raise BridgeError("checkpoint 所属项目或流程无效")
    return value, cp


def ledger(p):
    value = read_json(p / "track-approvals.json", {"version": 1, "stages": {}})
    if not isinstance(value, dict) or value.get("version") != 1 or not isinstance(value.get("stages"), dict):
        raise BridgeError("审批记录损坏；请保留原文件")
    return value


def status(p):
    saved = ledger(p)
    rows = []
    chain = {}
    for stage in STAGES:
        try:
            art, cp = artifact(p, stage)
            current = digest(stage, art) if art is not None else None
            receipt = saved["stages"].get(stage, {})
            cp_art = ((cp or {}).get("artifacts") or {}).get(ARTIFACTS[stage])
            cp_same = isinstance(cp_art, dict) and current == digest(stage, cp_art)
            approved = bool(current and cp_same and receipt.get("approvedDigest") == current
                            and receipt.get("upstream") == chain and all(row["approved"] for row in rows)
                            and cp.get("status") == "completed" and cp.get("human_approved") is True)
            row = {"stage": stage, "status": (cp or {}).get("status", "pending"), "digest": current, "approved": approved}
            if current and not approved and row["status"] == "completed":
                row["status"] = "awaiting_human"
                row["error"] = "内容或上游版本已变化，需要在 Agent 对话中重新确认"
            rows.append(row)
            chain[stage] = current
        except Exception as exc:
            rows.append({"stage": stage, "status": "failed", "digest": None, "approved": False, "error": str(exc)})
            chain[stage] = None
    return rows


def snapshot(p, relative, writes):
    path = p / relative
    if path.exists():
        value = read_json(path)
        writes[f"history/t_{path.stem}_{uuid4().hex[:16]}.json"] = value


def native_checkpoint(p, stage, art, approved=False, status_value=None, metadata=None):
    checkpoint, _ = native()
    previous = read_json(p / f"checkpoint_{stage}.json", {})
    stage_artifacts = copy.deepcopy(previous.get("artifacts") or {})
    stage_artifacts[ARTIFACTS[stage]] = art
    stage_metadata = copy.deepcopy(previous.get("metadata") or {})
    stage_metadata.update(metadata or {})
    # Native library validates actual pipeline prerequisites; its output is
    # staged so checkpoint and canonical artifact share the same transaction.
    with tempfile.TemporaryDirectory(prefix=".s-", dir=ROOT) as temporary:
        base = Path(temporary)
        staged = base / p.name
        staged.mkdir()
        shutil.copyfile(p / "project.json", staged / "project.json")
        for path in p.glob("checkpoint_*.json"):
            shutil.copyfile(path, staged / path.name)
        generated = checkpoint.write_checkpoint(
            base, p.name, stage, status_value or ("completed" if approved else "awaiting_human"),
            stage_artifacts, pipeline_type="hybrid", checkpoint_policy="manual_all",
            human_approval_required=True, human_approved=approved, metadata=stage_metadata,
            review=previous.get("review"), cost_snapshot=previous.get("cost_snapshot"),
        )
        return read_json(generated)


def invalidate(p, stage, saved, writes):
    stages = ["idea", "script", "scene_plan", "assets", "edit", "compose", "publish"]
    for downstream in stages[stages.index(stage) + 1:]:
        saved["stages"].pop(downstream, None)
        cp = read_json(p / f"checkpoint_{downstream}.json")
        if cp is not None:
            snapshot(p, f"checkpoint_{downstream}.json", writes)
            cp = copy.deepcopy(cp)
            cp.update(status="in_progress", human_approved=False, timestamp=now())
            cp.setdefault("metadata", {})["track_invalidated_by"] = stage
            writes[f"checkpoint_{downstream}.json"] = cp


def require_predecessors(p, stage):
    rows = status(p)
    before = STAGES[:STAGES.index(stage)]
    if any(not row["approved"] for row in rows if row["stage"] in before):
        raise BridgeError("上游内容尚未按当前版本确认，不能推进下一阶段", 409)
    return rows


def commit(p, request):
    stage = request.get("stage")
    if stage not in STAGES:
        raise BridgeError("首期仅支持需求大纲、脚本及分镜阶段")
    rows = require_predecessors(p, stage)
    current = next(row for row in rows if row["stage"] == stage)
    if request.get("expectedDigest") != current["digest"]:
        raise BridgeError("成果已被其他操作更新，请重新读取", 409)
    art = request.get("artifact")
    if not isinstance(art, dict):
        raise BridgeError("阶段成果必须为原生 JSON 对象")
    _, validate = native()
    validate(ARTIFACTS[stage], art)
    new_digest = digest(stage, art)
    saved = ledger(p)
    writes = {}
    snapshot(p, f"artifacts/{ARTIFACTS[stage]}.json", writes)
    snapshot(p, f"checkpoint_{stage}.json", writes)
    cp = native_checkpoint(p, stage, art)
    saved["stages"][stage] = {"digest": new_digest, "approvedDigest": None, "upstream": {row["stage"]: row["digest"] for row in rows if row["stage"] in STAGES[:STAGES.index(stage)]}}
    invalidate(p, stage, saved, writes)
    writes.update({f"artifacts/{ARTIFACTS[stage]}.json": art, f"checkpoint_{stage}.json": cp, "track-approvals.json": saved})
    transaction(p, writes)
    return {"stage": stage, "digest": new_digest, "status": "awaiting_human"}


def approve(p, request):
    stage = request.get("stage")
    if stage not in STAGES:
        raise BridgeError("审批阶段无效")
    rows = require_predecessors(p, stage)
    current = next(row for row in rows if row["stage"] == stage)
    if not current["digest"] or request.get("expectedDigest") != current["digest"]:
        raise BridgeError("审批对应成果已变化，请先展示并确认当前版本", 409)
    evidence = request.get("humanApprovalEvidence")
    if not isinstance(evidence, str) or not evidence.strip() or len(evidence) > 4000:
        raise BridgeError("必须记录用户在当前 Agent 对话中的明确确认原文")
    art, _ = artifact(p, stage)
    cp = native_checkpoint(p, stage, art, approved=True, metadata={"track_approval_digest": current["digest"]})
    saved = ledger(p)
    saved["stages"][stage] = {"digest": current["digest"], "approvedDigest": current["digest"], "approvedAt": now(), "humanApprovalEvidence": evidence,
                              "upstream": {row["stage"]: row["digest"] for row in rows if row["stage"] in STAGES[:STAGES.index(stage)]}}
    writes = {f"checkpoint_{stage}.json": cp, "track-approvals.json": saved}
    snapshot(p, f"checkpoint_{stage}.json", writes)
    transaction(p, writes)
    return {"stage": stage, "digest": current["digest"], "status": "completed"}


def produce(p, expected):
    rows = status(p)
    if not all(row["approved"] for row in rows):
        raise BridgeError("需求大纲、脚本和分镜须按当前版本在 Agent 对话中确认", 409)
    if expected != rows[-1]["digest"]:
        raise BridgeError("分镜版本已变化，录制与素材保留，请重新确认后操作", 409)
    art, _ = artifact(p, "scene_plan")
    return art, rows


def mappings(art):
    values = art.get("metadata", {}).get("track_shots", [])
    if not isinstance(values, list):
        raise BridgeError("分镜镜头映射必须为列表")
    seen = set()
    shot_ids = set()
    for value in values:
        if not isinstance(value, dict) or value.get("editor") not in ("map", "sandbox"):
            raise BridgeError("分镜镜头映射格式无效")
        shot_id = identifier(value.get("shot_id"))
        if shot_id in shot_ids:
            raise BridgeError("分镜镜头编号重复")
        shot_ids.add(shot_id)
        if value.get("scene_id") in seen or value.get("scene_id") not in {scene["id"] for scene in art["scenes"]}:
            raise BridgeError("分镜镜头映射重复或引用不存在")
        seen.add(value["scene_id"])
    return values


def bind_shot(p, request):
    art, _ = produce(p, request.get("expectedScenePlanDigest"))
    scene_id = request.get("sceneId")
    scene = next((scene for scene in art["scenes"] if scene["id"] == scene_id), None)
    editor = request.get("editor")
    if scene is None or editor not in ("map", "sandbox"):
        raise BridgeError("分镜或编辑器类型无效")
    if scene.get("type") != "screen_recording" or not any(asset.get("source") == "record" for asset in scene.get("required_assets", [])):
        raise BridgeError("请先在 Agent 对话中将此分镜确认成 screen_recording，并明确 record 素材需求", 409)
    values = mappings(art)
    prior = next((value for value in values if value["scene_id"] == scene_id), None)
    if prior:
        if prior["editor"] != editor or prior.get("track_id") != request["trackId"]:
            raise BridgeError("此分镜已关联另一种编辑器；原镜头保留，请使用已有编辑器", 409)
        shot_directory(p, prior)
        return prior
    item = {"shot_id": f"shot-{uuid4().hex}", "scene_id": scene_id, "editor": editor, "track_id": request["trackId"]}
    art.setdefault("metadata", {})["track_shots"] = values + [item]
    _, validate = native()
    validate("scene_plan", art)
    cp = native_checkpoint(p, "scene_plan", art, approved=True, metadata={"track_approval_digest": digest("scene_plan", art)})
    shot_directory(p, item)
    writes = {"artifacts/scene_plan.json": art, "checkpoint_scene_plan.json": cp}
    snapshot(p, "artifacts/scene_plan.json", writes)
    snapshot(p, "checkpoint_scene_plan.json", writes)
    transaction(p, writes)
    return item


def take(p, request):
    # A completed attempt is idempotent even if a subsequent edit changed the
    # project; it refers to immutable bytes and can never bind to a new shot.
    take_id = identifier(request.get("takeId"))
    receipts = read_json(p / "track-takes.json", {"version": 1, "takes": []})
    prior = next((item for item in receipts["takes"] if item["takeId"] == take_id), None)
    if prior:
        if any(prior.get(key) != request.get(key) for key in ("shotId", "scenePlanDigest", "projectRevision", "editor", "sha256")):
            raise BridgeError("同一次回填编号对应不同工程或视频，已保留原素材", 409)
        return prior
    art, _ = produce(p, request.get("scenePlanDigest"))
    shot = next((item for item in mappings(art) if item["shot_id"] == request.get("shotId")), None)
    if not shot or shot["editor"] != request.get("editor") or shot.get("track_id") != request["trackId"]:
        raise BridgeError("视频与当前分镜映射不匹配", 409)
    if read_json(p / "shots" / identifier(shot["shot_id"]) / "shot-binding.json") != shot:
        raise BridgeError("分镜技术映射与原镜头绑定已变化，原视频保留，禁止错绑素材", 409)
    engine_file = "geomotion-project.json" if shot["editor"] == "map" else "shot-editor-project.json"
    engine = read_json(p / "shots" / shot["shot_id"] / engine_file)
    if not engine or engine.get("revision") != request.get("projectRevision"):
        raise BridgeError("镜头工程已变化，视频已保留，请重新读取工程后重试", 409)
    relative = request.get("path")
    media = p / str(relative)
    if not isinstance(relative, str) or media.is_symlink() or not media.resolve().is_relative_to((p / "assets" / "video").resolve()) or not media.resolve().is_relative_to(p.resolve()) or not media.is_file():
        raise BridgeError("录制视频路径无效")
    if media.stat().st_size != request.get("bytes"):
        raise BridgeError("录制视频内容发生变化", 409)
    stamp = now()
    entry = {key: request[key] for key in ("takeId", "shotId", "editor", "scenePlanDigest", "projectRevision", "sha256", "bytes", "mime", "width", "height", "duration", "path")}
    if request.get("fps") is not None:
        entry["fps"] = request["fps"]
    entry.update(sceneId=shot["scene_id"], createdAt=stamp)
    manifest, _ = artifact(p, "assets")
    manifest = copy.deepcopy(manifest or {"version": "1.0", "assets": []})
    manifest["assets"].append({"id": f"track-{take_id}", "type": "video", "path": relative, "source_tool": f"track_{shot['editor']}_editor",
                               "scene_id": shot["scene_id"], "duration_seconds": request["duration"], "resolution": f"{request['width']}x{request['height']}",
                               "format": request["mime"].split("/")[-1], "generation_summary": f"Track 镜头工程 {request['projectRevision']}，原生实际录制；take {take_id}"})
    manifest.setdefault("metadata", {}).setdefault("track_takes", []).append(entry)
    _, validate = native()
    validate("asset_manifest", manifest)
    # A partial recording is never a completed or approved assets stage.
    cp = native_checkpoint(p, "assets", manifest, status_value="in_progress", metadata={"partial_progress": {"completed": len(receipts["takes"]) + 1, "unit": "track_recordings"}})
    receipts["takes"].append(entry)
    writes = {"artifacts/asset_manifest.json": manifest, "checkpoint_assets.json": cp, "track-takes.json": receipts}
    snapshot(p, "artifacts/asset_manifest.json", writes)
    snapshot(p, "checkpoint_assets.json", writes)
    transaction(p, writes)
    return entry


def engine_envelope(value, editor, track_id):
    """JS owns the renderer's deep validation; lock owner protects basic CAS."""
    schema = "cqai-track-geomotion@1" if editor == "map" else "cqai-track-shot-editor@1"
    fields = {"schema", "trackId", "sourceFingerprint", "document", "revision", "updatedAt"} if editor == "map" else {"schema", "plan", "appearance", "revision", "updatedAt"}
    if not isinstance(value, dict) or set(value) != fields or value.get("schema") != schema:
        raise BridgeError("镜头工程版本或结构损坏，保留原文件后恢复备份")
    rev, updated = value.get("revision"), value.get("updatedAt")
    if not isinstance(rev, str) or not rev.strip() or len(rev) > 256 or not isinstance(updated, str):
        raise BridgeError("镜头工程修订或更新时间无效")
    try:
        datetime.fromisoformat(updated.replace("Z", "+00:00"))
    except ValueError as exc:
        raise BridgeError("镜头工程更新时间无效") from exc
    if editor == "map":
        if value.get("trackId") != track_id or not isinstance(value.get("sourceFingerprint"), str) or not value["sourceFingerprint"].strip() or len(value["sourceFingerprint"]) > 512 or not isinstance(value.get("document"), dict):
            raise BridgeError("地图镜头工程所属轨迹或文档无效")
    else:
        plan = value.get("plan")
        if not isinstance(plan, dict) or plan.get("trackId") != track_id or plan.get("version") != 1 or not isinstance(value.get("appearance"), dict):
            raise BridgeError("沙盘镜头工程所属轨迹或文档无效")
    return value


def write_engine(p, request):
    editor = request.get("editor")
    if editor not in ("map", "sandbox"):
        raise BridgeError("镜头编辑器类型无效")
    shot_id = identifier(request.get("shotId"))
    directory = p / "shots" / shot_id
    if not directory.is_dir() or directory.is_symlink() or not directory.resolve().is_relative_to(p.resolve()):
        raise BridgeError("镜头目录不存在", 404)
    shot = read_json(directory / "shot-binding.json")
    if not isinstance(shot, dict) or shot.get("shot_id") != shot_id or shot.get("track_id") != request["trackId"] or shot.get("editor") != editor:
        raise BridgeError("镜头工程与当前项目绑定不匹配", 409)
    # Existing bindings are immutable. A metadata-only edit cannot redirect an
    # engine save or take to another scene, even though creative digest excludes it.
    art, _ = artifact(p, "scene_plan")
    if not art or next((item for item in mappings(art) if item["shot_id"] == shot_id), None) != shot:
        raise BridgeError("分镜映射已变化，镜头原文件保留", 409)
    file = "geomotion-project.json" if editor == "map" else "shot-editor-project.json"
    previous = read_json(directory / file)
    if previous is not None:
        engine_envelope(previous, editor, request["trackId"])
    if "expectedRevision" not in request:
        raise BridgeError("缺少镜头工程修订号；首次保存也须明确传 null")
    expected = request.get("expectedRevision")
    if expected is not None and (not isinstance(expected, str) or not expected.strip() or len(expected) > 256):
        raise BridgeError("缺少有效的镜头工程修订号")
    if expected != (previous.get("revision") if previous else None):
        raise BridgeError("镜头工程已被其他操作更新，请重新读取后重试", 409)
    value = engine_envelope(request.get("project"), editor, request["trackId"])
    maximum = 16 * 1024 * 1024 + 4096 if editor == "map" else 2_000_000 + 4096
    if len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()) > maximum:
        raise BridgeError("镜头工程超过原编辑器大小上限", 413)
    relative = f"shots/{shot_id}/{file}"
    writes = {relative: value}
    snapshot(p, relative, writes)
    transaction(p, writes)
    return value


def reconcile(p):
    """External edits never retain a stale approval on the original board."""
    rows = status(p)
    saved = ledger(p)
    writes = {}
    invalid = False
    for row in rows:
        stage = row["stage"]
        receipt = saved["stages"].get(stage, {})
        if receipt.get("approvedDigest") and not row["approved"]:
            invalid = True
        if invalid:
            saved["stages"].pop(stage, None)
            cp = read_json(p / f"checkpoint_{stage}.json")
            if cp and (cp.get("human_approved") or cp.get("status") == "completed"):
                snapshot(p, f"checkpoint_{stage}.json", writes)
                cp = copy.deepcopy(cp)
                cp.update(status="in_progress", human_approved=False, timestamp=now())
                cp.setdefault("metadata", {})["track_approval_invalidated"] = True
                writes[f"checkpoint_{stage}.json"] = cp
    if invalid:
        invalidate(p, "scene_plan", saved, writes)
        writes["track-approvals.json"] = saved
    if writes:
        transaction(p, writes)


def project_state(p):
    reconcile(p)
    from backlot.state import load_board_state
    rows = status(p)
    plan, _ = artifact(p, "scene_plan")
    return {"board": load_board_state(p), "stages": rows,
            "scenePlanDigest": rows[-1]["digest"], "canProduce": all(row["approved"] for row in rows),
            "currentStage": next((row["stage"] for row in rows if not row["approved"]), "assets"),
            "mappings": mappings(plan) if plan else [], "takes": read_json(p / "track-takes.json", {"takes": []})["takes"]}


def detect():
    issues = []
    for module in ("jsonschema", "yaml", "fastapi", "uvicorn", "watchfiles", "PIL", "lib.checkpoint", "schemas.artifacts", "backlot.server"):
        try:
            importlib.import_module(module)
        except Exception as exc:
            issues.append(f"{module}: {exc}")
    try:
        from lib.pipeline_loader import load_pipeline
        manifest = load_pipeline("hybrid")
        from lib.paths import REPO_ROOT
        for stage in manifest["stages"]:
            path = REPO_ROOT / "skills" / f"{stage['skill']}.md"
            if not path.is_file():
                issues.append(f"阶段 director 缺失: {path}")
        for name in ("AGENT_GUIDE.md", "skills/meta/checkpoint-protocol.md"):
            if not (REPO_ROOT / name).is_file():
                issues.append(f"指引缺失: {name}")
    except Exception as exc:
        issues.append(f"hybrid pipeline: {exc}")
    return {"ready": not issues, "issues": issues, "pythonVersion": sys.version.split()[0]}


def install_backlot_chinese(server):
    """Present this owned Backlot UI; canonical artifacts stay untouched."""
    from fastapi.responses import FileResponse, HTMLResponse
    from starlette.routing import Route

    locale_file = Path(__file__).with_name("openmontage_zh_cn.js")
    ui_style = Path(__file__).with_name("openmontage_ui.css")
    ui_script = Path(__file__).with_name("openmontage_ui.js")
    original_html = server._ui_html

    def localized_html(name, assets):
        response = original_html(name, assets)
        html = response.body.decode("utf-8")
        html = html.replace('<html lang="en">', '<html lang="zh-CN">', 1)
        version = str(locale_file.stat().st_mtime_ns)
        script = '<script type="module" src="/ui/track-zh-cn.js?v=' + version + '"></script>'
        style = '<link rel="stylesheet" href="/ui/track-workbench.css?v=' + str(ui_style.stat().st_mtime_ns) + '">'
        workbench = '<script type="module" src="/ui/track-workbench.js?v=' + str(ui_script.stat().st_mtime_ns) + '"></script>'
        html = html.replace("</head>", style + "\n" + script + "\n" + workbench + "\n</head>", 1)
        headers = {key: value for key, value in response.headers.items() if key.lower() != "content-length"}
        return HTMLResponse(html, status_code=response.status_code, headers=headers, background=response.background)

    async def locale_script(request):
        return FileResponse(locale_file, media_type="application/javascript", headers={"Cache-Control": "no-store"})

    async def workbench_style(request):
        return FileResponse(ui_style, media_type="text/css", headers={"Cache-Control": "no-store"})

    async def workbench_script(request):
        return FileResponse(ui_script, media_type="application/javascript", headers={"Cache-Control": "no-store"})

    server._ui_html = localized_html
    # Native /ui is a StaticFiles mount: this exact owned route must precede it.
    server.app.router.routes.insert(0, Route("/ui/track-zh-cn.js", locale_script, methods=["GET"]))
    server.app.router.routes.insert(0, Route("/ui/track-workbench.css", workbench_style, methods=["GET"]))
    server.app.router.routes.insert(0, Route("/ui/track-workbench.js", workbench_script, methods=["GET"]))


def execute(command, request):
    if command == "detect":
        return detect()
    if not os.environ.get("OPENMONTAGE_PROJECTS_DIR"):
        raise BridgeError("缺少独立项目环境，请从 Track 绑定工作区运行桥命令")
    if command == "serve":
        import uvicorn
        import backlot.server
        backlot.server.THUMB_CACHE_DIR = Path(os.environ["TRACK_OPENMONTAGE_THUMB_CACHE"])
        install_backlot_chinese(backlot.server)
        @backlot.server.app.get("/api/track-owner")
        async def track_owner():
            return {"owner": os.environ["TRACK_OPENMONTAGE_OWNER"]}
        uvicorn.run(backlot.server.app, host="127.0.0.1", port=int(request["port"]), log_level="warning")
        return {}
    project_id = identifier(request.get("projectId"))
    if command == "create":
        from lib.checkpoint import init_project
        ROOT.mkdir(parents=True, exist_ok=True)
        p = ROOT / project_id
        try:
            p.mkdir(exist_ok=False)
        except FileExistsError as exc:
            raise BridgeError("项目编号已存在", 409) from exc
        with locked(p):
            init_project(project_id, title=request["title"], pipeline_type="hybrid", pipeline_dir=ROOT)
            atomic_json(p / "track-binding.json", {"version": 1, "trackId": identifier(request["trackId"]), "projectId": project_id,
                                                   "title": request["title"], "createdAt": now(), "updatedAt": now(), "sessionId": None})
        return {"path": display_path(p)}
    p = project_path(project_id)
    binding(p, request.get("trackId"))
    with locked(p):
        if command == "state":
            return project_state(p)
        if command == "commit":
            return commit(p, request)
        if command == "approve":
            return approve(p, request)
        if command == "bind":
            return bind_shot(p, request)
        if command == "take":
            return take(p, request)
        if command == "engine-write":
            return write_engine(p, request)
        if command == "session":
            saved = binding(p, request["trackId"])
            saved.update(sessionId=identifier(request.get("sessionId")), updatedAt=now())
            transaction(p, {"track-binding.json": saved})
            return {"sessionId": saved["sessionId"]}
        if command == "workspace":
            # Refresh the input snapshot only at explicit Agent entry, never
            # while the board is polling; user's own production artifacts stay.
            transaction(p, {"track-material-snapshot.json": request["snapshot"]})
            agents = p / "AGENTS.md"
            if not agents.exists():
                agents.write_text(request["instructions"], encoding="utf-8")
            return {"path": display_path(p), "sessionId": binding(p, request["trackId"]).get("sessionId")}
    raise BridgeError("桥接命令无效")


def main():
    for output in (sys.stdout, sys.stderr):
        if hasattr(output, "reconfigure"):
            output.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("detect", "serve", "create", "state", "commit", "approve", "bind", "take", "engine-write", "session", "workspace"))
    parser.add_argument("--input", help="JSON request file (otherwise stdin)")
    parser.add_argument("--port", type=int)
    args = parser.parse_args()
    try:
        if args.command == "serve":
            request = {"port": args.port}
        else:
            request = json.loads(Path(args.input).read_text(encoding="utf-8") if args.input else sys.stdin.buffer.read().decode("utf-8") or "{}")
        result = execute(args.command, request)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, allow_nan=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "status": getattr(exc, "status", 400), "error": str(exc)}, ensure_ascii=False))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
