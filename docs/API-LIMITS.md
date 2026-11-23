# API 能力及限制

本项目面向 Chromium 114 及以上的 Chrome / Microsoft Edge 桌面版，使用 Manifest V3。目标版本是实现兼容范围，不代表每个浏览器版本均已实测。

Edge 官方列明支持 `management`、`storage`、`action` 和 `commands`。项目使用 `chrome.*` 命名空间；新版 Chrome 文档展示的 `browser.*` 别名从 Chrome 148 才提供，不宜据此提高项目的最低版本。[Edge API 支持](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)、[Chrome API 概览](https://developer.chrome.com/docs/extensions/reference/api)

## 管理范围

`management` 可读取当前浏览器用户资料中 API 返回的扩展与应用信息。它不提供跨浏览器、跨用户资料或远程设备清单。浏览器内部组件及组织策略保护的项目不承诺能够修改。[management API](https://developer.chrome.com/docs/extensions/reference/api/management)

项目保留 API 返回的所有项目类型；主题与旧应用等特殊类型的操作能力以浏览器为准。`setEnabled` 官方说明面向应用和扩展，特殊类型可通过原生管理页处理。不能将清单覆盖范围理解为所有类型均能使用全部操作。

## 启停与卸载

启停遵守 `mayDisable`、`mayEnable` 和浏览器的原生授权限制。`setEnabled` 通常要求用户手势，也可能出现原生确认。增加权限后停用的项目需要逐项重新授权。卸载其他扩展时浏览器始终显示原生确认；取消或拒绝应作为未完成结果呈现。[启停及卸载接口](https://developer.chrome.com/docs/extensions/reference/api/management#method-setEnabled)

批量操作和场景切换不是事务：某些项目成功时，其他项目仍可能失败或被跳过。界面应保留逐项结果，不把部分成功显示为全部成功。本管理器自身不能被批量关闭，以便保持操作入口。

组织策略、浏览器安全限制和不再支持的扩展不能通过本项目绕过。`disabledReason` 只提供 `unknown`、`permissions_increase`，不能据此判断全部禁用原因。

## 权限审阅

界面显示浏览器提供的 API 权限、网站权限及可用的权限警告。权限范围可以帮助用户判断是否符合用途，但不能证明扩展实际行为，也不能替代代码审计或恶意软件检测。项目不提供“保证安全”的分数。

`permissions` API 管理调用扩展自身的权限；本项目不能替其他扩展更改网站访问范围。无痕和文件 URL 访问查询也只面向调用扩展自身，不能用来读取或修改其他扩展的对应授权。需调整这些设置时请打开原生详情页。[permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)、[extension API](https://developer.chrome.com/docs/extensions/reference/api/extension)、[Edge 网站访问设置](https://support.microsoft.com/en-us/edge/change-site-access-permissions-for-extensions-in-microsoft-edge)

## 安装、备份与重载

浏览器没有向普通管理扩展提供安装任意 CRX 的通用权限；扩展安装应交由商店或浏览器原生流程。导入预览不会改变扩展状态；选择“确认导入并应用”后才会恢复备份中已安装项目的启用状态，依旧不会静默安装缺失扩展。[Chrome 安装流程说明](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions)

JSON 备份只包含本管理器配置和清单，不含其他扩展的数据、登录状态或安装文件。1.4.0 的可选 Windows 助手通过 Native Messaging 读取所选资料中的扩展实际目录并生成 ZIP；文件恢复只会解包到新目录，仍不具备任意静默安装权限。不同商店、不同版本的扩展 ID 可能不同，不能仅凭同名自动认定为同一个扩展。本地开发扩展换目录而缺少固定公钥时 ID 也可能变化。

助手独立安装并登记当前用户 Native Messaging host，通过明确的管理器 ID 白名单限制访问；扩展仅在用户操作时请求可选 `nativeMessaging` 权限。此方式不修改企业安装策略，也不编辑浏览器配置来伪造安装状态。文件迁移流程见 [Windows 文件迁移](MIGRATION.md)。

恢复会重新读取浏览器实际状态，不会仅依据 API 调用成功就显示全部应用。未安装、组织策略保护、管理器自身、主题和需要新增权限授权的项目均遵守各自限制；配置写入与启停结果分别报告。上次完整恢复报告保存在独立本地键，可下载 JSON。

`runtime.reload()` 只能重载调用它的扩展自身。将其他扩展停用再启用只能称为重启，不能保证重新读取开发目录中的代码，更不能等同于扩展页的开发模式“重新加载”。[runtime.reload](https://developer.chrome.com/docs/extensions/reference/api/runtime#method-reload)

## 原生小窗

工具栏小窗由 `action.default_popup` 注册，点击扩展图标或配置的快捷键即可打开。浏览器限制原生小窗最大为 800 × 600 CSS 像素，本项目使用 600 × 590 并在内部滚动。点击浏览器其他区域时由浏览器自动关闭，不能强行保持打开；长时间整理可进入完整管理页。[Action popup 尺寸](https://developer.chrome.com/docs/extensions/reference/api/action#popup)、[原生关闭行为](https://developer.chrome.com/docs/extensions/develop/ui/add-popup)

原生授权、卸载确认或切换到其他标签页可能收起小窗。已经提交给浏览器的操作以浏览器实际状态为准，重新打开时会刷新清单。

## 信息完整性

`ExtensionInfo` 没有提供其他扩展的完整 manifest、`manifestVersion`、安装时间、实际使用频率或内存占用。界面不应捏造这些信息。安装来源标记也不等同于安全结论。[ExtensionInfo](https://developer.chrome.com/docs/extensions/reference/api/management#type-ExtensionInfo)

真实扩展模式下的 API 错误会直接反馈；HTTP 演示模式使用示例数据并显式标识，不能把演示结果作为真实浏览器管理能力的验证。
