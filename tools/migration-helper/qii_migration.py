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
        from tkinter import filedialog, messagebox, simpledialog, ttk

        self.tk, self.ttk = tk, ttk
        self.filedialog, self.messagebox, self.simpledialog = filedialog, messagebox, simpledialog
        self.root = tk.Tk()
        self.root.title("栖 · 扩展文件迁移助手")
        self.root.configure(background="#f7f8f4")
        self.root.geometry("720x510")
        self.root.minsize(640, 460)
        style = ttk.Style(self.root)
        style.theme_use("clam")
        style.configure("TFrame", background="#f7f8f4")
        style.configure("TLabel", background="#f7f8f4", foreground="#2d3c31", font=("Microsoft YaHei UI", 10))
        style.configure("Title.TLabel", font=("Microsoft YaHei UI", 20, "bold"))
        style.configure("Hint.TLabel", foreground="#647168", font=("Microsoft YaHei UI", 9))
        style.configure("TButton", padding=(12, 8), font=("Microsoft YaHei UI", 10))
        style.map("TButton", background=[("active", "#e7ede3")])
        style.configure("Treeview", font=("Microsoft YaHei UI", 9), rowheight=30, background="#fff", foreground="#2d3c31", fieldbackground="#fff")
        style.map("Treeview", background=[("selected", "#e7ede3")], foreground=[("selected", "#2d3c31")])
        self.root.withdraw()
        self.native = native

    def destroy(self):
        self.root.destroy()

    def _modal(self, title: str, size: str = "840x500"):
        window = self.tk.Toplevel(self.root)
        window.title(title)
        window.configure(background="#f7f8f4")
        window.geometry(size)
        window.minsize(650, 360)
        # A transient of a withdrawn root stays unmapped on Windows/Tk 9. Native
        # requests intentionally keep their root hidden, so their modal is unowned.
        if self.root.winfo_viewable():
            window.transient(self.root)
        window.grab_set()
        window.lift()
        return window

    def choose_profile(self, browser: str | None, inventory=None, manager_id=None) -> Profile:
        profiles = discover_profiles({key: value for key, value in default_roots().items() if browser not in ("Chrome", "Edge") or key == browser})
        if inventory is not None:
            try:
                return select_profile(profiles, inventory, manager_id)
            except ValueError:
                pass
        window = self._modal("选择要备份的浏览器资料", "850x450")
        frame = self.ttk.Frame(window, padding=20)
        frame.pack(fill="both", expand=True)
        self.ttk.Label(frame, text="请选择当前管理器对应的浏览器资料", font=("Microsoft YaHei UI", 14, "bold")).pack(anchor="w")
        self.ttk.Label(frame, text="同名扩展不会跨资料合并。自定义资料可手动选择包含 Preferences 的目录。", style="Hint.TLabel").pack(anchor="w", pady=(6, 12))
        tree = self.ttk.Treeview(frame, columns=("browser", "name", "path"), show="headings", height=7, selectmode="browse")
        for column, label, width in (("browser", "浏览器", 75), ("name", "资料", 130), ("path", "目录", 530)):
            tree.heading(column, text=label)
            tree.column(column, width=width, minwidth=60)
        tree.pack(fill="both", expand=True)
        for index, profile in enumerate(profiles):
            tree.insert("", "end", iid=str(index), values=(profile.browser, profile.name, str(profile.path)))
        if profiles:
            tree.selection_set("0")
        result = []
        buttons = self.ttk.Frame(frame)
        buttons.pack(fill="x", pady=(16, 0))

        def browse():
            chosen = self.filedialog.askdirectory(parent=window, title="选择包含 Preferences / Secure Preferences 的浏览器资料目录", mustexist=True)
            if not chosen:
                return
            path = Path(chosen)
            if not any((path / name).is_file() for name in ("Preferences", "Secure Preferences")):
                self.messagebox.showerror("目录不匹配", "请选择具体的 Default / Profile 目录，而不是 User Data 总目录。", parent=window)
                return
            profile = Profile(browser or "Chrome", path.name, path)
            index = len(profiles)
            profiles.append(profile)
            tree.insert("", "end", iid=str(index), values=(profile.browser, profile.name, str(profile.path)))
            tree.selection_set(str(index))
            tree.see(str(index))

        def accept():
            if not tree.selection():
                self.messagebox.showinfo("选择资料", "请先选择一项资料，或手动定位目录。", parent=window)
                return
            profile = profiles[int(tree.selection()[0])]
            try:
                read_profile_inventory(profile)
            except Exception as error:
                self.messagebox.showerror("资料无法读取", str(error), parent=window)
                return
            result.append(profile)
            window.destroy()

        self.ttk.Button(buttons, text="选择自定义资料目录", command=browse).pack(side="left")
        self.ttk.Button(buttons, text="使用所选资料", command=accept).pack(side="right")
        self.ttk.Button(buttons, text="取消", command=window.destroy).pack(side="right", padx=8)
        self.root.wait_window(window)
        if not result:
            raise Cancelled()
        return result[0]

    def review_sources(self, profile: Profile, inventory) -> dict[str, Path]:
        rows = preview_sources(profile, inventory)
        window = self._modal("核对扩展文件目录", "900x520")
        frame = self.ttk.Frame(window, padding=20)
        frame.pack(fill="both", expand=True)
        self.ttk.Label(frame, text=f"{profile.browser} · {profile.name} · {len(rows)} 个扩展", font=("Microsoft YaHei UI", 14, "bold")).pack(anchor="w")
        self.ttk.Label(frame, text="备份实际代码目录和管理器配置，不复制密码、Cookie 或浏览器整份资料。缺失的本地扩展可在下面明确定位。", wraplength=840, style="Hint.TLabel").pack(anchor="w", pady=(6, 12))
        tree = self.ttk.Treeview(frame, columns=("name", "status", "path"), show="headings", selectmode="browse")
        for column, title, width in (("name", "扩展", 220), ("status", "文件状态", 90), ("path", "源目录或原因", 510)):
            tree.heading(column, text=title)
            tree.column(column, width=width, minwidth=60)
        tree.pack(fill="both", expand=True)
        for index, row in enumerate(rows):
            tree.insert("", "end", iid=str(index), values=(row["name"], "可读取" if row.get("path") else "未找到", row.get("path", row.get("problem", ""))))
        overrides: dict[str, Path] = {}
        accepted = []
        buttons = self.ttk.Frame(frame)
        buttons.pack(fill="x", pady=(16, 0))

        def locate():
            if not tree.selection():
                self.messagebox.showinfo("选择扩展", "请先选择需要手动定位的一项扩展。", parent=window)
                return
            index = int(tree.selection()[0])
            row = rows[index]
            chosen = self.filedialog.askdirectory(parent=window, title=f"为 {row['name']} 选择包含 manifest.json 的实际目录", mustexist=True)
            if not chosen:
                return
            if not (Path(chosen) / "manifest.json").is_file():
                self.messagebox.showerror("目录不匹配", "所选目录没有 manifest.json。", parent=window)
                return
            if not self.messagebox.askyesno("确认目录对应关系", f"明确将下面的目录作为此 ID 的文件来源？\n\n{row['name']}\n{row['id']}\n\n{chosen}\n\n助手不会仅凭名称猜测对应关系。", parent=window):
                return
            overrides[row["id"]] = Path(chosen)
            tree.item(str(index), values=(row["name"], "手动定位", chosen))

        def accept():
            accepted.append(True)
            window.destroy()

        self.ttk.Button(buttons, text="定位选中项的目录", command=locate).pack(side="left")
        self.ttk.Button(buttons, text="继续导出", command=accept).pack(side="right")
        self.ttk.Button(buttons, text="取消", command=window.destroy).pack(side="right", padx=8)
        self.root.wait_window(window)
        if not accepted:
            raise Cancelled()
        return overrides

    def run_file_task(self, label: str, callback):
        window = self._modal(label, "660x210")
        window.minsize(560, 190)
        window.protocol("WM_DELETE_WINDOW", lambda: None)
        frame = self.ttk.Frame(window, padding=24)
        frame.pack(fill="both", expand=True)
        self.ttk.Label(frame, text=label, font=("Microsoft YaHei UI", 14, "bold")).pack(anchor="w")
        self.ttk.Label(frame, text="正在读写并校验文件，请等待完成。不会修改浏览器资料或安装扩展。", style="Hint.TLabel").pack(anchor="w", pady=12)
        bar = self.ttk.Progressbar(frame, mode="indeterminate")
        bar.pack(fill="x")
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
        self.root.wait_window(window)
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
        if result["action"] == "export":
            title = "扩展文件已完整备份" if result["complete"] else "备份已生成，部分文件未完整保存"
            content = f"{result['archivePath']}\n\n{len(result['items'])} 项扩展，{result.get('fileCount', 0)} 个代码文件。"
            if not result.get("managerConfigIncluded"):
                content += "\n本次独立导出未收到管理器配置；从管理器内导出可同时保存配置。"
        else:
            title = "文件已恢复，等待浏览器安装确认" if result["complete"] else "文件部分恢复，请查看报告"
            content = f"{result['directory']}\n\n浏览器扩展尚未自动安装。打开恢复目录中的“安装扩展清单.html”，按浏览器要求完成安装。\n本地扩展换目录后 ID 可能变化。"
        if result.get("reportPath"):
            content += f"\n\n完整逐项报告：{result['reportPath']}"
        self.messagebox.showinfo(title, content, parent=self.root)
        if result.get("guidePath") and self.messagebox.askyesno("查看安装清单", "是否打开刚生成的本地安装清单？", parent=self.root):
            os.startfile(result["guidePath"])

    def register(self):
        if os.name != "nt" or not getattr(sys, "frozen", False):
            self.messagebox.showerror("需要 Windows 安装包", "请使用打包后的 QiiMigration.exe 连接管理器；源码运行不会注册原生消息主机。", parent=self.root)
            return
        identifier = self.simpledialog.askstring("连接管理器", "粘贴管理器页面显示的 32 位扩展 ID：", parent=self.root)
        if identifier is None:
            return
        identifier = identifier.strip()
        if not ID_RE.fullmatch(identifier):
            self.messagebox.showerror("ID 无效", "扩展 ID 应是由 a–p 组成的 32 位字符串。", parent=self.root)
            return
        try:
            path = register_host(identifier)
        except Exception as error:
            self.messagebox.showerror("连接未完成", str(error), parent=self.root)
            return
        if hasattr(self, 'connection_status'):
            self.connection_status.set('配置已保存 · 等待浏览器授权/自动检测')
        self.messagebox.showinfo("连接配置已保存", f"本地助手已安装到：\n{path}\n\n网页会自动检测连接。首次使用需在网页允许本地通信权限。", parent=self.root)

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
                choices = '\n'.join(f"{i+1}. {row['browser']} · {row['profile']} · {row['id']}" for i,row in enumerate(candidates))
                selected = self.simpledialog.askinteger('选择管理器', choices, minvalue=1, maxvalue=len(candidates), parent=self.root)
                if selected is None:
                    return
                candidate = candidates[selected - 1]
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
        self.root.deiconify()
        frame = self.ttk.Frame(self.root, padding=28)
        frame.pack(fill="both", expand=True)
        self.ttk.Label(frame, text="把扩展文件一起带走", style="Title.TLabel").pack(anchor="w")
        self.ttk.Label(frame, text="栖 · Windows 本地迁移助手", style="Hint.TLabel").pack(anchor="w", pady=(6, 20))
        self.ttk.Label(frame, text="一起保存商店扩展和本地扩展的实际代码。导入会校验并解包到新目录，不会把解包成功误报成浏览器安装成功。", wraplength=650).pack(anchor="w", pady=(0, 18))
        row = self.ttk.Frame(frame)
        row.pack(fill="x", pady=6)

        def action(callback):
            try:
                self.show_result(callback())
            except Cancelled:
                pass
            except Exception as error:
                self.messagebox.showerror("操作未完成", str(error), parent=self.root)

        self.ttk.Button(row, text="导出扩展文件 ZIP", command=lambda: action(lambda: self.export({}))).pack(side="left", expand=True, fill="x", padx=(0, 8))
        self.ttk.Button(row, text="导入扩展文件 ZIP", command=lambda: action(self.restore)).pack(side="left", expand=True, fill="x")
        self.ttk.Label(frame, text="Chrome / Edge 首次安装与授权仍由浏览器确认。备份不包含密码、登录状态或其他扩展的私有设置。", wraplength=650, style="Hint.TLabel").pack(anchor="w", pady=(18, 12))
        self.connection_status = self.tk.StringVar(value='正在自动识别管理器…')
        self.ttk.Label(frame, textvariable=self.connection_status, wraplength=650).pack(anchor='w', pady=(5, 10))
        connection_row = self.ttk.Frame(frame)
        connection_row.pack(fill='x')
        self.ttk.Button(connection_row, text="自动连接管理器", command=lambda: self.automatic_connection(True)).pack(side='left')
        self.ttk.Button(connection_row, text="手动填写扩展 ID", command=self.register).pack(side='left', padx=8)
        self.root.after(150, self.automatic_connection)
        self.root.after(3000, self.refresh_connection_status)
        self.ttk.Label(frame, text=f"v{VERSION} · 无网络上传 · 仅在你选择资料和路径后处理文件", style="Hint.TLabel").pack(anchor="w", side="bottom", pady=(14, 0))
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
    import tkinter as tk
    window = tk.Tk()
    window.withdraw()
    window.update_idletasks()
    tcl_version = window.tk.call("info", "patchlevel")
    window.destroy()
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
    return {"ok": True, "version": VERSION, "tkVersion": str(tcl_version), "archiveRoundTrip": True, "nativeFraming": True, "realProfilesRead": False, "registryModified": False}


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
