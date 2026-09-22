# CASEBANG 个人钉盘 OAuth 接入项目设计

文档版本：1.0 · 2026-09-21  
性质：开发实施与验收依据；第一阶段凭据接入已实现，后续界面与端到端验收仍按阶段推进。  
范围：下游账号以本人身份读取“钉盘/钉钉文档 → 我的文档”中的印刷图档目录，建立远程索引并按需核验缩略图。  
本轮已落地：登录回调保存用户授权凭据、服务端加密存储、个人图档优先使用当前用户 Token、Token 到期单飞刷新；授权重连界面、按需缩略图和生产环境端到端验收仍按后续阶段推进。

## 1. 结论与项目目标

现有实现不能读取登录用户的“我的文档”。问题不在文件夹链接，也不是继续增加 App Token 权限就能解决，而是调用身份错误：

- 现有钉钉登录只使用用户 Access Token 获取昵称、unionId 等登录资料，随后立即丢弃该 Token。
- 后续图档索引使用企业应用 App Token 调用 Drive/Storage 接口。
- App Token 可以读取应用获得授权的企业 `org` 空间，但不能代表某个自然人读取其 `mySpace`。
- 因此，把 `spaceType` 从 `personal` 改为 `org` 只能读取“全员文件夹”等企业空间，不能找到用户“我的文档”中的节点。

本项目的目标是把身份登录与个人资料授权正确分层：软件会话继续用于 CASEBANG 身份认证；个人钉盘使用可撤销、可刷新、按登录账号隔离的用户 OAuth 授权。下游账号 A 只能索引 A 授权的目录；切换到下游账号 B 后只能读取 B 的授权和索引。

完成定义：当前下游账号完成用户授权后，可以绑定本人“我的文档”中的固定父目录；系统不下载整个目录，能够读取目录元数据、选择当前系列子目录、按名称筛选候选、按需取得缩略图或在线预览，并在授权失效时明确提示重新授权。

## 2. 真实环境证据

以下结论来自 2026-09-21 的生产配置只读诊断，不是推测：

1. `Drive.Space.Read` 首次未发布时，空间列表返回 `403 Forbidden.AccessDenied.AccessTokenPermissionDenied`。
2. 权限发布后，用 App Token 查询 `spaceType=personal` 返回：

   ```text
   HTTP 400
   code: no.priviledge
   message: You are not authorized to perform this operation.
   ```

3. 同一 App Token、同一 unionId 查询 `spaceType=org` 成功，得到：

   ```text
   spaceId: 332318530
   spaceName: All staff folder
   spaceType: org
   ```

4. 对该企业空间只读平铺索引得到 13 个节点；用户提供的父目录节点 `6LeBq413JALdPe1ZizrKbYRxVDOnGvpb` 不在其中，名称中也没有印刷图档、TSUM、J7 等候选。
5. 用户链接位于当前登录账号的“我的文档”，链接格式为 `https://alidocs.dingtalk.com/i/nodes/{dentryUuid}`。链接最后一段是节点 UUID，不是数字型 dentryId，也不能替换成企业空间里同名目录的 ID。

因此，当前 `artwork_source_unreadable` 的准确含义是“App Token 可访问的空间中不存在该个人节点”，不是“目录为空”。

## 3. 产品边界

### 3.1 本期必须实现

- 只有下游业务角色显示个人钉盘授权与印刷图档功能。
- 每个登录账号独立授权，不绑定到固定员工，也不共享 Refresh Token。
- 登录 CASEBANG 与授权个人钉盘在界面上可连续完成，但服务端必须保存为两种不同状态。
- 支持用户提供的 `/i/nodes/{id}` 文件夹链接。
- 固定父目录按账号保存；当前系列子目录按共享工作簿保存。
- 默认只同步文件夹、文件名、节点 ID、父子关系、扩展名、大小、版本和修改时间。
- 默认不下载原始 PDF、PSD、AI 文件或整个 1GB 目录。
- 缩略图或单文件预览必须按需请求，有数量、大小、并发和超时限制。
- 授权、刷新、撤销、重新授权和索引操作均留审计记录，但日志不得包含 Token。
- 企业 `orgSpace` 读取能力保留为备用来源，不能再把它冒充个人“我的文档”。

### 3.2 本期不实现

- 不把 DWS CLI 登录目录直接复制到服务器或打包进客户端。
- 不让用户粘贴 Access Token、Refresh Token 或 Cookie。
- 不通过浏览器自动化抓取钉钉网页 DOM。
- 不默认下载完整图档目录。
- 不在本项目中实现钉盘文件移动、改名、删除或上传。
- 不因名称相同就自动判定图案一致；图片一致性仍需缩略图/预览证据。
- 不在授权可行性验证前承诺全自动图片比对已经完成。

## 4. 身份和授权模型

### 4.1 两种令牌不得混用

```text
企业应用 App Token
  ├─ 企业成员身份映射
  ├─ 工作通知 / Stream 等企业能力
  └─ 获授权的 orgSpace 或应用空间

用户 OAuth Token
  ├─ 当前自然人的 mySpace / 我的文档
  ├─ 当前用户有权访问的文档节点
  └─ 用户授权范围内的按需预览能力
```

CASEBANG 自己的 `user_sessions` Token 只代表“已登录本软件”，不能代替钉钉用户 OAuth Token。钉钉 App Token 也不能因携带 unionId 就自动获得该用户私人资料权限。

### 4.2 推荐授权流程

1. 桌面端发起登录，服务端创建带随机 `state`、过期时间和 PKCE（若钉钉当前流程支持）的授权尝试。
2. 浏览器打开钉钉官方授权页，用户确认账号和组织。
3. 钉钉回调服务端；服务端校验 `state`、一次性状态、回调时限和组织归属。
4. 服务端用授权码换取用户 Access Token、Refresh Token、到期时间和实际授权范围。
5. 服务端读取用户资料并核对 unionId/userId/corpId，与当前 CASEBANG 账号建立唯一关联。
6. Refresh Token 加密保存；Access Token 仅在服务端缓存或加密保存，不返回桌面端。
7. 桌面端轮询授权结果，只取得 CASEBANG 会话状态和“个人钉盘已授权”布尔状态。
8. 后续个人钉盘调用由服务端令牌代理完成；即将过期时单飞刷新，避免并发刷新导致令牌作废。

钉钉实际支持的授权范围、Access/Refresh Token 字段、刷新端点和个人 Drive/文档端点必须在 P0 使用测试应用与测试账号读取官方接口 Schema 后锁定。文档不虚构 scope 名称或未验证的路径。

### 4.3 登录、退出与撤销语义

- “退出 CASEBANG”：撤销本机 CASEBANG 会话。默认同时停止该会话触发的新索引，但不擅自删除业务索引记录。
- “解除个人钉盘授权”：删除/吊销该用户的服务端 OAuth 授权，停止后台刷新，并把资料源状态改为 `reauthorization_required`。
- “切换上游/下游”：角色改变不转移授权所有权。个人钉盘入口只在下游角色显示。
- “账号被禁用/离职”：撤销全部 CASEBANG 会话和个人钉盘授权；历史审计与已确认核验记录保留。
- “Refresh Token 失效”：不循环重试；明确提示本人重新授权，不回退成 App Token 扫描其他人的空间。

## 5. 服务端安全设计

### 5.1 Token 存储

建议新增部署密钥：

```text
DINGTALK_USER_TOKEN_ENCRYPTION_KEY_FILE=/run/secrets/dingtalk_user_token_key
```

要求：

- 使用独立 256 位随机密钥，不复用 Client Secret、WPS Secret、COS Secret 或数据库密码。
- Refresh Token 采用带认证加密，例如 AES-256-GCM；每条记录使用独立随机 nonce。
- 数据库存储密文、nonce、认证标签、密钥版本和 Token 元数据；禁止存储明文 Token。
- 日志、API 响应、错误堆栈、审计 payload、测试快照不得出现 Token、授权码或完整 Cookie。
- 支持密钥版本轮换；读取旧版本后可在安全事务中重加密。
- 数据库备份不包含解密密钥；Secret 文件不进入 Git、镜像层或环境文件。

### 5.2 最小权限与访问控制

- 个人钉盘路由必须先验证 CASEBANG 会话，再按 `organization_id + user_id` 读取对应授权。
- 客户端不能提交另一个用户的 unionId、spaceId 或 credentialId 来切换身份。
- 绑定固定父目录时先以当前用户身份解析 URL，再保存服务端返回的权威节点信息。
- 系列目录必须是该账号固定父目录的后代；仅凭 URL 域名合法不能通过。
- 工作簿目标还要校验当前账号属于该工作簿组织且具有下游访问权。
- 所有远程 URL 由固定钉钉域名和 HTTPS 白名单生成，不接受任意下载地址以防 SSRF。

### 5.3 刷新并发与故障策略

- 每个授权记录同一时刻最多一个刷新请求，可使用数据库 advisory lock、行锁或进程级 single-flight。
- 调用前若 Token 即将到期，在安全窗口内刷新；401/明确 Token 失效最多触发一次刷新后重放。
- 权限拒绝、资源不存在、授权撤销不能按网络错误无限重试。
- 钉钉限流采用有上限的指数退避并记录 `next_retry_at`。
- 刷新结果写入必须带版本条件，旧刷新响应不能覆盖较新的 Token。

## 6. 数据库设计

建议新增迁移 `009_dingtalk_user_oauth.sql`。字段名称可在实施时微调，但语义不得缺失。

### 6.1 用户授权表

```sql
CREATE TABLE dingtalk_user_grants (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'dingtalk',
  status text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  access_token_ciphertext bytea,
  access_token_nonce bytea,
  refresh_token_ciphertext bytea NOT NULL,
  refresh_token_nonce bytea NOT NULL,
  encryption_key_version integer NOT NULL,
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz,
  token_version integer NOT NULL DEFAULT 1,
  last_refreshed_at timestamptz,
  last_error_code text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,user_id,provider),
  FOREIGN KEY(organization_id,user_id)
    REFERENCES app_users(organization_id,id)
);
```

`status` 建议限定为：

- `active`
- `refreshing`
- `reauthorization_required`
- `revoked`
- `error`

不要把授权记录放进 `user_sessions`。软件会话可以较短、可以多设备；用户钉盘 Grant 是可刷新且必须单独撤销的外部授权。

### 6.2 授权尝试表扩展

现有 `auth_attempts` 用于桌面登录轮询。建议增加或新建专门的 OAuth Grant Attempt：

- `purpose`: `signin` / `personal_drive_reauthorize`
- `code_verifier_ciphertext`（仅在使用 PKCE 时）
- `requested_scopes`
- `granted_scopes`
- `grant_id`
- 一次性交付和过期控制

登录身份确认成功但个人钉盘授权失败时，CASEBANG 登录是否成功要与产品提示分开：允许用户进入其他功能，但个人图档入口显示“需要授权”。

### 6.3 图档来源表调整

现有 `artwork_sources` 每个用户一条的隔离方向可以保留，建议增加：

- `grant_id`
- `source_kind`: `personal_drive` / `organization_drive`
- `workspace_id` 或 `space_id`（以实际 API 返回为准）
- `root_node_id`
- `authorization_status`
- `sync_cursor`（若官方接口支持增量游标）
- `last_remote_revision`

现有错误绑定不得自动改写成成功。迁移后把找不到节点的个人来源标为 `reauthorization_required`，要求用户重新授权并重新绑定；企业空间来源只有在节点真实存在时才保留。

### 6.4 审计事件

建议新增不含敏感内容的事件：

- `DINGTALK_USER_GRANT_CREATED`
- `DINGTALK_USER_GRANT_REFRESHED`
- `DINGTALK_USER_GRANT_REAUTHORIZED`
- `DINGTALK_USER_GRANT_REVOKED`
- `ARTWORK_SOURCE_BOUND`
- `ARTWORK_SOURCE_SYNCED`
- `ARTWORK_TARGET_BOUND`
- `ARTWORK_PREVIEW_OPENED`

只记录用户、时间、资源 ID 哈希或受控 ID、数量、结果和错误类别；不记录 Token 和完整签名 URL。

## 7. 服务模块设计

### 7.1 模块拆分

```text
collaboration-server/src/
  dingtalk-oauth.ts              现有登录身份确认
  dingtalk-user-grant.ts         用户授权、加密、刷新、撤销
  dingtalk-personal-drive.ts     mySpace/我的文档节点读取
  dingtalk-drive.ts              App Token 的 orgSpace 兼容路径
  artwork.ts                     业务路由与来源/目标约束
```

业务层不能自行解密 Token；只能调用 `DingTalkUserGrantService.withAccessToken(userId, operation)`。该服务负责刷新、错误归类、日志脱敏与单飞锁。

### 7.2 连接器接口

```ts
interface ArtworkDriveConnector {
  inspectNode(nodeIdOrUrl: string): Promise<RemoteNode>
  listChildren(folderNodeId: string, cursor?: string): Promise<RemoteNodePage>
  getThumbnail(nodeId: string, version?: string): Promise<TemporaryPreview>
  getPreviewUrl(nodeId: string, version?: string): Promise<TemporaryPreview>
}
```

`TemporaryPreview` 必须包含到期时间；签名 URL 不写数据库。若官方能力只允许钉钉客户端预览，则返回受控 `alidocs` 节点链接并将“缩略图自动比对”保持为不可用状态，不能假造缩略图。

### 7.3 索引策略

正确顺序：

1. 使用用户授权直接检查用户粘贴的父目录节点。
2. 确认它是文件夹、属于当前用户可访问范围，并保存权威 nodeId/spaceId/workspaceId。
3. 从该父目录有界分页遍历，而不是先扫描整个个人盘。
4. 保存元数据与目录关系，不保存文件正文。
5. 后续增量同步优先使用远端游标/版本；没有增量能力时按目录分批比较。
6. 当前系列只查询已选子树，避免每次加工扫描全部历史图档。

默认安全限制建议：单次同步最多 10,000 个节点、单页遵守官方上限、并发 2～4、总执行时间 2 分钟后转后台任务。达到上限时显示“索引未完成”，不得把部分结果说成全量。

## 8. API 设计

建议新增或调整：

```text
POST   /api/v1/auth/dingtalk/personal-drive/start
GET    /api/v1/auth/dingtalk/personal-drive/status
GET    /api/v1/auth/dingtalk/personal-drive/grant
DELETE /api/v1/auth/dingtalk/personal-drive/grant

PUT    /api/v1/dingtalk/artwork-source
POST   /api/v1/dingtalk/artwork-source/sync
GET    /api/v1/dingtalk/artwork-source/entries
PUT    /api/v1/dingtalk/artwork-targets/:workItemId
GET    /api/v1/dingtalk/artwork-targets/:workItemId
POST   /api/v1/dingtalk/artwork-preview
```

绑定接口不再接收或推断客户端 unionId，只接收文件夹 URL；服务端从当前 CASEBANG 会话定位 Grant。

建议错误码：

- `dingtalk_personal_grant_required`
- `dingtalk_personal_grant_expired`
- `dingtalk_personal_scope_missing`
- `dingtalk_personal_token_refresh_failed`
- `dingtalk_personal_node_forbidden`
- `dingtalk_personal_node_not_found`
- `artwork_source_not_folder`
- `artwork_target_outside_source`
- `artwork_index_limit_reached`
- `artwork_preview_unavailable`

错误响应只返回用户可理解的信息和可关联的 requestId；钉钉原始错误码写入脱敏服务日志。

## 9. 桌面端交互

### 9.1 资料管理 → 印刷图档

状态分为：

1. 未授权：显示“授权我的钉盘”，不显示绑定表单。
2. 已授权、未绑定：显示当前钉钉账号，允许粘贴固定父目录链接。
3. 已绑定：显示目录名、索引数量、最近同步时间和授权状态。
4. 授权失效：保留已有索引只读，显示“重新授权”，禁止把旧索引当最新结果。
5. 正在同步：后台进度可离开页面；失败显示明确类别和重试入口。

必须写明“软件只读取你选择的父目录元数据，不会默认下载整个文件夹”。

### 9.2 新建表加工 → 核验印刷图档

步骤保持在物料编码之后：

1. 完成并保存物料编码。
2. 从已绑定父目录的索引中选择当前系列子目录，或粘贴其节点链接。
3. 按系列、图案码、英文图案名、品类、机型和材质筛选候选。
4. 文件名与名称一致只标为“候选匹配”。
5. 用户按需打开缩略图/在线预览，确认图案一致后记录结论。
6. 缺图、无权限、远端版本变化或同名多候选均不得标记加工完成。

### 9.3 账号切换

- 页面显示当前账号昵称和头像，避免用户误以为仍在使用上一个账号的钉盘。
- 切换账号时清空前端图档搜索结果、预览缓存和未提交目录选择。
- 服务端每次请求重新按会话 userId 定位 Grant，不信任前端缓存的账号 ID。

## 10. 与现有实现的迁移

### 10.1 可以复用

- CASEBANG `auth_attempts`、`user_sessions` 和账号/角色模型。
- `artwork_sources`、`artwork_entries`、`artwork_work_targets` 的账号隔离及索引展示。
- `/i/nodes/{id}` URL 解析。
- 当前企业 `orgSpace` 读取与 `listAll → 逐目录遍历` 兼容回退。
- 新建表加工中的图档步骤、名称候选展示和按需打开入口。

### 10.2 必须替换

- 不能再用 App Token + unionId 读取个人目录。
- 不能把 `personal` 请求失败后找到的任意 `org` 空间当作用户“我的文档”。
- 不能通过扫描企业空间找不到节点后只返回笼统 `artwork_source_unreadable`。
- 不能在登录成功后丢弃个人 Drive 所需的可刷新授权。

### 10.3 兼容策略

- 已绑定且能在真实 `orgSpace` 找到节点的企业来源继续可用，标识为“企业空间”。
- 现有链接若在 App Token 可见空间中找不到，标识为“需要个人授权”，不删除历史索引。
- 老桌面端调用新服务时得到明确 `client_upgrade_required` 或既有兼容响应，避免白屏。
- 数据库迁移必须前向执行；回滚代码时不删除 Grant 表和密文，先禁用个人索引任务。

## 11. 测试计划

### 11.1 单元测试

- Token 加密后数据库中不存在明文；正确密钥可解密，错误密钥失败关闭。
- 到期前刷新、并发刷新单飞、刷新版本冲突、Refresh Token 失效。
- 当前用户不能读取另一用户的 Grant、来源、索引和目标。
- `/i/nodes` URL 解析、文件夹类型校验、父子范围校验。
- orgSpace 与 personal mySpace 连接器不会互相冒充。
- 日志序列化不会包含 Access/Refresh Token。

### 11.2 集成测试

- 用户 A、B 分别授权并绑定自己的目录；相同文件夹名称也不会串数据。
- A 退出、B 登录后只看到 B 的资料源。
- Access Token 过期后自动刷新一次并继续读取。
- 用户撤销钉钉授权后，服务端停止刷新并要求重新授权。
- 固定父目录 1GB 但只索引元数据；网络流量中不出现整目录下载。
- 目标系列目录不在父目录下时拒绝绑定。
- 远端文件改名/移动/版本变化后增量同步正确更新。

### 11.3 安全测试

- 伪造 userId、unionId、grantId、workItemId 越权全部失败。
- OAuth state 重放、过期回调、跨账号回调、授权码二次使用失败。
- 数据库备份、应用日志、错误响应、Electron 日志中搜索不到 Token。
- 任意 URL、内网 URL、非钉钉域名不能进入预览代理。
- 临时预览 URL 过期后不能复用。

### 11.4 业务验收

- 当前下游账号可以绑定节点 `6LeBq413JALdPe1ZizrKbYRxVDOnGvpb` 对应父目录。
- 能在该父目录下选择当前系列节点 `lyQod3RxJKqjPvByFl47lxqNWkb4Mw9r`。
- 索引结果包含用户实际看到的系列、品类子目录和文件名称。
- 只打开一个候选时不下载其他图档。
- 文件名相同但图案不同不能自动通过。
- 切换下游账号后必须使用新账号自己的授权，不继承前一个账号的目录。

## 12. 分阶段实施

### P0：官方能力验证

1. 使用测试应用和测试账号验证用户 OAuth Token 的获取、刷新、撤销和期限。
2. 验证该 Token 能直接解析两个真实 `/i/nodes` 文件夹节点。
3. 明确实际接口、scope、权限点、分页上限、缩略图/预览能力和限流规则。
4. 验证自建企业应用是否可直接使用；若个人文档能力只通过官方 DWS 托管连接器提供，记录其部署、账号授权和服务端调用边界。
5. 输出不含 Token 的接口证据。P0 未通过时不进入生产 Token 存储开发。

### P1：Grant 与 Token Broker

实现迁移、加密存储、授权/重授权/撤销、刷新单飞、审计和错误分类。先用“列出本人 mySpace 根目录”作为验收，不接业务页面。

### P2：个人目录绑定与索引

实现用户身份连接器、直接节点解析、有界分页、元数据索引、父子范围验证和账号隔离。把现有错误来源迁移成需要授权状态。

### P3：加工流程接入

将个人目录授权状态、系列目录选择、候选匹配和远端版本检查接入“新建表加工 → 核验印刷图档”。

### P4：按需缩略图与核验

在官方能力允许的前提下增加缩略图缓存、限流和人工核验；再评估图片自动比对。没有可验证缩略图时保持人工在线预览，不降级为下载整个目录。

### P5：上线与回退

两名下游测试账号、小系列、授权失效、账号切换、大目录、远端改名和断网场景全部通过后上线。保留企业空间来源开关；个人连接器异常时只停用个人索引，不影响 WPS、COS、69 码和物料编码功能。

## 13. 上线门槛

以下条件全部满足才能显示“个人钉盘已连接”：

- 当前 CASEBANG 用户与钉钉用户身份一致。
- 用户 OAuth Grant 有效且实际授权范围满足读取要求。
- 固定父目录能够以用户身份解析为文件夹。
- 服务端已保存加密 Refresh Token，且完成至少一次刷新测试。
- 索引只包含该目录子树，账号隔离测试通过。
- Token 未出现在数据库明文字段、日志、桌面端状态或 API 响应中。
- 大目录测试确认没有默认全量下载原文件。
- 授权撤销后系统停止访问，并能引导重新授权。

## 14. 风险与决策

- **官方能力变化**：个人文档接口与 DWS 能力仍在演进。所有端点和 scope 以实施时官方 Schema 与真实测试为准。
- **令牌安全**：引入 Refresh Token 后，服务端安全等级提高；没有独立加密密钥、备份隔离和日志脱敏不得上线。
- **个人与企业空间混淆**：页面名称“我的文档”、URL 参数或文件夹名字不能替代 API 返回的权威空间类型。
- **预览不等于自动核图**：能打开链接不代表系统获得图片像素；自动比对必须有合法缩略图/预览数据来源。
- **第三方依赖**：若采用官方 DWS 连接器，不把 CLI 本地凭据文件当数据库方案；必须明确服务部署、升级、授权和多账号隔离方式。
- **性能**：不得每次进入加工页扫描整个个人盘；固定父目录首次索引、后续增量和系列子树查询必须分层。

## 15. 交给开发者的执行顺序

1. 先完成 P0，不再继续修改 `spaceType` 猜测个人空间。
2. 保留现有 App Token 企业能力，不破坏登录、通知和 orgSpace 兼容路径。
3. 用户 OAuth Grant 独立建模、加密和撤销，不能塞进普通会话表。
4. 先实现只读的 `inspectNode/listChildren`，再接索引；不先做下载或写操作。
5. 用两个真实下游账号做隔离测试，不能只用一个账号切换角色代替凭据隔离测试。
6. P0/P1/P2 通过后再恢复界面的“绑定固定父目录”按钮；未授权时按钮不得继续调用 App Token。
7. 每阶段同步更新本文、`docs/CHANGELOG.md` 和部署 Secret 清单。

## 16. 参考资料

- [钉钉开放平台：获取登录用户访问凭证](https://open.dingtalk.com/document/orgapp-server/obtain-user-token)
- [钉钉开放平台：选择企业或个人钉盘目录](https://open.dingtalk.com/tools/explorer/jsapi?id=10319)
- [钉钉官方 DWS CLI：OAuth、Token 刷新与多账号 Profile](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/README_zh.md)
- [钉钉官方 DWS Drive：mySpace、orgSpace 与 nodeId 边界](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/skills/multi/dingtalk-drive/SKILL.md)

外部资料用于确定能力方向，不替代 P0 的真实应用权限、接口 Schema 和账号实测。
