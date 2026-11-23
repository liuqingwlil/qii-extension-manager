"""Windows GUI / Native Messaging entry point for the Qii file migration helper."""

from __future__ import annotations

import io
import json
import os
import queue
import re
import shutil
import struct
import sys
import tempfile
import threading
import time
from qii_discovery import find_managers
from datetime import datetime
from pathlib import Path
from typing import Any

from qii_archive import (
    ID_RE,
    Profile,
    discover_profiles,
    export_archive,
    preview_sources,
    read_profile_inventory,
    restore_archive,
    select_profile,
)

VERSION = "1.1.0"
HOST_NAME = "com.qii.migration"
NATIVE_LIMIT = 1024 * 1024
ORIGIN_RE = re.compile(r"chrome-extension://[a-p]{32}/\Z")


class Cancelled(Exception):
    pass


def installation_directory() -> Path:
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        raise ValueError("未找到 Windows LOCALAPPDATA 目录")
    return Path(local) / "QiiMigration"


def read_message(stream) -> dict[str, Any]:
    header = bytearray()
    while len(header) < 4:
        chunk = stream.read(4 - len(header))
        if not chunk:
            break
        header.extend(chunk)
    if len(header) != 4:
        raise ValueError("原生消息缺少长度头")
    length = struct.unpack("<I", header)[0]
    if length < 2 or length > NATIVE_LIMIT:
        raise ValueError("原生消息大小无效")
    chunks = bytearray()
    while len(chunks) < length:
        chunk = stream.read(length - len(chunks))
        if not chunk:
            raise ValueError("原生消息未完整接收")
        chunks.extend(chunk)
    value = json.loads(chunks)
    if not isinstance(value, dict):
        raise ValueError("原生消息必须为对象")
    return value


def compact_response(value: dict[str, Any]) -> dict[str, Any]:
    """Do not hide completed file work if its detailed report exceeds native IPC limits."""
    result = dict(value)
    encode = lambda obj: json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(encode(result)) <= NATIVE_LIMIT:
        return result
    if isinstance(result.get("items"), list):
        result["totalItems"] = len(result["items"])
        result["items"] = result["items"][:100]
        result["detailsTruncated"] = True
        result["message"] = "完整逐项结果已保存在本地报告，界面仅显示前 100 项。"
    if len(encode(result)) > NATIVE_LIMIT and "managerBackup" in result:
        result.pop("managerBackup")
        result["managerBackupOnDisk"] = True
        result["message"] = "扩展文件已恢复；配置较大，请从恢复目录的 manager-backup.json 单独导入。完整结果见本地报告。"
    if len(encode(result)) > NATIVE_LIMIT:
        # Keep operation truth and output paths. Never replace an already completed file
        # operation with a generic 'failed' response merely because details are large.
        result = {key: result[key] for key in ("ok", "action", "complete", "installed", "directory", "archivePath", "reportPath", "guidePath", "managerBackupOnDisk", "message", "totalItems") if key in result}
        result["items"] = []
        result["detailsTruncated"] = True
    return result


def write_message(stream, value: dict[str, Any]) -> None:
    payload = json.dumps(compact_response(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(payload) > NATIVE_LIMIT:
        payload = b'{"ok":false,"error":"Native response exceeded size limit"}'
    stream.write(struct.pack("<I", len(payload)))
    stream.write(payload)
    stream.flush()


def default_roots() -> dict[str, Path]:
    base = Path(os.environ.get("LOCALAPPDATA", ""))
    if not str(base) or not os.environ.get("LOCALAPPDATA"):
        return {}
    return {
        "Chrome": base / "Google" / "Chrome" / "User Data",
        "Edge": base / "Microsoft" / "Edge" / "User Data",
    }


class Interface:
    def __init__(self, *, native: bool = False):
        import tkinter as tk
        from tkinter import filedialog, ttk
        from qii_ui import Theme

        if sys.platform == "win32":
            from ctypes import windll
            windll.user32.SetProcessDPIAware()
        self.tk, self.ttk = tk, ttk
        self.filedialog = filedialog
        self.root = tk.Tk()
        self.root.withdraw()
        self.root.title("栖 · 扩展文件迁移助手")
        self.ui = Theme(self.root)
        self.native = native

    def destroy(self):
        self.root.destroy()

    def _modal(self, title, size, minimum=None, *, parent=None, cancellable=True):
        owner = parent if parent is not None else self.root
        window = self.tk.Toplevel(self.root)
        window.withdraw()
        window.title(title)
        # A transient of a withdrawn root stays unmapped on Windows/Tk 9. Native
        # requests intentionally keep their root hidden, so their modal is unowned.
        if owner.winfo_viewable():
            window.transient(owner)
        self.ui.prepare_window(window, size, minimum, parent=owner)
        if cancellable:
            window.bind("<Escape>", lambda _event: window.destroy())
        else:
            window.protocol("WM_DELETE_WINDOW", lambda: None)
        return window

    def _wait(self, window, focus=None):
        previous_grab = self.root.grab_current()
        previous_focus = self.root.focus_get()
        window.deiconify()
        window.update_idletasks()
        window.grab_set()
        window.lift()
        (focus if focus is not None else window).focus_set()
        try:
            self.root.wait_window(window)
        finally:
            if previous_grab is not None and previous_grab.winfo_exists():
                previous_grab.grab_set()
            if previous_focus is not None and previous_focus.winfo_exists():
                previous_focus.focus_set()

    def _page(self, window, title, subtitle=None, *, icon=None):
        body = self.ui.frame(window, padding=(self.ui.px(32), self.ui.px(25)))
        body.pack(fill="both", expand=True)
        head = self.ui.frame(body)
        head.pack(fill="x")
        if icon is not None:
            self.ui.label(head, image=icon).pack(side="left", anchor="n", padx=(0, self.ui.px(14)))
        text = self.ui.frame(head)
        text.pack(side="left", fill="x", expand=True)
        self.ui.label(text, title, style="Title.TLabel", wrap=True).pack(fill="x")
        if subtitle:
            self.ui.label(text, subtitle, style="Hint.TLabel", wrap=True).pack(fill="x", pady=(self.ui.px(6), 0))
        return body

    def _actions(self, parent, *, primary=None, secondary=None, left=None):
        row = self.ui.frame(parent)
        row.pack(side="bottom", fill="x", pady=(self.ui.px(18), 0))
        if left is not None:
            self.ui.button(row, *left).pack(side="left")
        end = self.ui.frame(row)
        end.pack(side="right")
        if secondary is not None:
            self.ui.button(end, *secondary).pack(side="left", padx=(0, self.ui.px(8)) if primary else 0)
        if primary is not None:
            self.ui.button(end, *primary, kind="primary").pack(side="left")

    def _notice(self, title, message, *, parent=None, warning=False):
        window = self._modal(title, (545, 280 if warning else 240), parent=parent)
        body = self.ui.frame(window, padding=(self.ui.px(30), self.ui.px(22)))
        body.pack(fill="both", expand=True)
        if warning and self.ui.images.get("warning"):
            self.ui.label(body, image=self.ui.images["warning"]).pack(pady=(0, self.ui.px(10)))
        self.ui.label(body, title, style="Heading.TLabel", wrap=True, anchor="center", justify="center").pack(fill="x")
        button = self.ui.button(body, "返回" if warning else "完成", window.destroy, kind="secondary")
        button.pack(side="bottom", pady=(self.ui.px(12), 0))
        if len(message) > 220 or message.count("\n") > 4:
            panel = self.ui.frame(body, style="Card.TFrame")
            panel.pack(fill="both", expand=True, pady=(self.ui.px(10), 0))
            detail = self.tk.Text(panel, wrap="word", height=3, relief="flat", highlightthickness=0,
                                  takefocus=False, padx=self.ui.px(9), pady=self.ui.px(7),
                                  background="#FFFFFF", foreground="#253F34", font=self.ui.body)
            scrollbar = self.ttk.Scrollbar(panel, orient="vertical", command=detail.yview)
            detail.configure(yscrollcommand=scrollbar.set)
            detail.insert("1.0", message)
            detail.configure(state="disabled")
            scrollbar.pack(side="right", fill="y")
            detail.pack(side="left", fill="both", expand=True)
        else:
            self.ui.label(body, message, style="Hint.TLabel", wrap=True, anchor="center", justify="center").pack(
                fill="x", pady=(self.ui.px(10), 0))
        self._wait(window, button)

    def _copy_row(self, card, row, caption, value=None, *, variable=None):
        pad = self.ui.px(6)
        self.ui.label(card, caption, style="Card.TLabel").grid(
            row=row, column=0, sticky="w", padx=(self.ui.px(12), self.ui.px(10)), pady=pad)
        field = self.ui.copy_field(card, value or "", textvariable=variable)
        field.grid(row=row, column=1, sticky="ew", pady=pad)
        reset = []

        def cancel_reset():
            if reset:
                button.after_cancel(reset.pop())

        def restore_label(*_args):
            cancel_reset()
            button.configure(text="复制")

        def copy():
            if not field.get():
                return
            card.clipboard_clear()
            card.clipboard_append(field.get())
            cancel_reset()
            button.configure(text="已复制")
            reset.append(button.after(1500, restore_label))

        button = self.ui.button(card, "复制", copy, kind="quiet", width=7)
        button.grid(row=row, column=2, padx=(self.ui.px(8), self.ui.px(12)), pady=pad)
        card.columnconfigure(1, weight=1)
        trace = variable.trace_add("write", restore_label) if variable is not None else None

        def cleanup(_event):
            cancel_reset()
            if trace is not None:
                variable.trace_remove("write", trace)

        button.bind("<Destroy>", cleanup, add=True)
        return button

    def _details(self, parent, fields):
        card = self.ui.frame(parent, style="Card.TFrame", padding=(0, self.ui.px(4)))
        card.pack(fill="x", pady=(self.ui.px(16), 0))
        for index, (caption, value) in enumerate(fields):
            self._copy_row(card, index, caption, value)

    def _selected_path(self, parent, tree, caption):
        path = self.tk.StringVar(parent)
        card = self.ui.frame(parent, style="Card.TFrame")
        card.pack(side="bottom", fill="x", pady=(self.ui.px(10), 0))
        copy_button = self._copy_row(card, 0, caption, variable=path)

        def sync(_event=None):
            selected = tree.selection()
            path.set(tree.set(selected[0], "path") if selected else "")
            copy_button.state(["!disabled" if path.get() else "disabled"])

        tree.bind("<<TreeviewSelect>>", sync, add=True)
        sync()
        return sync

    def choose_profile(self, browser: str | None, inventory=None, manager_id=None) -> Profile:
        profiles = discover_profiles({key: value for key, value in default_roots().items() if browser not in ("Chrome", "Edge") or key == browser})
        if inventory is not None:
            try:
                return select_profile(profiles, inventory, manager_id)
            except ValueError:
                pass
        window = self._modal("选择浏览器资料", (865, 470), (660, 365))
        frame = self._page(window, "选择浏览器资料", "请选择要备份的 Chrome 或 Edge 资料。自定义资料可以手动定位。")
        table, tree = self.ui.table(frame, (
            ("browser", "浏览器", 105, 84), ("name", "资料", 168, 120), ("path", "目录", 550, 250),
        ), height=6)
        for index, profile in enumerate(profiles):
            tree.insert("", "end", iid=str(index), values=(profile.browser, profile.name, str(profile.path)))
        if profiles:
            tree.selection_set("0")
            tree.focus("0")
        empty = self.ui.label(frame, "未发现浏览器资料，请选择自定义资料目录。", style="Hint.TLabel", wrap=True)
        result = []

        def browse():
            chosen = self.filedialog.askdirectory(parent=window, title="选择包含 Preferences / Secure Preferences 的浏览器资料目录", mustexist=True)
            if not chosen:
                return
            path = Path(chosen)
            if not any((path / name).is_file() for name in ("Preferences", "Secure Preferences")):
                self._notice("目录不匹配", "请选择含有 Preferences 或 Secure Preferences 的具体资料目录。", parent=window, warning=True)
                return
            profile = Profile(browser or "Chrome", path.name, path)
            index = len(profiles)
            profiles.append(profile)
            tree.insert("", "end", iid=str(index), values=(profile.browser, profile.name, str(profile.path)))
            tree.selection_set(str(index))
            tree.focus(str(index))
            tree.see(str(index))
            empty.pack_forget()

        def accept():
            if not tree.selection():
                self._notice("请选择一项资料", "请选择表中的资料，或手动定位资料目录。", parent=window)
                return
            profile = profiles[int(tree.selection()[0])]
            try:
                read_profile_inventory(profile)
            except Exception as error:
                self._notice("资料无法读取", str(error), parent=window, warning=True)
                return
            result.append(profile)
            window.destroy()

        self._actions(frame, left=("选择自定义资料目录", browse), secondary=("取消", window.destroy),
                      primary=("使用所选资料", accept))
        self._selected_path(frame, tree, "资料目录")
        if not profiles:
            empty.pack(fill="x", pady=(self.ui.px(12), 0))
        table.pack(fill="both", expand=True, pady=(self.ui.px(16), 0))
        tree.bind("<Return>", lambda _event: accept())
        self._wait(window)
        if not result:
            raise Cancelled()
        return result[0]

    def review_sources(self, profile: Profile, inventory) -> dict[str, Path]:
        rows = preview_sources(profile, inventory)
        window = self._modal("核对扩展文件目录", (960, 575), (720, 430))
        frame = self._page(window, "核对扩展文件目录", f"{profile.browser} · {profile.name} · {len(rows)} 个扩展")
        self.ui.label(frame, "请核对要备份的代码目录。若发现源目录缺失，可选中该扩展并手动定位。",
                      style="Hint.TLabel", wrap=True).pack(fill="x", pady=(self.ui.px(6), 0))
        table, tree = self.ui.table(frame, (
            ("name", "扩展", 240, 150), ("status", "文件状态", 108, 92), ("path", "源目录或原因", 650, 320),
        ), height=8)
        for index, row in enumerate(rows):
            tree.insert("", "end", iid=str(index), values=(row["name"], "可读取" if row.get("path") else "未找到", row.get("path", row.get("problem", ""))))
        overrides: dict[str, Path] = {}
        accepted = []

        def locate():
            if not tree.selection():
                self._notice("请选择一项扩展", "在表格中选择需要手动定位的扩展。", parent=window)
                return
            index = int(tree.selection()[0])
            row = rows[index]
            chosen = self.filedialog.askdirectory(parent=window, title=f"为 {row['name']} 选择包含 manifest.json 的实际目录", mustexist=True)
            if not chosen:
                return
            if not (Path(chosen) / "manifest.json").is_file():
                self._notice("目录不匹配", "所选目录没有 manifest.json。", parent=window, warning=True)
                return
            if not self._confirm_source(window, row, chosen):
                return
            overrides[row["id"]] = Path(chosen)
            tree.item(str(index), values=(row["name"], "手动定位", chosen))
            sync_path()

        def accept():
            accepted.append(True)
            window.destroy()

        self._actions(frame, left=("定位选中项的目录", locate), secondary=("取消", window.destroy),
                      primary=("继续导出", accept))
        sync_path = self._selected_path(frame, tree, "选中项路径或原因")
        table.pack(fill="both", expand=True, pady=(self.ui.px(16), 0))
        self._wait(window)
        if not accepted:
            raise Cancelled()
        return overrides

    def _confirm_source(self, parent, row, path):
        window = self._modal("确认目录对应关系", (680, 362), (580, 332), parent=parent)
        body = self._page(window, "确认目录对应关系", "确认将此目录作为下面这个扩展 ID 的文件来源。")
        self._details(body, (("扩展名称", row["name"]), ("扩展 ID", row["id"]), ("源目录", path)))
        confirmed = False

        def accept():
            nonlocal confirmed
            confirmed = True
            window.destroy()

        self._actions(body, secondary=("返回", window.destroy), primary=("使用此目录", accept))
        self._wait(window)
        return confirmed

    def run_file_task(self, label: str, callback):
        window = self._modal(label, (630, 218), (500, 200), cancellable=False)
        frame = self._page(window, label, "正在读写并校验文件，请等待处理完成。")
        bar = self.ttk.Progressbar(frame, mode="indeterminate")
        bar.pack(fill="x", pady=(self.ui.px(28), 0))
        self.ui.label(frame, "处理在本机进行。", style="Small.TLabel").pack(anchor="w", pady=(self.ui.px(10), 0))
        bar.start(20)
        results: queue.Queue = queue.Queue()

        def work():
            try:
                results.put((True, callback()))
            except Exception as error:
                results.put((False, error))

        threading.Thread(target=work, daemon=True).start()
        response = []

        def poll():
            try:
                response.append(results.get_nowait())
            except queue.Empty:
                window.after(80, poll)
            else:
                window.destroy()

        window.after(80, poll)
        self._wait(window)
        if not response:
            raise RuntimeError("文件处理未返回结果")
        success, result = response[0]
        if not success:
            raise result
        return result

    def export(self, request: dict[str, Any]):
        backup = request.get("backup")
        inventory = backup.get("inventory") if isinstance(backup, dict) else None
        browser = request.get("browser")
        if browser not in (None, "Chrome", "Edge"):
            raise ValueError("浏览器类型无效")
        manager_id = request.get("managerId")
        if manager_id is not None and (not isinstance(manager_id, str) or not ID_RE.fullmatch(manager_id)):
            raise ValueError("管理器 ID 无效")
        profile = self.choose_profile(browser, inventory, manager_id)
        inventory = inventory if inventory is not None else read_profile_inventory(profile)
        overrides = self.review_sources(profile, inventory)
        selected = self.filedialog.asksaveasfilename(parent=self.root, title="保存包含扩展实际文件的 ZIP", defaultextension=".zip", filetypes=[("扩展文件迁移包", "*.zip")], initialfile=f"qii-extensions-{datetime.now():%Y%m%d-%H%M%S}.zip")
        if not selected:
            raise Cancelled()
        return self.run_file_task("正在导出扩展文件", lambda: export_archive(profile, Path(selected), inventory, backup, source_overrides=overrides))

    def restore(self):
        selected = self.filedialog.askopenfilename(parent=self.root, title="选择栖扩展文件迁移 ZIP", filetypes=[("扩展文件迁移包", "*.zip")])
        if not selected:
            raise Cancelled()
        parent = self.filedialog.askdirectory(parent=self.root, title="选择恢复保存目录（将在下面创建新的独立目录）", mustexist=True)
        if not parent:
            raise Cancelled()
        return self.run_file_task("正在恢复并校验扩展文件", lambda: restore_archive(Path(selected), Path(parent)))

    def show_result(self, result):
        complete = result["complete"]
        guide = result.get("guidePath")
        note = None
        if result["action"] == "export":
            title = "扩展文件已完整备份" if complete else "备份已生成，部分文件未完整保存"
            summary = f"{len(result['items'])} 项扩展 · {result.get('fileCount', 0)} 个代码文件"
            paths = [("备份文件", result["archivePath"])]
            if not result.get("managerConfigIncluded"):
                note = "管理器配置可在扩展管理器内一并导出。"
        else:
            title = "扩展文件已恢复" if complete else "扩展文件已部分恢复"
            summary = "请按安装清单在浏览器中完成安装。" if complete else "请查看迁移报告，并按安装清单完成浏览器安装。"
            paths = [("恢复目录", result["directory"])]
            note = "本地扩展迁移到新目录后，扩展 ID 可能变化。"
        if result.get("reportPath"):
            paths.append(("迁移报告", result["reportPath"]))
        window = self._modal(title, (695, 364), (590, 326))
        image = self.ui.images.get("success" if complete else "warning")
        body = self._page(window, title, summary, icon=image)
        self._details(body, paths)
        if note:
            self.ui.label(body, note, style="Hint.TLabel", wrap=True).pack(fill="x", pady=(self.ui.px(10), 0))

        def open_guide():
            try:
                os.startfile(guide)
            except OSError as error:
                self._notice("无法打开安装清单", str(error), parent=window, warning=True)

        self._actions(body, primary=("完成", window.destroy),
                      secondary=("打开安装清单", open_guide) if guide else None)
        self._wait(window)

    def _ask_identifier(self):
        window = self._modal("连接管理器", (632, 298), (522, 270))
        body = self._page(window, "连接管理器", "粘贴扩展管理器页面显示的扩展 ID，以建立本地连接。")
        self.ui.label(body, "扩展 ID").pack(anchor="w", pady=(self.ui.px(14), self.ui.px(5)))
        typed_id = self.tk.StringVar(window)
        entry = self.ui.entry(body, textvariable=typed_id)
        entry.pack(fill="x")
        help_text = "扩展 ID 由 a–p 组成，共 32 位。"
        feedback = self.tk.StringVar(window, value=help_text)
        guidance = self.ui.label(body, textvariable=feedback, style="Hint.TLabel", wrap=True)
        guidance.pack(fill="x", pady=(self.ui.px(6), 0))
        result = []

        def clear_error(*_args):
            if guidance.cget("style") == "Error.TLabel":
                feedback.set(help_text)
                guidance.configure(style="Hint.TLabel")

        typed_id.trace_add("write", clear_error)

        def accept():
            identifier = entry.get().strip()
            if not ID_RE.fullmatch(identifier):
                feedback.set("请检查输入。扩展 ID 由 a–p 组成，共 32 位。")
                guidance.configure(style="Error.TLabel")
                entry.focus_set()
                return
            result.append(identifier)
            window.destroy()

        entry.bind("<Return>", lambda _event: accept())
        self._actions(body, secondary=("取消", window.destroy), primary=("保存连接", accept))
        self._wait(window, entry)
        return result[0] if result else None

    def register(self):
        if os.name != "nt" or not getattr(sys, "frozen", False):
            self._notice("请使用 Windows 版助手", "连接管理器需要运行打包后的 QiiMigration.exe。", warning=True)
            return
        identifier = self._ask_identifier()
        if identifier is None:
            return
        try:
            path = register_host(identifier)
        except Exception as error:
            self._notice("连接未完成", str(error), warning=True)
            return
        self.connection_status.set("配置已保存 · 等待浏览器授权或检测")
        window = self._modal("连接配置已保存", (662, 296), (558, 266))
        body = self._page(window, "连接配置已保存", "返回扩展管理器完成连接检测。首次使用时，请在浏览器中允许本地通信权限。",
                          icon=self.ui.images.get("success"))
        self._details(body, (("助手位置", str(path)),))
        self._actions(body, primary=("完成", window.destroy))
        self._wait(window)

    def _choose_manager(self, candidates):
        window = self._modal("选择扩展管理器", (825, 420), (650, 320))
        body = self._page(window, "选择扩展管理器", "发现了多个管理器，请选择要连接的浏览器资料。")
        table, tree = self.ui.table(body, (
            ("browser", "浏览器", 118, 88), ("profile", "浏览器资料", 182, 130), ("id", "扩展 ID", 390, 310),
        ), height=5)
        for index, candidate in enumerate(candidates):
            tree.insert("", "end", iid=str(index), values=(candidate["browser"], candidate["profile"], candidate["id"]))
        tree.selection_set("0")
        tree.focus("0")
        result = []

        def accept():
            selection = tree.selection()
            if selection:
                result.append(candidates[int(selection[0])])
                window.destroy()

        tree.bind("<Return>", lambda _event: accept())
        self._actions(body, secondary=("取消", window.destroy), primary=("连接所选管理器", accept))
        table.pack(fill="both", expand=True, pady=(self.ui.px(16), 0))
        self._wait(window)
        return result[0] if result else None

    def automatic_connection(self, interactive=False):
        try:
            candidates = find_managers(default_roots())
            if not candidates:
                self.connection_status.set('未识别到管理器 · 请先重新加载最新版扩展，可使用手动 ID 连接')
                return
            if len(candidates) > 1:
                if not interactive:
                    self.connection_status.set(f'发现 {len(candidates)} 个管理器 · 点击“自动连接管理器”选择')
                    return
                candidate = self._choose_manager(candidates)
                if candidate is None:
                    return
            else:
                candidate = candidates[0]
            register_host(candidate['id'])
            self.connection_status.set(f"已自动配置 · {candidate['browser']} · 等待浏览器授权/检测")
        except Exception as error:
            self.connection_status.set(f'自动连接未完成 · {error}')

    def refresh_connection_status(self):
        try:
            state = json.loads((installation_directory() / 'connection-state.json').read_text(encoding='utf-8'))
            if time.time() - float(state['at']) < 70:
                self.connection_status.set(f"已连接 · 浏览器握手成功 · {state['origin'].split('/')[2]}")
            elif self.connection_status.get().startswith('已连接'):
                self.connection_status.set('已配置 · 等待浏览器页面重新检测')
        except (OSError, ValueError, KeyError, TypeError):
            pass
        self.root.after(3000, self.refresh_connection_status)

    def standalone(self):
        def action(callback):
            try:
                self.show_result(callback())
            except Cancelled:
                pass
            except Exception as error:
                self._notice("操作未完成", str(error), warning=True)

        self.connection_status = self.tk.StringVar(self.root, value="正在自动识别管理器…")
        self.ui.prepare_window(self.root, (808, 482), (690, 450))
        self.ui.home(self, VERSION, lambda: action(lambda: self.export({})), lambda: action(self.restore))
        self.root.deiconify()
        self.root.after(150, self.automatic_connection)
        self.root.after(3000, self.refresh_connection_status)
        self.root.mainloop()


def register_host(identifier: str) -> Path:
    if os.name != "nt" or not getattr(sys, "frozen", False) or not ID_RE.fullmatch(identifier):
        raise ValueError("注册仅适用于 Windows 打包程序和有效的管理器 ID")
    import winreg

    directory = installation_directory()
    directory.mkdir(parents=True, exist_ok=True)
    # Reject reparse points; do not install into a redirected path selected by another app.
    from qii_archive import _assert_real_path
    _assert_real_path(directory)
    target = directory / "QiiMigration.exe"
    source = Path(sys.executable)
    if source.resolve() != target.resolve():
        temporary = directory / "QiiMigration.update.exe"
        if temporary.exists():
            raise FileExistsError("发现未完成的助手更新，请关闭助手后移除 QiiMigration.update.exe 再重试")
        shutil.copyfile(source, temporary)
        os.replace(temporary, target)
    manifest_path = directory / "native-host.json"
    origins = []
    if manifest_path.is_file() and manifest_path.stat().st_size <= 128 * 1024:
        try:
            previous = json.loads(manifest_path.read_text(encoding="utf-8"))
            origins = [value for value in previous.get("allowed_origins", []) if isinstance(value, str) and ORIGIN_RE.fullmatch(value)]
        except (OSError, ValueError, AttributeError, TypeError):
            pass
    origins = sorted(set(origins + [f"chrome-extension://{identifier}/"]))
    if len(origins) > 100:
        raise ValueError("已连接的管理器 ID 过多，请先清理本地连接清单")
    manifest = {"name": HOST_NAME, "description": "Qii local extension-file migration helper", "path": str(target), "type": "stdio", "allowed_origins": origins}
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    for vendor in (r"Software\Google\Chrome\NativeMessagingHosts", r"Software\Microsoft\Edge\NativeMessagingHosts"):
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, vendor + "\\" + HOST_NAME) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest_path))
    return target


def origin_allowed(origin: str) -> bool:
    if not ORIGIN_RE.fullmatch(origin):
        return False
    try:
        path = installation_directory() / "native-host.json"
        from qii_archive import _assert_real_path
        _assert_real_path(path)
        if path.stat().st_size > 128 * 1024:
            return False
        value = json.loads(path.read_text(encoding="utf-8"))
        origins = value.get("allowed_origins")
        return (
            value.get("name") == HOST_NAME
            and isinstance(origins, list)
            and all(isinstance(item, str) and ORIGIN_RE.fullmatch(item) for item in origins)
            and origin in origins
        )
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def native_main(origin: str) -> int:
    interface = None
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    try:
        if not origin_allowed(origin):
            raise ValueError("此管理器 ID 尚未连接本地助手，请先在助手中明确连接")
        request = read_message(sys.stdin.buffer)
        action = request.get("action")
        if action == "ping":
            try:
                (installation_directory() / 'connection-state.json').write_text(json.dumps({'origin':origin,'at':time.time(),'version':VERSION}), encoding='utf-8')
            except OSError:
                pass
            result = {"ok": True, "version": VERSION, "capabilities": ["export", "import"]}
        elif action in ("export", "import"):
            if action == "export" and request.get("managerId") != origin.split("/")[2]:
                raise ValueError("导出请求的管理器 ID 与已连接的调用方不一致")
            interface = Interface(native=True)
            result = interface.export(request) if action == "export" else interface.restore()
        else:
            raise ValueError("不支持的本地迁移操作")
    except Cancelled:
        result = {"ok": False, "cancelled": True, "error": "已取消"}
    except Exception as error:
        result = {"ok": False, "error": str(error)[:4000]}
    finally:
        if interface is not None:
            interface.destroy()
    try:
        write_message(sys.stdout.buffer, result)
    except (BrokenPipeError, OSError):
        # The browser may close its view. Completed operations already have local reports.
        return 1
    return 0


def self_test() -> dict[str, Any]:
    """Packaged-runtime smoke test; no real profiles, registry or visible windows."""
    interface = Interface()
    try:
        interface.root.update_idletasks()
        tcl_version = interface.root.tk.call("info", "patchlevel")
        assert set(interface.ui.images) == {"icon", "folder", "export", "import", "warning", "success"}
    finally:
        interface.destroy()
    stream = io.BytesIO()
    write_message(stream, {"ok": True, "version": VERSION})
    stream.seek(0)
    assert read_message(stream)["version"] == VERSION
    with tempfile.TemporaryDirectory(prefix="qii-helper-self-test-") as directory:
        root = Path(directory)
        profile_path = root / "Default"
        source = profile_path / "Extensions" / ("a" * 32) / "1.0_0"
        source.mkdir(parents=True)
        manifest = {"manifest_version": 3, "name": "Qii synthetic self-test", "version": "1.0"}
        (source / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        (source / "content.js").write_bytes(b"console.log('self-test');")
        prefs = {"extensions": {"settings": {"a" * 32: {"location": 1, "state": 1, "path": str(source), "manifest": manifest}}}}
        (profile_path / "Preferences").write_text(json.dumps(prefs), encoding="utf-8")
        export = export_archive(Profile("Chrome", "synthetic", profile_path), root / "test.zip")
        restored = restore_archive(root / "test.zip", root)
        assert export["complete"] and restored["complete"] and restored["installed"] is False
        assert (Path(restored["directory"]) / "extensions" / ("a" * 32) / "content.js").read_bytes() == b"console.log('self-test');"
    return {"ok": True, "version": VERSION, "tkVersion": str(tcl_version), "uiAssetsLoaded": True, "archiveRoundTrip": True, "nativeFraming": True, "realProfilesRead": False, "registryModified": False}


def main() -> int:
    if "--version" in sys.argv[1:]:
        print(VERSION)
        return 0
    if "--self-test" in sys.argv[1:]:
        print(json.dumps(self_test(), ensure_ascii=False))
        return 0
    origins = [value for value in sys.argv[1:] if value.startswith("chrome-extension:")]
    if origins:
        return native_main(origins[0])
    interface = Interface()
    try:
        interface.standalone()
    finally:
        try:
            interface.destroy()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
