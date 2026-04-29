const dict: Record<string, Record<string, string>> = {
  en: {
    "home.title": "Shelf",
    "home.subtitle": "Select a workspace folder and click a session to start.",
    "home.hint1": "to add a project folder",
    "home.hint2": "Click a session to open it in a terminal tab",
    "home.hint3": "in tab bar for a blank terminal",
    "home.warning": "Tip: Avoid using /resume or claude --resume directly in the terminal to switch sessions, as this will cause tab display to go out of sync. Use the left panel instead.",

    "workspace.add": "+ Add Workspace",
    "workspace.remove": "Remove workspace",
    "workspace.new": "New session",
    "workspace.refresh": "↻",

    "tab.home": "Home",
    "tab.terminal": "Terminal",
    "tab.claude_new": "Claude (new)",

    "session.empty": "Select a workspace",
    "session.load_more": "more",
    "session.remaining": "remaining",
    "session.load": "Load",
    "session.refresh": "↻ Refresh Sessions",

    "file.empty": "Empty directory",
    "file.failed": "Failed to load files",

    "settings.title": "Settings",
    "settings.shell": "Default Shell",
    "settings.language": "Language",
    "settings.save": "Save",
    "settings.cancel": "Cancel",

    "picker.search": "Search sessions...",
    "picker.empty": "No sessions found",

    "process.exited": "[Process exited]",
    "shell.failed": "[Failed to start shell: $1]",
    "context.rename": "Rename",
    "context.open": "Open",
    "context.copy_abs": "Copy Absolute Path",
    "context.copy_rel": "Copy Relative Path",
    "context.refresh": "Refresh",
    "context.delete": "Delete",
    "toast.deleted": "Session moved to trash",
  },

  zh: {
    "home.title": "Shelf",
    "home.subtitle": "选择一个工作区文件夹并点击会话开始。",
    "home.hint1": "添加项目文件夹",
    "home.hint2": "点击会话在终端标签页中打开",
    "home.hint3": "在标签栏中新建空白终端",
    "home.warning": "提示：避免在终端中直接使用 /resume 或 claude --resume 切换会话，否则标签页显示会与 Shelf 的会话管理不同步。请使用左侧面板管理会话。",

    "workspace.add": "+ 添加工作区",
    "workspace.remove": "移除工作区",
    "workspace.new": "新建会话",
    "workspace.refresh": "↻",

    "tab.home": "首页",
    "tab.terminal": "终端",
    "tab.claude_new": "Claude (新建)",

    "session.empty": "选择一个工作区",
    "session.load_more": "条",
    "session.remaining": "剩余",
    "session.load": "加载",
    "session.refresh": "↻ 刷新会话",

    "file.empty": "空目录",
    "file.failed": "加载文件失败",

    "settings.title": "设置",
    "settings.shell": "默认 Shell",
    "settings.language": "语言",
    "settings.save": "保存",
    "settings.cancel": "取消",

    "picker.search": "搜索会话...",
    "picker.empty": "没有找到会话",

    "process.exited": "[进程已退出]",
    "shell.failed": "[启动 Shell 失败: $1]",
    "context.rename": "重命名",
    "context.open": "打开",
    "context.copy_abs": "复制绝对路径",
    "context.copy_rel": "复制相对路径",
    "context.refresh": "刷新",
    "context.delete": "删除",
    "toast.deleted": "会话记录已移动到回收站",
  },
};

let lang = "en";

export function t(key: string, ...args: string[]): string {
  let text = dict[lang]?.[key];
  if (!text) {
    // fallback to English
    text = dict["en"]?.[key];
  }
  if (!text) return key;
  for (let i = 0; i < args.length; i++) {
    text = text.replace(`$${i + 1}`, args[i]);
  }
  return text;
}

export function setLang(newLang: string) {
  lang = newLang;
}

export function getLang(): string {
  return lang;
}
