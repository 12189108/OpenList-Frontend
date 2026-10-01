# 前端自定义编译

在 GitHub Actions 运行 **Custom Frontend Build**，选择需要编译的分支。`version` 可指定 `4.2.6-custom.1` 或 `v4.2.6-custom.1`；留空从 `OpenListTeam/OpenList-Frontend` 获取最新正式版本号。始终编译所选分支的源码，不切回官方发行版。

默认上传 Actions Artifact，包含 `openlist-frontend-dist-v版本.tar.gz` 和 `i18n.tar.gz`。勾选 `publish` 同时创建 GitHub Release；同名标签已存在时，需要新的自定义版本号。工作流不运行 lint 或测试，也不会向分支推送版本提交。

独立脚本需要 Node、匹配 packageManager 的 pnpm，以及用于自动版本查询的 GitHub CLI（已登录或设置 `GH_TOKEN`）：

```bash
# 自动获取官方最新正式版本号，编译当前源码
bash scripts/build-custom.sh

# 指定版本
bash scripts/build-custom.sh --version v4.2.6-custom.1

# 改为查询自己仓库的最新正式版本号
bash scripts/build-custom.sh --version-repo 12189108/OpenList-Frontend
```

产物在 `dist/`。脚本会将 package.json 的版本更新为所指定的版本，不要求创建本地标签。
