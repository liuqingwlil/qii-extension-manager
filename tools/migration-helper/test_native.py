"""Native Messaging protocol tests without GUI, real profiles, or registry access."""

from __future__ import annotations

import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest import mock

import qii_migration as native


ORIGIN = "chrome-extension://" + "a" * 32 + "/"
OTHER_ORIGIN = "chrome-extension://" + "b" * 32 + "/"


def encoded(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def frame(value) -> bytes:
    payload = encoded(value)
    return struct.pack("<I", len(payload)) + payload


class ShortReadStream(io.BytesIO):
    def read(self, size=-1):
        return super().read(min(size, 2) if size >= 0 else 2)


class ShortBodyStream(io.BytesIO):
    def read(self, size=-1):
        if self.tell() == 0:
            return super().read(size)
        return super().read(min(size, 2) if size >= 0 else 2)


class FlushTrackingStream(io.BytesIO):
    def __init__(self):
        super().__init__()
        self.flush_count = 0

    def flush(self):
        self.flush_count += 1
        return super().flush()


class NativeMessagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="qii-native-test-")
        self.addCleanup(self.temporary.cleanup)
        self.install_directory = Path(self.temporary.name)
        self.manifest_path = self.install_directory / "native-host.json"
        self.directory_patch = mock.patch.object(native, "installation_directory", return_value=self.install_directory)
        self.directory_patch.start()
        self.addCleanup(self.directory_patch.stop)

    def manifest(self, **patches):
        value = {"name": native.HOST_NAME, "allowed_origins": [ORIGIN]}
        value.update(patches)
        self.manifest_path.write_text(json.dumps(value), encoding="utf-8")

    def test_read_message_uses_utf8_byte_length_and_exact_little_endian_header(self):
        value = {"action": "export", "name": "爱莉希雅 · 扩展备份"}
        raw = frame(value)
        self.assertEqual(struct.unpack("<I", raw[:4])[0], len(raw[4:]))
        self.assertGreater(len(raw[4:]), len(raw[4:].decode("utf-8")))
        self.assertEqual(native.read_message(io.BytesIO(raw)), value)

    def test_read_message_does_not_consume_the_next_frame(self):
        stream = io.BytesIO(frame({"action": "ping"}) + frame({"action": "import"}))
        self.assertEqual(native.read_message(stream), {"action": "ping"})
        self.assertEqual(native.read_message(stream), {"action": "import"})
        self.assertEqual(stream.read(), b"")

    def test_partial_header_and_body_reads_are_reassembled(self):
        value = {"action": "ping", "name": "测试"}
        self.assertEqual(native.read_message(ShortReadStream(frame(value))), value)

    def test_partial_body_reads_are_reassembled(self):
        value = {"action": "import", "name": "本地扩展"}
        self.assertEqual(native.read_message(ShortBodyStream(frame(value))), value)

    def test_missing_header_and_truncated_body_are_rejected(self):
        for raw in [b"", b"\x01", b"\x02\x00\x00", struct.pack("<I", 12) + b"{}"]:
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    native.read_message(io.BytesIO(raw))

    def test_zero_too_small_and_oversize_lengths_are_rejected(self):
        for length in [0, 1, native.NATIVE_LIMIT + 1, 0xFFFFFFFF]:
            with self.subTest(length=length):
                with self.assertRaises(ValueError):
                    native.read_message(io.BytesIO(struct.pack("<I", length)))

    def test_invalid_json_and_non_object_messages_are_rejected(self):
        for payload in [b"not json", b"{]", b"[]", b"null", b'"text"', b"123", b'{"name":"\xff"}']:
            with self.subTest(payload=payload):
                with self.assertRaises((ValueError, UnicodeDecodeError)):
                    native.read_message(io.BytesIO(struct.pack("<I", len(payload)) + payload))

    def test_write_message_has_exact_header_bytes_payload_and_flush(self):
        value = {"ok": True, "action": "export", "message": "文件已备份"}
        stream = FlushTrackingStream()
        native.write_message(stream, value)
        raw = stream.getvalue()
        self.assertEqual(raw[:4], struct.pack("<I", len(raw) - 4))
        self.assertEqual(json.loads(raw[4:]), value)
        self.assertEqual(stream.flush_count, 1)
        self.assertLessEqual(len(raw) - 4, native.NATIVE_LIMIT)

    def test_small_response_is_not_changed(self):
        value = {"ok": True, "action": "export", "complete": False, "items": [{"status": "missing"}]}
        self.assertEqual(native.compact_response(value), value)

    def test_large_item_details_keep_success_truth_and_local_report_paths(self):
        value = {
            "ok": True, "action": "import", "complete": True, "installed": False,
            "directory": "D:\\Qii-Restore-Test", "reportPath": "D:\\Qii-Restore-Test\\restore-report.json",
            "guidePath": "D:\\Qii-Restore-Test\\安装清单.html",
            "items": [{"id": str(index), "name": "扩" * 4000} for index in range(150)],
        }
        self.assertGreater(len(encoded(value)), native.NATIVE_LIMIT)
        result = native.compact_response(value)
        for key in ["ok", "action", "complete", "installed", "directory", "reportPath", "guidePath"]:
            self.assertEqual(result[key], value[key])
        self.assertTrue(result["detailsTruncated"])
        self.assertLessEqual(len(encoded(result)), native.NATIVE_LIMIT)
        self.assertEqual(len(value["items"]), 150, "compaction must not mutate the stored detailed report")

    def test_large_manager_config_is_reported_on_disk_instead_of_falsely_failing_restore(self):
        value = {
            "ok": True, "action": "import", "complete": True, "installed": False,
            "directory": "D:\\Qii-Restore-Test", "reportPath": "D:\\Qii-Restore-Test\\restore-report.json",
            "guidePath": "D:\\Qii-Restore-Test\\安装清单.html", "items": [],
            "managerBackup": {"data": "配置" * native.NATIVE_LIMIT},
        }
        result = native.compact_response(value)
        self.assertTrue(result["ok"])
        self.assertTrue(result["complete"])
        self.assertIs(result["installed"], False)
        self.assertTrue(result["managerBackupOnDisk"])
        self.assertNotIn("managerBackup", result)
        self.assertIn("manager-backup.json", result["message"])
        for key in ["action", "directory", "reportPath", "guidePath"]:
            self.assertEqual(result[key], value[key])
        self.assertLessEqual(len(encoded(result)), native.NATIVE_LIMIT)
        stream = io.BytesIO()
        native.write_message(stream, value)
        self.assertEqual(native.read_message(io.BytesIO(stream.getvalue())), result)

    def test_final_compaction_keeps_operation_truth_when_unexpected_details_are_huge(self):
        value = {
            "ok": True, "action": "import", "complete": False, "installed": False,
            "directory": "D:\\Qii-Restore-Test", "reportPath": "D:\\Qii-Restore-Test\\restore-report.json",
            "guidePath": "D:\\Qii-Restore-Test\\安装清单.html", "items": [],
            "diagnostic": "x" * (native.NATIVE_LIMIT * 2),
        }
        result = native.compact_response(value)
        for key in ["ok", "action", "complete", "installed", "directory", "reportPath", "guidePath"]:
            self.assertEqual(result[key], value[key])
        self.assertTrue(result["detailsTruncated"])
        self.assertLessEqual(len(encoded(result)), native.NATIVE_LIMIT)

    def test_origin_requires_exact_configured_extension_identity(self):
        self.manifest()
        self.assertTrue(native.origin_allowed(ORIGIN))
        self.assertFalse(native.origin_allowed(OTHER_ORIGIN))
        for origin in [ORIGIN.rstrip("/"), ORIGIN + "popup.html", ORIGIN + "?x=1",
                       ORIGIN.replace("chrome-extension:", "https:"),
                       "chrome-extension://" + "q" * 32 + "/", "chrome-extension://*/",
                       "chrome-extension://" + "a" * 31 + "/",
                       "chrome-extension://" + "a" * 32 + ".example/",
                       "chrome-extension://user@" + "a" * 32 + "/"]:
            with self.subTest(origin=origin):
                self.assertFalse(native.origin_allowed(origin))

    def test_origin_rejects_missing_corrupt_wrong_host_and_oversize_configuration(self):
        self.assertFalse(native.origin_allowed(ORIGIN))
        self.manifest(name="com.some_other.host")
        self.assertFalse(native.origin_allowed(ORIGIN))
        self.manifest(allowed_origins=[OTHER_ORIGIN])
        self.assertFalse(native.origin_allowed(ORIGIN))
        self.manifest_path.write_text("not json", encoding="utf-8")
        self.assertFalse(native.origin_allowed(ORIGIN))
        self.manifest_path.write_text("x" * (128 * 1024 + 1), encoding="utf-8")
        self.assertFalse(native.origin_allowed(ORIGIN))

    def test_origin_rejects_non_list_allowlist_configuration(self):
        for value in [ORIGIN, {ORIGIN: True}, None, 42]:
            with self.subTest(value=value):
                self.manifest(allowed_origins=value)
                self.assertFalse(native.origin_allowed(ORIGIN))


if __name__ == "__main__":
    unittest.main(verbosity=2)
