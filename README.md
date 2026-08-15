# dsh-mcp-setting

DeepSeek Harness 插件：在「设置」界面管理 DSH 配置文件里的 MCP 服务器。

## 功能

设置面板新增「MCP 服务器」页面，直接增删改 `cordis.patch.yml` 中的
`@deepseek-ai/dsh-mcp-client` 行：

- **列表**：展示 `$DSH_HOME/cordis.patch.yml`（主配置）与
  `$DSH_HOME/profiles/<name>/cordis.patch.yml`（各 profile 补丁）中的全部 MCP 服务器，
  标注来源与端点摘要。
- **新增**：写入主配置文件（`$DSH_HOME/cordis.patch.yml`），自描述头注释自动补齐。
- **编辑 / 删除**：作用于服务器所在文件；空掉的 `insert` 补丁条目一并移除。
- **校验**：与 `@deepseek-ai/dsh-mcp-client` 的配置契约一致（id / serverName 唯一且
  匹配命名规则，stdio 必须填写 command，streamable-http 必须填写 url），错误直接
  拒绝写入并返回中文提示；编辑时保留表单未展示的字段（reconnect、
  toolCallTimeoutMs 等），切换传输方式时自动清理另一侧的字段。
- **安全**：所有写操作仅允许本机回环访问；每次写入前保留 `.bak` 备份，临时文件 +
  改名原子落盘；`yaml` 文档级编辑，未触碰的注释与 `!!js` 表达式原样保留。

> 修改的是加载器启动时的组合配置，保存后**重启 DSH 生效**。

## 安装

### 快速安装（推荐）

插件已发布到 npm：`dsh-mcp-setting`。一条命令安装到目标 profile（如 `web`）：

```sh
pnpm dsh plugin --profile web add dsh-mcp-setting
```

该命令在 profile 目录执行 `pnpm add`，并自动把声明了 `dsh.bundle` 的
`dsh-mcp-setting` 加入 `dsh.profile.bundles`。重启 DSH 后插件随 bundles
自动装配（包内 `cordis.patch.yml` 自插入插件行），浏览器打开设置 →
MCP 服务器。

移除：

```sh
pnpm dsh plugin --profile web remove dsh-mcp-setting
```

### 本地开发挂载

```sh
pnpm install && pnpm build          # 编译 lib/
# 或使用注入器生产线：dev_build_plugin → dev_install_package（web profile）
```

挂载后浏览器刷新页面，设置 → MCP 服务器。

## 开发

```sh
pnpm test          # vitest（patch-editor 纯逻辑 + controller fetch 桩）
pnpm typecheck
pnpm build         # tsc 编译 host + tsdown 打包 client
```

## 结构

- `src/index.ts` — Host 半边：`/dsh-mcp-setting/api/*` 路由（webServer），文件读写与校验。
- `src/patch-editor.ts` — 纯函数：patch 文档的增删改查与配置校验（可单测）。
- `src/client/` — Client 半边：`settings.section` 槽位注册、fetch 传输、
  React 设置页（zh/en）。
- `tests/` — 单元测试。
