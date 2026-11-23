"""Migration archive regression tests. All profiles and files are synthetic and temporary."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock
import warnings
import zipfile

import qii_archive as archive


STORE_ID = "a" * 32
LOCAL_ID = "b" * 32
MISSING_ID = "d" * 32


def json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")


class MigrationArchiveTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="qii-archive-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.export_index = 0
        self.user_data = self.root / "Synthetic User Data"
        self.profile_path = self.user_data / "Default"
        self.store = self.profile_path / "Extensions" / STORE_ID / "1.2.3_0"
        self.local = self.root / "本地开发扩展"
        self.output = self.root / "backups"
        self.restored = self.root / "restored"
        for directory in [self.store, self.local, self.output, self.restored]:
            directory.mkdir(parents=True, exist_ok=True)
        self.store_manifest = {
            "manifest_version": 3,
            "name": "Synthetic Store Extension",
            "version": "1.2.3",
            "key": "c3ludGhldGljLXB1YmxpYy1rZXk=",
            "update_url": "https://clients2.google.com/service/update2/crx",
        }
        self.local_manifest = {
            "manifest_version": 3,
            "name": "本地扩展 · 测试",
            "version": "2.0.0",
            "key": "bG9jYWwtcHVibGljLWtleQ==",
        }
        (self.store / "manifest.json").write_bytes(json_bytes(self.store_manifest))
        (self.store / "worker.js").write_bytes(b"console.log('store fixture');\n")
        (self.local / "manifest.json").write_bytes(json_bytes(self.local_manifest))
        (self.local / "assets").mkdir()
        (self.local / "assets" / "local.txt").write_text("花瓣与水晶\n", encoding="utf-8")
        (self.local / "binary.dat").write_bytes(bytes(range(256)))
        self.preferences = {
            "extensions": {
                "settings": {
                    STORE_ID: {
                        "path": f"Extensions/{STORE_ID}/1.2.3_0",
                        "location": 1,
                        "state": 1,
                        "manifest": self.store_manifest,
                    },
                    LOCAL_ID: {
                        "path": str(self.local),
                        "location": 4,
                        "state": 1,
                        "manifest": self.local_manifest,
                    },
                }
            }
        }
        self.write_preferences()
        self.profile = archive.Profile("Chrome", "Default", self.profile_path)
        (self.profile_path / "Cookies").write_bytes(b"SYNTHETIC-COOKIE-SECRET-NEVER-EXPORT")
        (self.profile_path / "Login Data").write_bytes(b"SYNTHETIC-PASSWORD-SECRET-NEVER-EXPORT")
        self.inventory = [
            {
                "id": STORE_ID,
                "name": self.store_manifest["name"],
                "version": self.store_manifest["version"],
                "installType": "normal",
                "enabled": True,
                "updateUrl": self.store_manifest["update_url"],
            },
            {
                "id": LOCAL_ID,
                "name": self.local_manifest["name"],
                "version": self.local_manifest["version"],
                "installType": "development",
                "enabled": True,
            },
        ]

    def write_preferences(self) -> None:
        (self.profile_path / "Preferences").write_bytes(json_bytes(self.preferences))

    def export(self, *, inventory=None, manager_backup=None, name="valid.zip"):
        self.export_index += 1
        if name == "valid.zip":
            name = f"valid-{self.export_index}.zip"
        destination = self.output / name
        report = archive.export_archive(
            self.profile,
            destination,
            inventory=self.inventory if inventory is None else inventory,
            manager_backup=manager_backup,
        )
        return destination, report

    def read_zip(self, filename: Path) -> tuple[dict, list[tuple[zipfile.ZipInfo, bytes]]]:
        with zipfile.ZipFile(filename) as file:
            manifest = json.loads(file.read("manifest.json"))
            entries = [(info, file.read(info)) for info in file.infolist()]
        return manifest, entries

    def rewritten(self, filename: Path, manifest: dict, entries) -> Path:
        target = self.output / "mutated.zip"
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as file:
                for info, data in entries:
                    name = info.filename if isinstance(info, zipfile.ZipInfo) else info
                    if name == "manifest.json":
                        data = json_bytes(manifest)
                    file.writestr(info, data)
        return target

    def assert_refused_without_writes(self, filename: Path) -> None:
        before = sorted(path.relative_to(self.restored).as_posix() for path in self.restored.rglob("*"))
        with self.assertRaises((ValueError, OSError, zipfile.BadZipFile)):
            archive.restore_archive(filename, self.restored)
        after = sorted(path.relative_to(self.restored).as_posix() for path in self.restored.rglob("*"))
        self.assertEqual(before, after, "invalid archive must not create a partial restore directory")

    def listed_extra_path(self, relative: str, zip_name: str | None = None) -> Path:
        original, _ = self.export()
        manifest, entries = self.read_zip(original)
        item = next(row for row in manifest["items"] if row["id"] == STORE_ID)
        data = b"synthetic payload"
        item["files"].append({
            "path": relative,
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        })
        entries.append((zip_name or f"extensions/{STORE_ID}/{relative}", data))
        return self.rewritten(original, manifest, entries)

    def test_profile_discovery_and_inventory_include_store_and_local_sources(self) -> None:
        profiles = archive.discover_profiles({"Chrome": self.user_data})
        self.assertEqual(len(profiles), 1)
        self.assertEqual(Path(profiles[0].path), self.profile_path)
        rows = {row["id"]: row for row in archive.read_profile_inventory(profiles[0])}
        self.assertEqual(set(rows), {STORE_ID, LOCAL_ID})
        self.assertEqual(Path(rows[LOCAL_ID]["path"]), self.local)
        self.assertEqual(rows[LOCAL_ID]["installType"], "development")
        self.assertEqual(rows[STORE_ID]["version"], "1.2.3")

    def test_secure_preferences_are_included_when_plain_preferences_lacks_an_entry(self) -> None:
        local_entry = self.preferences["extensions"]["settings"].pop(LOCAL_ID)
        self.write_preferences()
        (self.profile_path / "Secure Preferences").write_bytes(json_bytes({
            "extensions": {"settings": {LOCAL_ID: local_entry}}
        }))
        rows = {row["id"]: row for row in archive.read_profile_inventory(self.profile)}
        self.assertIn(LOCAL_ID, rows)
        self.assertEqual(Path(rows[LOCAL_ID]["path"]), self.local)

    def test_roundtrip_preserves_every_file_hash_unicode_and_manifest_key(self) -> None:
        manager_backup = {
            "app": "qii-extension-manager",
            "version": 2,
            "kind": "extensions",
            "exportedAt": "2026-11-18T00:00:00.000Z",
            "source": {"browser": "Chrome", "managerId": STORE_ID},
            "inventory": self.inventory,
            "data": {"schemaVersion": 1, "groups": [], "scenes": [], "meta": {},
                     "settings": {"theme": "light", "view": "grid", "sort": "name", "confirmBulk": True},
                     "activity": []},
        }
        filename, exported = self.export(manager_backup=manager_backup)
        self.assertTrue(exported["complete"])
        manifest, entries = self.read_zip(filename)
        self.assertEqual(manifest["app"], "qii-migration")
        self.assertEqual(manifest["formatVersion"], 1)
        payloads = {info.filename: data for info, data in entries}
        for item in manifest["items"]:
            for info in item["files"]:
                data = payloads[f"extensions/{item['id']}/{info['path']}"]
                self.assertEqual(info["size"], len(data))
                self.assertEqual(info["sha256"], hashlib.sha256(data).hexdigest())
        self.assertNotIn("Cookies", payloads)
        self.assertNotIn("Login Data", payloads)
        self.assertFalse(any(b"SYNTHETIC-COOKIE-SECRET-NEVER-EXPORT" in data for data in payloads.values()))
        self.assertFalse(any(b"SYNTHETIC-PASSWORD-SECRET-NEVER-EXPORT" in data for data in payloads.values()))
        restored = archive.restore_archive(filename, self.restored)
        self.assertTrue(restored["complete"])
        self.assertIs(restored["installed"], False)
        self.assertEqual(restored["managerBackup"], manager_backup)
        destination = Path(restored["restoreRoot"])
        self.assertEqual(next(destination.rglob("binary.dat")).read_bytes(), bytes(range(256)))
        self.assertEqual(next(destination.rglob("local.txt")).read_text(encoding="utf-8"), "花瓣与水晶\n")
        code_manifests = [json.loads(path.read_text(encoding="utf-8"))
                          for path in destination.rglob("manifest.json")
                          if "manifest_version" in json.loads(path.read_text(encoding="utf-8"))]
        self.assertIn(self.local_manifest, code_manifests)
        self.assertIn(self.store_manifest, code_manifests)
        self.assertTrue(all(item.get("status") != "installed" for item in restored["items"]))

    def test_missing_extension_is_reported_as_incomplete_not_silently_omitted(self) -> None:
        inventory = self.inventory + [{
            "id": MISSING_ID, "name": "Missing fixture", "version": "1.0", "installType": "normal", "enabled": False,
        }]
        filename, report = self.export(inventory=inventory)
        self.assertFalse(report["complete"])
        self.assertTrue(filename.is_file())
        serialized = json.dumps(report, ensure_ascii=False)
        self.assertIn(MISSING_ID, serialized)

    def test_profile_selection_rejects_ambiguous_inventory(self) -> None:
        other_path = self.user_data / "Profile 1"
        other_path.mkdir()
        (other_path / "Preferences").write_bytes(json_bytes(self.preferences))
        other = archive.Profile("Chrome", "Profile 1", other_path)
        with self.assertRaises(ValueError):
            archive.select_profile([self.profile, other], self.inventory)
        self.assertEqual(archive.select_profile([self.profile], self.inventory).path, self.profile.path)

    def test_exports_never_follow_source_symlinks(self) -> None:
        outside = self.root / "outside-secret.txt"
        outside.write_text("must not follow link", encoding="utf-8")
        link = self.local / "linked.txt"
        try:
            link.symlink_to(outside)
        except OSError as error:
            self.skipTest(f"This test account cannot create symlinks: {error}")
        filename, report = self.export()
        self.assertFalse(report["complete"])
        with zipfile.ZipFile(filename) as file:
            self.assertNotIn(f"extensions/{LOCAL_ID}/linked.txt", file.namelist())

    def test_hash_tampering_is_rejected_before_any_restore_write(self) -> None:
        filename, _ = self.export()
        manifest, entries = self.read_zip(filename)
        target = f"extensions/{STORE_ID}/worker.js"
        entries = [(info, b"tampered bytes" if info.filename == target else data) for info, data in entries]
        self.assert_refused_without_writes(self.rewritten(filename, manifest, entries))

    def test_unlisted_extra_payload_is_rejected(self) -> None:
        filename, _ = self.export()
        manifest, entries = self.read_zip(filename)
        entries.append((f"extensions/{STORE_ID}/unlisted.js", b"unlisted"))
        self.assert_refused_without_writes(self.rewritten(filename, manifest, entries))

    def test_unsupported_archive_format_is_rejected_before_writes(self) -> None:
        filename, _ = self.export()
        manifest, entries = self.read_zip(filename)
        manifest["formatVersion"] = 9000
        self.assert_refused_without_writes(self.rewritten(filename, manifest, entries))

    def test_windows_and_zip_path_attacks_are_rejected_before_writes(self) -> None:
        for relative in ["../../escape.txt", "/absolute.txt", "nested\\escape.txt",
                         "secret.txt:stream", "CON.txt", "nested/NUL", "trailing. ",
                         "C:/drive.txt"]:
            with self.subTest(relative=relative):
                self.assert_refused_without_writes(self.listed_extra_path(relative))
        self.assertFalse((self.root / "escape.txt").exists())

    def test_casefold_duplicate_payloads_are_rejected(self) -> None:
        filename, _ = self.export()
        manifest, entries = self.read_zip(filename)
        item = next(row for row in manifest["items"] if row["id"] == STORE_ID)
        worker = next(row for row in item["files"] if row["path"] == "worker.js")
        item["files"].append({**worker, "path": "WORKER.JS"})
        data = next(data for info, data in entries if info.filename == f"extensions/{STORE_ID}/worker.js")
        entries.append((f"extensions/{STORE_ID}/WORKER.JS", data))
        self.assert_refused_without_writes(self.rewritten(filename, manifest, entries))

    def test_duplicate_zip_entry_is_rejected(self) -> None:
        filename, _ = self.export()
        manifest, entries = self.read_zip(filename)
        entries.append(next(entry for entry in entries if entry[0].filename.endswith("/worker.js")))
        self.assert_refused_without_writes(self.rewritten(filename, manifest, entries))

    def test_zip_symlink_is_rejected_even_with_a_listed_payload(self) -> None:
        filename, _ = self.export()
        manifest, entries = self.read_zip(filename)
        target = f"extensions/{STORE_ID}/worker.js"
        mutated = []
        for info, data in entries:
            if info.filename == target:
                info = zipfile.ZipInfo(target)
                info.create_system = 3
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
            mutated.append((info, data))
        self.assert_refused_without_writes(self.rewritten(filename, manifest, mutated))

    def test_archive_limits_are_enforced_before_writes(self) -> None:
        filename, _ = self.export()
        with mock.patch.object(archive, "MAX_BYTES", 1):
            self.assert_refused_without_writes(filename)
        with mock.patch.object(archive, "MAX_FILES", 1):
            self.assert_refused_without_writes(filename)

    def test_restore_creates_a_new_directory_instead_of_overwriting_existing_files(self) -> None:
        filename, _ = self.export()
        first = archive.restore_archive(filename, self.restored)
        first_root = Path(first["restoreRoot"])
        marker = first_root / "existing-marker.txt"
        marker.write_text("keep", encoding="utf-8")
        second = archive.restore_archive(filename, self.restored)
        self.assertNotEqual(first["restoreRoot"], second["restoreRoot"])
        self.assertEqual(marker.read_text(encoding="utf-8"), "keep")

    def test_export_destination_inside_a_source_is_refused_before_creating_a_temporary_archive(self) -> None:
        destination = self.local / "inside-source.zip"
        with self.assertRaises((ValueError, OSError)):
            archive.export_archive(self.profile, destination, inventory=self.inventory)
        self.assertFalse(destination.exists())
        self.assertEqual(list(self.root.rglob("*.partial")), [])
        self.assertEqual((self.local / "binary.dat").read_bytes(), bytes(range(256)))

    def test_failed_final_archive_copy_removes_only_the_new_destination(self) -> None:
        destination = self.output / "final-copy-fails.zip"
        original_copy = archive.shutil.copyfileobj
        source_bytes = (self.local / "binary.dat").read_bytes()

        def fail_only_final_copy(source, target, *args, **kwargs):
            if str(getattr(target, "name", "")) == str(destination):
                target.write(b"incomplete new archive")
                raise OSError("synthetic final destination write failure")
            return original_copy(source, target, *args, **kwargs)

        with mock.patch.object(archive.shutil, "copyfileobj", side_effect=fail_only_final_copy):
            with self.assertRaises(OSError):
                archive.export_archive(self.profile, destination, inventory=self.inventory)
        self.assertFalse(destination.exists(), "do not leave a corrupt file with the intended backup name")
        self.assertEqual(list(self.output.glob("*.partial")), [])
        self.assertEqual((self.local / "binary.dat").read_bytes(), source_bytes)


if __name__ == "__main__":
    unittest.main(verbosity=2)
