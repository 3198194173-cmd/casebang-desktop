# 共享工作簿与 WPS WebOffice 接入方案

更新时间：2026-09-17。

## 已完成的流程边界

1. “新系列建表”“系列补产品”“产品补机型”都在最终步骤先导出新建产品表。
2. 导出成功后才显示可用的“导入共享工作簿”操作。点击后，桌面端把 XLSX 原始字节和 SHA-256 上传到 CASEBANG 中央服务。
3. 中央服务建立唯一工作簿记录和修订 1，文件保存在私有存储；同一文件重复点击不会建立第二条记录。
4. 中央服务自动关联已登录过的下游账号，双方在“工作簿记录”中看到同一条记录。若还没有下游账号，入口明确提示先让下游账号登录一次。
5. 这一步代表工作簿正式进入“已建表，待下游加工”阶段，不再通过收件箱、发件箱或下载副本交接。

## WPS 联机编辑的正确结构

WPS WebOffice 不替 CASEBANG 保存业务文件。CASEBANG 继续拥有 XLSX 文件、版本和权限，WPS 负责网页编辑与在线广播。官方接入要求包括：创建 WebOffice 应用、实现公网回调服务、前端集成 WebOffice SDK。

正式编辑链路如下：

1. 共享记录的 UUID 转换为不含连字符的 WebOffice `file_id`，确保长度不超过官方限制，并在该工作簿所有会话中保持不变。
2. A 或 B 点击“在线编辑”时，桌面端向中央服务申请短期编辑会话。服务端校验其确实是该记录的建表人或加工人，再签发一次性 WebOffice Token。
3. 桌面端打开 CASEBANG 自己的编辑承载页，由 WebOffice SDK 使用相同 `file_id` 初始化文档。A/B 同时在线时，WPS 将一方的改动广播给另一方。
4. WPS 回调 CASEBANG，读取文件信息、下载地址、当前用户及编辑权限。`X-WebOffice-Token` 只允许访问一条工作簿记录，不能用来遍历其他文件。
5. 保存采用官方建议的三阶段保存：准备上传、取得 PUT 地址、完成上传。中央服务校验摘要和大小后，在数据库事务中把新文件写成修订 2、3……，旧修订保持只读留档。
6. 保存完成后，双方的“工作簿记录”显示最新修订号；阶段仍由人员明确选择，不根据一次自动保存误判业务已经完成。

官方说明：

- [WPS WebOffice 原理概述](https://open.wps.cn/documents/app-integration-dev/docs-center/online-preview-edit/principle)
- [回调服务概述与签名](https://open.wps.cn/documents/app-integration-dev/docs-center/online-preview-edit/callback/summary)
- [文档编辑与三阶段保存](https://open.wps.cn/documents/app-integration-dev/docs-center/online-preview-edit/callback/save)

## 接入前需要准备

- 在 WPS 开放平台创建并通过审核的 WebOffice 应用，确认已开通表格在线编辑能力。
- WebOffice AppId。AppSecret 不发送到聊天、不写入 Git，只写入服务器权限为 600 的 secret 文件。
- 在 WPS 后台把公网回调网关配置到 `https://casebang.tech/collab/weboffice/`，逐项通过在线调试后再开启。
- 两个测试账号都能访问该应用，用同一条测试工作簿完成同时编辑、自动保存、主动保存和断线重连测试。

钉钉登录应用与 WPS WebOffice 应用是两个独立的凭据体系：钉钉负责确认 CASEBANG 用户身份，WPS 负责在线编辑。不能把钉钉 Client Secret 当作 WPS AppSecret 使用。

## 下一批代码范围

1. 新增 WebOffice 会话表、上传暂存表和回调幂等记录。
2. 实现回调签名校验、文件信息、下载地址、用户信息、权限和三阶段保存接口。
3. 实现“在线编辑”会话接口和编辑承载页；WPS 尚未配置完成时按钮必须显示“待接入”，不能打开本地副本冒充联机编辑。
4. 保存完成后刷新修订号，并通过现有事件发件箱通知另一方“工作簿已有新修订”。
5. 双账号验收后，再把 `onlineMasterWrite` 能力开关改为可用。
