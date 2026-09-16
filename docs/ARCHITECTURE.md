# 架构说明

## 设计目标

1. 原始表格永远只读，任务只操作工作副本。
2. Excel、裁图、AI、编码、发送接口相互独立，可以单独替换。
3. 渲染界面不直接访问磁盘、网络密钥或 Electron 原生 API。
4. 所有高权限操作从预加载层进入主进程，并做参数及调用来源校验。
5. 第三方平台通过统一连接器接口接入，不在业务流程里写平台专用代码。

## 运行分层

```text
Renderer（React 界面）
        │ 仅调用 window.casebang 的明确方法
Preload（类型化安全桥）
        │ IPC 白名单 + 参数校验
Main（Electron 主进程）
        ├─ modules/base-files      基础表管理
        ├─ modules/tasks           自动化任务编排
        ├─ modules/spreadsheet     Excel 模板与无损输出
        ├─ modules/image           单张总图裁剪与分类
        ├─ modules/naming          AI 命名与重名规则
        ├─ modules/coding          系列码、产品码分配
        └─ modules/integrations    钉钉、企业微信及未来接口
```

## 安全规则

- `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`。
- 不加载远程网页作为应用界面；联网只由主进程服务发起。
- 预加载脚本不暴露通用 `ipcRenderer`，每个能力单独定义方法。
- IPC 请求使用 Zod 校验，并验证发送方来自本应用窗口。
- 机器人密钥不进入 React 状态和日志；生产版由安全凭据库加密保存。
- 外部链接、网络地址和输出路径均使用白名单或显式确认。

## 数据保护

应用数据目录分为：原始基础表记录、当前基础版本、任务工作区、导出结果、日志和凭据。原始文件路径只用于读取；生成文件必须写到任务目录或用户明确选择的输出目录。
