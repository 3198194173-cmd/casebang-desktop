# CASEBANG 表格编码自动化

软件统一主流程见：[主流程与页面重构](docs/SOFTWARE_WORKFLOW_REDESIGN.md)。详细下游规则见：[建档任务闭环：项目需求与实施设计](docs/MATERIAL_LIFECYCLE_PROJECT.md)。个人“我的文档”印刷图档接入见：[个人钉盘 OAuth 接入项目设计](docs/DINGTALK_PERSONAL_DRIVE_OAUTH_PROJECT.md)。

面向 Windows 的 Electron 桌面应用。当前版本先建立可扩展的软件骨架、基础表管理、任务入口、受控 IPC 和第三方连接器框架。

## 开发命令

```powershell
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm package:win
```

`package:win` 会在 `%LOCALAPPDATA%\CASEBANG\packaging-output` 完成完整应用打包，校验 `CASEBANG-Automation.exe` 存在后，再把最终安装程序复制到项目的 `release` 目录。安装器会创建桌面快捷方式和开始菜单快捷方式。

## 当前边界

- 已完成：桌面应用壳、六步任务向导框架、三张基础表初始化、单张总图导入、白底对象自动识别、可视化裁剪框修正、无覆盖裁图导出、任务草稿、11 个 Excel 模板及字段识别、配置生成、白名单受控写入、写后完整性验证、连接器注册框架、配置持久化和安全 IPC。
- 图片命名与系列名翻译统一使用阿里云百炼，默认视觉模型为 `qwen3-vl-flash`。
- AI 只分析当前裁剪区域，一次提供 3 组中英文对应名称；程序会拦截系列通用名、本系列已有英文名和同次重复候选。下一阶段继续完成模板安全扩行与图片写入、编码引擎、国内命名全表重名拦截、真实钉钉/企业微信鉴权与文件发送。
- 不直接支持个人微信自动发送；优先使用企业微信官方能力。个人微信如需发送，只能另行评估经过授权的人工辅助方案。

架构说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，业务闭环见 [docs/BUSINESS_CLOSED_LOOP.md](docs/BUSINESS_CLOSED_LOOP.md)，功能模块见 [docs/MODULES.md](docs/MODULES.md)，Excel 命令行与验证见 [docs/EXCEL_ENGINE.md](docs/EXCEL_ENGINE.md)，图片模块见 [docs/IMAGE_ENGINE.md](docs/IMAGE_ENGINE.md)。
