# CASEBANG 中央协同服务部署

此部署与现有 `casebang.tech/AI/` 分离：新服务使用 `https://casebang.tech/collab/`，只在现有 HTTPS 主机中增加一个独立路径。API 只绑定服务器本机 `127.0.0.1:3100`，PostgreSQL 不发布端口，Nginx 是唯一公网入口。

## 0. 部署前安全动作

已在聊天或截图中出现过的钉钉 Client Secret 必须先在开发者后台重置。旧值不能继续使用，也不能写入 Git、环境变量文件、命令历史或聊天。新值只写入服务器的 `deploy/secrets/dingtalk_client_secret.txt`。

本阶段不会写钉钉在线总表，也不会改现有 `/AI/` 站点。

## 1. 服务器拉取代码

```sh
cd /opt
sudo git clone https://github.com/3198194173-cmd/casebang-desktop.git casebang-desktop
sudo chown -R "$USER":"$USER" /opt/casebang-desktop
cd /opt/casebang-desktop
```

如果仓库是私有仓库，使用 GitHub Deploy Key 或只读 PAT；不要把令牌写进仓库远程地址。

## 2. 建立只在服务器存在的配置

```sh
cp deploy/collaboration.env.example deploy/collaboration.env
mkdir -p deploy/secrets
chmod 700 deploy/secrets
openssl rand -base64 36 > deploy/secrets/postgres_password.txt
chmod 600 deploy/secrets/postgres_password.txt
```

编辑 `deploy/collaboration.env`，填写 CorpId、Client ID、AgentId。首次启动保持 `DINGTALK_STREAM_ENABLED=false`。

在服务器上用不会回显的方式写入已经重置后的新 Client Secret：

```sh
read -rsp "DingTalk Client Secret: " DINGTALK_SECRET_INPUT
printf '%s' "$DINGTALK_SECRET_INPUT" > deploy/secrets/dingtalk_client_secret.txt
unset DINGTALK_SECRET_INPUT
chmod 600 deploy/secrets/dingtalk_client_secret.txt
```

WPS WebOffice AppID 可以放在标识配置中；AppSecret 只写服务器密钥文件：

```sh
read -rsp "WPS AppSecret: " CASEBANG_WPS_SECRET
printf '\n'
printf '%s' "$CASEBANG_WPS_SECRET" > deploy/secrets/wps_app_secret.txt
unset CASEBANG_WPS_SECRET
chmod 600 deploy/secrets/wps_app_secret.txt
```

`deploy/collaboration.env` 中填写：

```dotenv
WPS_WEBOFFICE_ENABLED=false
WPS_APP_ID=SX20260918QZNBYG
```

首次部署先保持 `false`。即使尚未启用，Compose 也要求 `deploy/secrets/wps_app_secret.txt` 已存在。

## 3. 启动数据库与 API

```sh
docker compose -f compose.collaboration.yml config
docker compose -f compose.collaboration.yml build
docker compose -f compose.collaboration.yml up -d
docker compose -f compose.collaboration.yml ps
curl -fsS http://127.0.0.1:3100/health/live
curl -fsS http://127.0.0.1:3100/health/ready
```

首次启动会在空测试库中自动、按校验和执行迁移。任何迁移失败都会阻止 API 启动，不会把半迁移状态宣称为可用。

## 4. 在现有 HTTPS 站点中增加独立路径

不要创建新的 `collab.casebang.tech` 站点。先将 location 片段复制到 Nginx snippets：

```sh
sudo cp deploy/nginx/casebang.tech-collab.location.example /etc/nginx/snippets/casebang-collaboration.conf
```

然后只在现有 `casebang.tech` 的 HTTPS `server` 块内加入下面一行；不要放到 `/AI/` 的 location 内，也不要放到 `server` 块之外：

```nginx
include /etc/nginx/snippets/casebang-collaboration.conf;
```

验证并重新加载：

```sh
sudo nginx -t && sudo systemctl reload nginx
curl -fsS https://casebang.tech/collab/health/live
curl -fsS https://casebang.tech/collab/health/ready
```

复用 `casebang.tech` 现有证书，不再为 `collab.casebang.tech` 申请证书。`nginx -t` 不通过时不要 reload。

## 5. 启用钉钉 Stream

数据库/API/HTTPS 都通过后，把 `deploy/collaboration.env` 中的 `DINGTALK_STREAM_ENABLED` 改为 `true`，再重建 API：

```sh
docker compose -f compose.collaboration.yml up -d --build api
docker compose -f compose.collaboration.yml logs --tail=100 api
curl -fsS https://casebang.tech/collab/health/ready
```

Stream 是服务端主动连接钉钉，不需要配置公网 HTTP 回调地址。服务端只在事件成功落库后确认消费；落库失败会请求稍后重试。当前只验证连接与安全收件，尚未开放账号登录、任务交接和在线总表写入。

## 6. 启用 WPS WebOffice

代码和迁移部署完成后，在 WPS WebOffice 控制台将回调网关设置为：

```text
https://casebang.tech/collab/weboffice
```

需要调试并开启的接口：文件信息、文件下载地址、文档用户权限、批量用户信息，以及三阶段保存的准备上传、获取上传地址、上传完成。历史版本、重命名、另存和打印目前保持关闭。

然后把 `deploy/collaboration.env` 改为：

```dotenv
WPS_WEBOFFICE_ENABLED=true
```

重建 API：

```sh
docker compose -f compose.collaboration.yml up -d --build --force-recreate api
docker compose -f compose.collaboration.yml logs --tail=150 api
curl -fsS https://casebang.tech/collab/api/v1/system/capabilities
```

桌面端从“工作簿记录”点击“WPS 在线编辑”会签发四小时的用户凭证，并打开相同 `file_id`。凭证放在 URL Fragment 中，不进入 Nginx 请求日志；WPS 保存采用三阶段上传，每次完成后中央修订号递增。

## 7. 后续更新与回滚原则

```sh
cd /opt/casebang-desktop
git pull --ff-only
docker compose -f compose.collaboration.yml build api
docker compose -f compose.collaboration.yml up -d api
```

上线前备份 PostgreSQL 与私有工作簿卷。不要用 `docker compose down -v`，该命令会删除数据库和文件卷。
