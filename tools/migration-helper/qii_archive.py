"""File-only Chrome/Edge extension migration. This module never installs extensions.

All profile access is explicit: callers choose a profile before reading extension files.
Restores write only to a newly created directory and never modify a browser profile.
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import shutil
import stat
import tempfile
import uuid
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlparse

APP = "qii-migration"
FORMAT_VERSION = 1
MAX_FILES = 100_000
MAX_BYTES = 2 * 1024**3
MAX_MANIFEST_BYTES = 4 * 1024**2
MAX_BACKUP_BYTES = 900_000
MAX_PREF_BYTES = 64 * 1024**2
ID_RE = re.compile(r"[a-p]{32}\Z")
HASH_RE = re.compile(r"[0-9a-f]{64}\Z")
RESERVED = {"con", "prn", "aux", "nul", "conin$", "conout$", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10)), *(f"com{i}" for i in "¹²³"), *(f"lpt{i}" for i in "¹²³")}


@dataclass(frozen=True)
class Profile:
    browser: str
    name: str
    path: Path


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")


def _read_json(path: Path, limit: int) -> Any:
    if path.stat().st_size > limit:
        raise ValueError(f"文件过大：{path.name}")
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _reparse(path: Path) -> bool:
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _assert_real_path(path: Path) -> None:
    for candidate in (path, *path.parents):
        if candidate.exists() or candidate.is_symlink():
            if _reparse(candidate):
                raise ValueError(f"不跟随符号链接或重解析点：{candidate}")


def discover_profiles(user_data_roots: dict[str, Path]) -> list[Profile]:
    """Enumerate profile metadata locations; do not traverse extension code."""
    result: list[Profile] = []
    for browser, directory in user_data_roots.items():
        directory = Path(directory)
        if not directory.is_dir() or _reparse(directory):
            continue
        names: dict[str, str] = {}
        try:
            state = _read_json(directory / "Local State", MAX_PREF_BYTES)
            names = {
                key: str(value.get("name", key))
                for key, value in state.get("profile", {}).get("info_cache", {}).items()
                if isinstance(value, dict)
            }
        except (OSError, ValueError, TypeError, AttributeError):
            pass
        for path in sorted(directory.iterdir(), key=lambda p: p.name.casefold()):
            if not path.is_dir() or _reparse(path):
                continue
            if any((path / name).is_file() for name in ("Preferences", "Secure Preferences")):
                result.append(Profile(browser, names.get(path.name, path.name), path))
    return result


def _profile_settings(profile: Profile) -> dict[str, dict[str, Any]]:
    settings: dict[str, dict[str, Any]] = {}
    readable = False
    for filename in ("Preferences", "Secure Preferences"):
        path = profile.path / filename
        if not path.exists():
            continue
        _assert_real_path(path)
        value = _read_json(path, MAX_PREF_BYTES)
        extension_settings = value.get("extensions", {}).get("settings", {})
        if not isinstance(extension_settings, dict):
            raise ValueError(f"{filename} 中的扩展设置无效")
        readable = True
        for identifier, entry in extension_settings.items():
            if ID_RE.fullmatch(identifier) and isinstance(entry, dict):
                settings[identifier] = {**settings.get(identifier, {}), **entry}
    if not readable:
        raise ValueError("所选目录没有可读的浏览器配置文件")
    return settings


def read_profile_inventory(profile: Profile) -> list[dict[str, Any]]:
    inventory = []
    for identifier, entry in _profile_settings(profile).items():
        if entry.get("location") in (5, 10):  # Browser components are not user installs.
            continue
        manifest = entry.get("manifest", {})
        if not isinstance(manifest, dict):
            manifest = {}
        inventory.append({
            "id": identifier,
            "name": str(manifest.get("name", identifier)),
            "version": str(manifest.get("version", "")),
            "enabled": entry.get("state") == 1,
            "installType": "development" if entry.get("location") in (4, 8) else "admin" if entry.get("location") in (7, 9) else "normal",
            "path": entry.get("path", ""),
            "homepageUrl": manifest.get("homepage_url", ""),
            "updateUrl": manifest.get("update_url", ""),
        })
    return inventory


def select_profile(profiles: list[Profile], inventory: list[dict[str, Any]], manager_id: str | None = None) -> Profile:
    wanted = {item["id"] for item in _validate_inventory(inventory)}
    candidates: list[Profile] = []
    for profile in profiles:
        try:
            known = set(_profile_settings(profile))
        except (OSError, ValueError, TypeError, AttributeError):
            continue
        if manager_id and manager_id not in known:
            continue
        if wanted.issubset(known):
            candidates.append(profile)
    if len(candidates) != 1:
        raise ValueError("无法唯一匹配当前浏览器资料，请明确选择正确的资料目录")
    return candidates[0]


def _validate_inventory(inventory: Any) -> list[dict[str, Any]]:
    if not isinstance(inventory, list) or len(inventory) > 5000:
        raise ValueError("扩展清单必须为最多 5000 项的列表")
    seen = set()
    result = []
    for item in inventory:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not ID_RE.fullmatch(item["id"]):
            raise ValueError("扩展 ID 无效")
        if item["id"] in seen:
            raise ValueError("扩展清单有重复 ID")
        seen.add(item["id"])
        for field in ("name", "version", "installType", "homepageUrl", "updateUrl", "installUrl"):
            if field in item and (not isinstance(item[field], str) or len(item[field]) > 4000):
                raise ValueError(f"扩展字段无效：{field}")
        result.append(dict(item))
    return result


def _source_directory(profile: Profile, item: dict[str, Any], settings: dict[str, dict[str, Any]]) -> Path:
    entry = settings.get(item["id"])
    if entry is None:
        raise FileNotFoundError("此 ID 不在所选浏览器资料中，未读取其他资料中的同名扩展")
    requested = item.get("version", "")
    raw = entry.get("path", "")
    candidates: list[Path] = []
    if isinstance(raw, str) and raw:
        path = Path(raw)
        candidates.extend([path] if path.is_absolute() else [profile.path / path, profile.path / "Extensions" / path])
    if item.get("installType") != "development":
        installed = profile.path / "Extensions" / item["id"]
        if installed.is_dir():
            candidates.extend(sorted(installed.iterdir(), key=lambda path: path.name, reverse=True))
    unique = set()
    for path in candidates:
        if str(path).casefold() in unique:
            continue
        unique.add(str(path).casefold())
        _assert_real_path(path)
        manifest_path = path / "manifest.json"
        if not manifest_path.is_file():
            continue
        _assert_real_path(manifest_path)
        manifest = _read_json(manifest_path, MAX_MANIFEST_BYTES)
        if requested and manifest.get("version") != requested and item.get("installType") != "development":
            continue
        return path
    raise FileNotFoundError("未找到所选资料中对应版本的 manifest.json 或本地扩展目录")


def _safe_member(name: str, *, directory: bool = False) -> str:
    if not isinstance(name, str) or not name or len(name) > 1024 or "\\" in name or "\x00" in name:
        raise ValueError("ZIP 包含无效或歧义路径")
    value = name[:-1] if directory and name.endswith("/") else name
    parts = value.split("/")
    if PurePosixPath(value).is_absolute() or not parts:
        raise ValueError("ZIP 包含绝对路径")
    for part in parts:
        if not part or part in (".", "..") or len(part) > 200 or part.endswith((".", " ")):
            raise ValueError("ZIP 路径包含不安全的目录段")
        if any(ord(char) < 32 or char in '<>:"|?*' for char in part):
            raise ValueError("ZIP 路径包含 Windows 不支持的字符")
        if part.split(".", 1)[0].casefold() in RESERVED:
            raise ValueError("ZIP 路径包含 Windows 保留名称")
    return value


def _tree_files(root: Path):
    def walk(directory: Path):
        for path in sorted(directory.iterdir(), key=lambda p: p.name.casefold()):
            if _reparse(path):
                yield path, "不跟随符号链接或重解析点"
            elif path.is_dir():
                yield from walk(path)
            elif path.is_file():
                yield path, None
            else:
                yield path, "不是普通文件"
    yield from walk(root)


def _valid_backup(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("app") != "qii-extension-manager" or value.get("version") not in (1, 2):
        raise ValueError("管理器配置备份格式无效")
    _validate_inventory(value.get("inventory", []))
    if not isinstance(value.get("data"), dict) or value["data"].get("schemaVersion") != 1:
        raise ValueError("管理器配置数据无效")
    if len(_json_bytes(value)) > MAX_BACKUP_BYTES:
        raise ValueError("管理器配置超过本地消息可返回的大小限制")
    return value


def preview_sources(profile: Profile, inventory: list[dict[str, Any]]) -> list[dict[str, str]]:
    settings = _profile_settings(profile)
    rows = []
    for item in _validate_inventory(inventory):
        row = {"id": item["id"], "name": item.get("name", item["id"])}
        try:
            row["path"] = str(_source_directory(profile, item, settings))
        except (OSError, ValueError, TypeError) as error:
            row["problem"] = str(error)
        rows.append(row)
    return rows


def export_archive(profile: Profile, destination: Path, inventory: list[dict[str, Any]] | None = None, manager_backup: dict[str, Any] | None = None, *, source_overrides: dict[str, Path] | None = None) -> dict[str, Any]:
    destination = Path(destination)
    if destination.exists():
        raise FileExistsError("目标文件已存在，请选择新的 ZIP 文件名")
    if not destination.parent.is_dir():
        raise ValueError("备份保存目录不存在")
    _assert_real_path(destination.parent)
    items = _validate_inventory(inventory if inventory is not None else read_profile_inventory(profile))
    if not items:
        raise ValueError("所选资料没有可备份的扩展")
    settings = _profile_settings(profile)
    for identifier, override in (source_overrides or {}).items():
        if identifier not in {item["id"] for item in items}:
            raise ValueError("手动定位的目录不属于本次备份清单")
        # Only the explicit ID selected by the user is mapped. Never infer by name.
        settings[identifier] = {**settings.get(identifier, {}), "path": str(Path(override).absolute())}
    # Resolve before opening the temporary ZIP. A destination inside an extension's
    # own source tree could otherwise recursively include the growing archive itself.
    for item in items:
        try:
            source = _source_directory(profile, item, settings).resolve(strict=True)
        except (OSError, ValueError, TypeError):
            continue
        try:
            destination.absolute().resolve().relative_to(source)
        except ValueError:
            pass
        else:
            raise ValueError("备份 ZIP 不能保存到任何待备份扩展的源码目录内")
    backup_bytes = _json_bytes(_valid_backup(manager_backup)) if manager_backup is not None else None
    now = datetime.now(timezone.utc).isoformat()
    manifest: dict[str, Any] = {
        "app": APP, "formatVersion": FORMAT_VERSION, "exportedAt": now,
        "profile": {"browser": profile.browser, "name": profile.name},
        "complete": False, "items": [],
        "scope": "extension-code-and-manager-config-only",
        "installationIncluded": False,
    }
    count = total = 0
    temp_path = destination.parent / f".{destination.name}.{uuid.uuid4().hex}.partial"
    try:
        with zipfile.ZipFile(temp_path, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
            for item in items:
                record: dict[str, Any] = {
                    key: item[key] for key in ("id", "name", "version", "enabled", "installType", "homepageUrl", "updateUrl", "installUrl") if key in item
                }
                record.update({"source": item.get("installType", "normal"), "files": [], "status": "included", "errors": []})
                try:
                    source = _source_directory(profile, item, settings)
                    record["sourcePath"] = str(source)
                    disk_manifest = _read_json(source / "manifest.json", MAX_MANIFEST_BYTES)
                    if item.get("version") and disk_manifest.get("version") != item["version"]:
                        record["errors"].append("本地代码版本与浏览器清单不同；已保存磁盘上的代码，请核对版本")
                    for path, problem in _tree_files(source):
                        relative = path.relative_to(source).as_posix()
                        if problem:
                            record["errors"].append(f"{relative}：{problem}")
                            continue
                        try:
                            _safe_member(relative)
                            before = path.stat()
                            if count + 1 > MAX_FILES or total + before.st_size > MAX_BYTES:
                                raise OverflowError("备份超过 100000 个文件或 2 GiB 大小限制")
                            digest = hashlib.sha256()
                            # Stage each complete file first so a failed read cannot leave an
                            # unindexed partial ZIP member that would be impossible to validate.
                            with tempfile.TemporaryFile() as stage:
                                with path.open("rb") as handle:
                                    while chunk := handle.read(1024 * 1024):
                                        stage.write(chunk)
                                        digest.update(chunk)
                                size = stage.tell()
                                after = path.stat()
                                if size != before.st_size or before.st_mtime_ns != after.st_mtime_ns or before.st_size != after.st_size:
                                    raise OSError("备份期间文件发生变化，请重试")
                                stage.seek(0)
                                member = f"extensions/{item['id']}/{relative}"
                                with archive.open(member, "w", force_zip64=True) as target:
                                    shutil.copyfileobj(stage, target, 1024 * 1024)
                            count += 1
                            total += size
                            record["files"].append({"path": relative, "size": size, "sha256": digest.hexdigest()})
                        except OverflowError:
                            raise
                        except (OSError, ValueError) as error:
                            record["errors"].append(f"{relative}：{error}")
                    if not any(file["path"] == "manifest.json" for file in record["files"]):
                        record["errors"].append("manifest.json 未完整保存")
                    if record["errors"]:
                        record["status"] = "failed"
                except FileNotFoundError as error:
                    record["status"] = "missing"
                    record["errors"].append(str(error))
                except (OSError, ValueError, TypeError) as error:
                    record["status"] = "failed"
                    record["errors"].append(str(error))
                manifest["items"].append(record)
            if backup_bytes is not None:
                archive.writestr("manager-backup.json", backup_bytes)
                manifest["managerBackup"] = {"path": "manager-backup.json", "size": len(backup_bytes), "sha256": hashlib.sha256(backup_bytes).hexdigest()}
            manifest["complete"] = all(item["status"] == "included" for item in manifest["items"])
            manifest["fileCount"], manifest["totalBytes"] = count, total
            manifest_bytes = _json_bytes(manifest)
            if len(manifest_bytes) > MAX_MANIFEST_BYTES:
                raise ValueError("迁移清单超过 4 MiB 限制，未生成备份")
            archive.writestr("manifest.json", manifest_bytes)
        # Exclusive final creation prevents accidental replacement, even if another process
        # created the chosen filename while the archive was being assembled.
        final_created = False
        try:
            with destination.open("xb") as target:
                final_created = True
                with temp_path.open("rb") as source:
                    shutil.copyfileobj(source, target, 1024 * 1024)
        except Exception:
            if final_created:
                destination.unlink(missing_ok=True)
            raise
        result = {
            "ok": True, "action": "export", "archivePath": str(destination),
            "complete": manifest["complete"], "fileCount": count, "totalBytes": total,
            "managerConfigIncluded": manager_backup is not None,
            "items": [{"id": item["id"], "name": item.get("name", item["id"]), "status": item["status"], **({"message": "; ".join(item["errors"])} if item["errors"] else {})} for item in manifest["items"]],
        }
        report_path = destination.with_suffix(destination.suffix + ".report.json")
        try:
            with report_path.open("x", encoding="utf-8") as handle:
                json.dump(result, handle, ensure_ascii=False, indent=2)
            result["reportPath"] = str(report_path)
        except OSError:
            result["reportWarning"] = "备份文件已写入，但旁置报告未保存；逐项记录仍在 ZIP 清单中"
        return result
    finally:
        temp_path.unlink(missing_ok=True)


def _zip_index(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    entries: dict[str, zipfile.ZipInfo] = {}
    folded = set()
    total = 0
    infos = archive.infolist()
    if len(infos) > MAX_FILES + 2:
        raise ValueError("ZIP 文件和目录项数量超过限制")
    for info in infos:
        name = _safe_member(info.filename, directory=info.is_dir())
        folded_name = name.casefold()
        if folded_name in folded:
            raise ValueError("ZIP 存在重复或仅大小写不同的路径")
        folded.add(folded_name)
        kind = stat.S_IFMT(info.external_attr >> 16)
        if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or kind == stat.S_IFLNK:
            raise ValueError("ZIP 包含符号链接或特殊文件")
        if info.flag_bits & 1 or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise ValueError("不支持加密或特殊压缩格式")
        if info.is_dir():
            continue
        total += info.file_size
        if len(entries) + 1 > MAX_FILES + 2 or total > MAX_BYTES + MAX_MANIFEST_BYTES + MAX_BACKUP_BYTES:
            raise ValueError("ZIP 解压大小或文件数量超过限制")
        if info.file_size > 1024**2 and info.file_size / max(1, info.compress_size) > 1000:
            raise ValueError("ZIP 压缩比异常")
        entries[name] = info
    for name in entries:
        ancestors = PurePosixPath(name).parents
        if any(str(parent) in entries for parent in ancestors if str(parent) != "."):
            raise ValueError("ZIP 文件路径与目录路径冲突")
    return entries


def _read_member(archive: zipfile.ZipFile, info: zipfile.ZipInfo, limit: int) -> bytes:
    if info.file_size > limit:
        raise ValueError("ZIP 内清单文件过大")
    with archive.open(info) as source:
        content = source.read(limit + 1)
    if len(content) > limit or len(content) != info.file_size:
        raise ValueError("ZIP 文件大小不一致")
    return content


def _check_file(archive: zipfile.ZipFile, info: zipfile.ZipInfo, expected: dict[str, Any]) -> None:
    if not isinstance(expected.get("size"), int) or isinstance(expected["size"], bool) or expected["size"] < 0 or expected["size"] != info.file_size:
        raise ValueError("迁移文件大小校验失败")
    if not isinstance(expected.get("sha256"), str) or not HASH_RE.fullmatch(expected["sha256"]):
        raise ValueError("迁移文件哈希格式无效")
    digest = hashlib.sha256()
    size = 0
    with archive.open(info) as source:
        while chunk := source.read(1024 * 1024):
            size += len(chunk)
            if size > expected["size"]:
                raise ValueError("迁移文件解压大小异常")
            digest.update(chunk)
    if size != expected["size"] or digest.hexdigest() != expected["sha256"]:
        raise ValueError("迁移文件 SHA256 校验失败")


def _validate_archive(archive: zipfile.ZipFile):
    entries = _zip_index(archive)
    if "manifest.json" not in entries:
        raise ValueError("ZIP 缺少迁移清单 manifest.json")
    manifest = json.loads(_read_member(archive, entries["manifest.json"], MAX_MANIFEST_BYTES))
    if not isinstance(manifest, dict) or manifest.get("app") != APP or manifest.get("formatVersion") != FORMAT_VERSION:
        raise ValueError("不是受支持的栖扩展文件迁移包")
    items = _validate_inventory(manifest.get("items"))
    if not items:
        raise ValueError("迁移清单为空")
    expected = {"manifest.json"}
    files_to_extract = []
    code_bytes = code_count = 0
    for item in items:
        if item.get("status") not in ("included", "missing", "failed") or not isinstance(item.get("files"), list):
            raise ValueError("迁移项目状态或文件列表无效")
        if item["status"] == "missing" and item["files"]:
            raise ValueError("缺失项目不能包含文件")
        has_manifest = False
        for file in item["files"]:
            if not isinstance(file, dict):
                raise ValueError("迁移文件记录无效")
            relative = _safe_member(file.get("path"))
            member = f"extensions/{item['id']}/{relative}"
            if member in expected:
                raise ValueError("迁移清单包含重复文件")
            expected.add(member)
            if member not in entries:
                raise ValueError("ZIP 缺少清单声明的文件")
            _check_file(archive, entries[member], file)
            code_bytes += file["size"]
            code_count += 1
            if code_bytes > MAX_BYTES or code_count > MAX_FILES:
                raise ValueError("扩展代码文件大小或数量超过恢复限制")
            files_to_extract.append((member, file))
            has_manifest |= relative == "manifest.json"
        if item["status"] == "included" and not has_manifest:
            raise ValueError("完整项目缺少 manifest.json")
    manager_backup = None
    if "managerBackup" in manifest:
        record = manifest["managerBackup"]
        if not isinstance(record, dict) or record.get("path") != "manager-backup.json" or record["path"] not in entries:
            raise ValueError("管理器配置记录无效")
        expected.add(record["path"])
        _check_file(archive, entries[record["path"]], record)
        manager_backup = _valid_backup(json.loads(_read_member(archive, entries[record["path"]], MAX_BACKUP_BYTES)))
    if set(entries) != expected:
        raise ValueError("ZIP 包含未在迁移清单中声明的额外文件")
    return manifest, items, files_to_extract, manager_backup, entries


def _store_url(item: dict[str, Any]) -> str | None:
    if item.get("installType") == "development":
        return None
    identifier = item["id"]
    for field in ("updateUrl", "installUrl", "homepageUrl"):
        try:
            url = urlparse(item.get(field, ""))
        except (TypeError, ValueError):
            continue
        try:
            if url.scheme != "https" or url.username or url.password or url.port:
                continue
        except ValueError:
            continue
        if (url.hostname == "clients2.google.com" and url.path == "/service/update2/crx") or (url.hostname in ("chromewebstore.google.com", "chrome.google.com") and url.path.endswith("/" + identifier)):
            return f"https://chromewebstore.google.com/detail/{identifier}"
        if (url.hostname == "edge.microsoft.com" and url.path == "/extensionwebstorebase/v1/crx") or (url.hostname == "microsoftedge.microsoft.com" and url.path.endswith("/" + identifier)):
            return f"https://microsoftedge.microsoft.com/addons/detail/{identifier}"
    return None


def _write_guide(path: Path, result: dict[str, Any], source_items: list[dict[str, Any]]) -> None:
    rows = []
    for item, source in zip(result["items"], source_items):
        name = html.escape(item["name"])
        code_path = html.escape(item.get("path", ""), quote=True)
        link = _store_url(source)
        store = f'<a href="{html.escape(link, quote=True)}" target="_blank" rel="noopener noreferrer">打开官方商店</a>' if link else "本地/未知来源：在浏览器扩展页选择“加载解压缩的扩展”"
        status = "文件已还原，待浏览器安装确认" if item["status"] == "files-restored" else html.escape(item.get("message", "文件未完整恢复"))
        copy = f'<button data-path="{code_path}">复制目录</button><code>{code_path}</code>' if code_path else ""
        rows.append(f"<tr><td><b>{name}</b><small>{html.escape(item['id'])}</small></td><td>{status}</td><td>{store}{copy}</td></tr>")
    content = """<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>栖 · 扩展文件迁移清单</title>
<style>body{font:15px/1.7 system-ui,'Microsoft YaHei';max-width:1100px;margin:40px auto;padding:0 24px;background:#f7f8f4;color:#2d3c31}h1{font-size:27px}p{max-width:850px}table{width:100%;border-collapse:collapse;background:white}td,th{padding:16px;text-align:left;border-bottom:1px solid #d9e0d7;vertical-align:top}small,code{display:block;font-size:12px;overflow-wrap:anywhere}small{color:#647168}button,a{display:inline-block;margin:5px 12px 5px 0;color:#315e46}button{padding:5px 12px;background:#eef2e9;border:1px solid #d9e0d7;border-radius:5px}a:focus-visible,button:focus-visible{text-decoration:underline}</style>
<h1>扩展文件已解包，等待浏览器安装确认</h1><p>这里恢复的是扩展实际代码文件；没有把扩展静默安装进 Chrome 或 Edge。商店项目可前往官方商店安装，本地项目在 <b>chrome://extensions</b> 或 <b>edge://extensions</b> 打开开发者模式，再选择对应目录。一个本地目录对应一个扩展，不能选择总目录代替所有扩展。</p><p>本地扩展缺少固定 manifest.key 时，换电脑或目录可能改变 ID。请在安装后回到管理器核对状态；不要仅凭同名把不同 ID 当成已恢复。此备份不包含密码、Cookie、登录状态或其他扩展的私有存储。</p><table><thead><tr><th>扩展</th><th>文件结果</th><th>安装入口与目录</th></tr></thead><tbody>ROWS</tbody></table>
<script>document.querySelectorAll('button[data-path]').forEach(b=>b.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(b.dataset.path);b.textContent='已复制'}catch{prompt('复制下面的目录',b.dataset.path)}}));</script></html>"""
    path.write_text(content.replace("ROWS", "".join(rows)), encoding="utf-8")


def restore_archive(archive_path: Path, destination_parent: Path) -> dict[str, Any]:
    archive_path, destination_parent = Path(archive_path), Path(destination_parent)
    if not destination_parent.is_dir():
        raise ValueError("请选择已经存在的恢复保存目录")
    _assert_real_path(destination_parent)
    _assert_real_path(archive_path)
    root: Path | None = None
    try:
        with zipfile.ZipFile(archive_path, "r") as archive:
            manifest, items, files, manager_backup, entries = _validate_archive(archive)
            # No output directory is created until all members and hashes pass preflight.
            prefix = datetime.now().strftime("Qii-Restore-%Y%m%d-%H%M%S-")
            root = Path(tempfile.mkdtemp(prefix=prefix, dir=destination_parent))
            for member, expected in files:
                target = root.joinpath(*member.split("/"))
                target.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                with archive.open(entries[member]) as source, target.open("xb") as output:
                    while chunk := source.read(1024 * 1024):
                        output.write(chunk)
                        digest.update(chunk)
                if target.stat().st_size != expected["size"] or digest.hexdigest() != expected["sha256"]:
                    raise ValueError("恢复过程中校验失败，未保留不完整目录")
            if manager_backup is not None:
                (root / "manager-backup.json").write_bytes(_json_bytes(manager_backup))
            result: dict[str, Any] = {
                "ok": True, "action": "import", "directory": str(root), "restoreRoot": str(root),
                "complete": all(item["status"] == "included" for item in items), "installed": False,
                "items": [{
                    "id": item["id"], "name": item.get("name", item["id"]),
                    "status": "files-restored" if item["status"] == "included" else item["status"],
                    **({"path": str(root / "extensions" / item["id"])} if item["files"] else {}),
                    "message": "文件已还原，待浏览器安装确认" if item["status"] == "included" else "原备份未包含完整文件，需重新备份或安装",
                } for item in items],
                "reportPath": str(root / "restore-report.json"), "guidePath": str(root / "安装扩展清单.html"),
            }
            if manager_backup is not None:
                result["managerBackup"] = manager_backup
            _write_guide(Path(result["guidePath"]), result, items)
            Path(result["reportPath"]).write_bytes(_json_bytes(result))
            return result
    except Exception:
        if root is not None and root.is_dir():
            # This is only the fresh directory created above, never a selected existing folder.
            root.relative_to(destination_parent)
            shutil.rmtree(root)
        raise
