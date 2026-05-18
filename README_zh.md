# Shelf

> [English](README.md)

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) 与 [Codex](https://github.com/openai/codex) 的桌面工作区管理器 —— 在一个窗口中管理项目、浏览和恢复对话。

## 为什么需要 Shelf？

Claude Code 运行在终端里，对话记录存储在 `~/.claude/projects/` 目录下，以随机 ID 命名的文件散落各处，没有可视化界面。当你同时在多个项目中使用 Claude Code 时，很难快速找到之前聊过什么、在哪里聊的。

Shelf 为 Claude Code 加上了一层图形界面：

- **一眼看到所有对话。** 对话按项目工作区分类展示在侧边栏，显示名称、时间，支持置顶。
- **一键恢复任意对话。** 点击一个对话即可在终端标签页中打开，不需要记住或复制会话 ID。
- **在一处管理多个项目。** 将项目文件夹添加为工作区，Shelf 会自动发现其中的 Claude 对话。
- **也能当普通终端用。** 可以在 Claude 对话旁打开 Shell 标签页，用来跑 git、构建命令等。

## 功能

- **工作区管理** — 添加/移除项目文件夹，自动发现 Claude Code 与 Codex 对话
- **对话浏览** — 列表、恢复、重命名、删除、置顶 Claude Code 与 Codex 对话
- **AI 对话自动整理** — 一键扫描并智能归类本地 AI 对话历史
- **重启现场恢复** — 退出后自动保存所有工作区、会话列表及侧边栏状态，重启后瞬间回到上次离开的位置
- **内嵌终端** — xterm.js + 真实 PTY，标签页可拖拽排序
- **文件树** — 浏览工作区文件，拖拽文件到终端
- **面板缩放** — 拖拽调整侧边栏和文件树宽度
- **深色主题** — One Dark 风格终端配色
- **中英文双语** — 支持中文和英文界面
- **跨平台** — macOS（Apple Silicon）和 Linux

## 安装

从 [Releases](https://github.com/Harukaon/shelf/releases) 页面下载最新 macOS `.dmg` 文件。

## 依赖

- 已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 或 [Codex](https://github.com/openai/codex) CLI 并添加到 PATH

## 开发

```bash
# 安装依赖
npm install

# 开发模式运行
npm run tauri dev

# 生产构建
npm run tauri build
```

## 技术栈

| 层级   | 技术                                    |
| ------ | --------------------------------------- |
| 后端   | Tauri v2, Rust, portable-pty            |
| 前端   | TypeScript, Vite                        |
| 终端   | xterm.js, FitAddon                      |
| UI     | Lucide icons, SortableJS                |

## 友情链接

- [LINUX DO](https://linux.do/)

## 许可证

MIT
