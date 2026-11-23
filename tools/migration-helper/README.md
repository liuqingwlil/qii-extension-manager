# 栖 · Windows 扩展文件迁移助手

助手为普通 Chrome / Edge 管理扩展补充读取本地代码文件和生成 ZIP 的能力。它不安装其他扩展，不修改浏览器资料，不写企业策略，不克隆整个浏览器配置。

导出可以包含商店扩展实际代码、本地开发扩展目录、原 ID / 版本 / 来源、文件 SHA256，以及由管理器提供的配置备份。单独打开助手导出时没有管理器配置；从管理器内调用导出时会一并保存配置。

导入把文件校验并解包到新建的 `Qii-Restore-...` 目录，生成 `restore-report.json` 和 `安装扩展清单.html`。**文件恢复成功不等于浏览器安装成功**；返回结果始终包含 `installed: false`。Chrome / Edge 要求的首次安装和授权仍需用户确认，本地扩展需要按浏览器的“加载解压缩的扩展”流程安装。

## 用户操作

1. 在旧电脑运行 `QiiMigration.exe`。可以直接导出文件，也可以点击“连接管理器”，粘贴管理器显示的 32 位扩展 ID，然后回到管理器重新检测。
2. 导出时确认浏览器资料，核对扩展目录，选择 ZIP 保存位置。无法唯一匹配资料时必须明确选择，不会把其他资料中的同名项目混入。
3. 非默认路径的浏览器资料可通过“选择自定义资料目录”定位。文件丢失或本地目录变化时，选中对应 ID 后点击“定位选中项的目录”；对应关系由用户明确确认，不按名称猜测。
4. 把 ZIP 和助手带到新电脑。导入 ZIP，选择保存目录，查看文件校验结果和本地安装清单。
5. 在 Chrome / Edge 完成扩展安装后，再通过管理器导入 `manager-backup.json`、核对实际 ID 和启停状态。本地项目没有固定 `manifest.key` 时，换目录可能改变 ID；助手保留原始 manifest，不伪造签名或原 ID。

备份不包含密码、Cookie、登录状态或其他扩展的私有存储。已经删除、已卸载且没有源文件的项目无法凭清单重建；缺失和读取失败会逐项报告，任何跳过都不会显示为完整备份。

## 文件与源码

- `qii_archive.py`：资料选择、代码目录解析、ZIP 生成、SHA256 校验及隔离恢复；无 GUI / 注册表操作。
- `qii_migration.py`：Tkinter 图形界面、原生消息协议、用户主动触发的本地连接注册。
- `QiiMigration.spec`：PyInstaller 单文件构建定义。
- `test_archive.py`、`test_native.py`：只使用临时合成资料和清单，不读取用户浏览器资料，不注册主机。

运行测试：

```powershell
python -m unittest -v test_archive.py test_native.py
python qii_migration.py --self-test
```

构建需要支持当前 Python 版本的 PyInstaller。当前验证环境为 Python 3.14.5、PyInstaller 6.22.3、Tk 9.0.4：

```powershell
python -m PyInstaller --clean --noconfirm QiiMigration.spec
.\dist\QiiMigration.exe --version
.\dist\QiiMigration.exe --self-test
```

产物为 `dist/QiiMigration.exe`。构建启用 `console=True` 和 `hide_console='hide-early'`，保留原生消息所需的二进制 stdin/stdout；不能改成 `--windowed` 后继续使用同一协议。`--self-test` 检查 Tcl/Tk 可加载、临时合成代码文件往返和消息帧，不显示窗口、不读取真实资料、不修改注册表。

## 原生消息连接

用户在 EXE 中点击“连接管理器”后，助手安装到当前用户的 `%LOCALAPPDATA%\QiiMigration\QiiMigration.exe`，并写入 `native-host.json`。只向以下当前用户位置注册主机 `com.qii.migration`：

- `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.qii.migration`
- `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.qii.migration`

`allowed_origins` 只允许用户输入的精确扩展 ID；不使用通配符。调用方 origin 必须匹配已连接清单，导出请求的 `managerId` 还必须等于调用方 ID。源码运行不会注册主机，打包验证也不运行此注册操作。

Chrome / Edge 启动 EXE 时会传入 `chrome-extension://<ID>/`。程序读取 4 字节 little-endian 长度和 UTF-8 JSON，每次进程处理一个请求。请求及返回帧均限制为 1 MiB；日志不能混入 stdout。

### 请求 / 返回

```json
{"action":"ping"}
```

返回：`{"ok":true,"version":"1.0.0","capabilities":["export","import"]}`。

```json
{"action":"export","backup":{"app":"qii-extension-manager","version":2,"inventory":[],"data":{}},"browser":"Edge","managerId":"<32位ID>"}
```

`backup` 必须是管理器实际生成的 v1/v2 有效备份；示例省略了完整配置。导出通过原生对话框选择保存路径，返回 `ok`、`action`、`archivePath`、`complete`、`items`（`included` / `missing` / `failed`）和本地 `reportPath`。`complete` 只在所有文件完整保存时为 true。

```json
{"action":"import"}
```

用户选择 ZIP 和目的目录后，返回 `ok`、`action`、`directory`、`complete`、`installed:false`、`items`（`files-restored` / `missing` / `failed`）、`reportPath`、`guidePath`，包中包含配置时另有 `managerBackup`。

取消返回 `{"ok":false,"cancelled":true,"error":"已取消"}`；操作错误返回 `{"ok":false,"error":"..."}`。大报告返回会截断详细行并标记 `detailsTruncated` / `totalItems`；完整逐项结果在本地报告。配置过大时不经消息返回，另有 `managerBackupOnDisk:true` 和说明，可从恢复目录手动导入。不会因返回帧过大把已经完成的文件恢复伪报成失败。

## ZIP 校验与边界

包结构为 `manifest.json`、可选 `manager-backup.json` 以及 `extensions/<原ID>/...`。格式标识为 `app: "qii-migration"`、`formatVersion: 1`，逐文件记录路径、大小和 SHA256。只接受自己完整声明的文件，不接受未列出的额外文件。

默认限制为 100000 个代码文件、2 GiB 解压代码、4 MiB 清单、900000 字节管理器配置。恢复前核对全包路径和哈希，拒绝绝对路径、路径穿越、反斜杠歧义、Windows ADS / 保留名称、重复或大小写冲突、特殊文件、符号链接及异常压缩比。读取源文件和恢复目的路径都不跟随重解析点。

ZIP 不能保存到待备份源码目录内。目标 ZIP 使用独占创建，不覆盖已有文件；失败只清理本次创建的临时和目标文件。恢复只写新建目录，不覆盖已有文件；校验失败发生在创建输出目录之前。读取期间源文件变化、任何无法读取的文件和链接跳过均被记录为不完整。

安装能力依据：[Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)、[Chrome 安装规则](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions)、[Edge 本地扩展安装流程](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading)、[manifest.key](https://developer.chrome.com/docs/extensions/reference/manifest/key)。
