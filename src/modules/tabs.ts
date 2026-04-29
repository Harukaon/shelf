import { TabInfo } from "../types";

export class TabManager {
  private tabs = new Map<string, TabInfo>();
  private activeTabId: string | null = null;

  constructor(
    private tabListEl: HTMLElement,
    private terminalContainer: HTMLElement,
    private renderTabs: () => void,
    private renderWorkspaces: () => void,
    private onActivateTab?: (tab: TabInfo) => void,
  ) {}

  get tabsMap() {
    return this.tabs;
  }
  get activeId() {
    return this.activeTabId;
  }

  addTab(tab: TabInfo, activate = true) {
    this.tabs.set(tab.id, tab);
    if (activate || !this.activeTabId) this.activateTab(tab.id);
    this.renderTabs();
    this.renderWorkspaces();
  }

  activateTab(tabId: string) {
    if (this.activeTabId === tabId) return;
    this.tabs.forEach((t) => {
      t.containerEl.style.display = "none";
    });
    const tab = this.tabs.get(tabId);
    if (tab) {
      tab.containerEl.style.display = "block";
      if (tab.fitAddon) {
        try {
          tab.fitAddon.fit();
          tab.terminal.focus();
        } catch (_) {}
      }
      if (this.onActivateTab) this.onActivateTab(tab);
    }
    this.activeTabId = tabId;
    this.renderTabs();
    this.renderWorkspaces();
  }

  closeTab(tabId: string, onEmpty?: () => void) {
    const tab = this.tabs.get(tabId);
    if (!tab || !tab.closable) return;
    if (tab.pty) {
      try {
        tab.pty.kill();
      } catch (_) {}
    }
    if (tab.terminal) tab.terminal.dispose();
    tab.containerEl.remove();
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) {
      const remaining = Array.from(this.tabs.keys()).filter((id) => id !== "__start__");
      if (remaining.length > 0) {
        this.activateTab(remaining[remaining.length - 1]);
      } else if (onEmpty) {
        onEmpty();
      }
    }
    this.renderTabs();
    this.renderWorkspaces();
  }

  switchToStartPage(startTabId: string) {
    this.tabs.forEach((t) => {
      t.containerEl.style.display = "none";
    });
    const start = this.tabs.get(startTabId);
    if (start) start.containerEl.style.display = "block";
    this.activeTabId = startTabId;
    this.renderTabs();
    this.renderWorkspaces();
  }

  setInitActiveTab(tabId: string) {
    this.activeTabId = tabId;
  }

  getActiveTab(): TabInfo | undefined {
    return this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
  }

  getTabOrder(): string[] {
    return Array.from(this.tabs.keys());
  }

  moveTab(tabId: string, toIndex: number) {
    const order = this.getTabOrder().filter(id => id !== tabId);
    order.splice(toIndex, 0, tabId);
    const newMap = new Map<string, TabInfo>();
    for (const id of order) {
      const tab = this.tabs.get(id);
      if (tab) newMap.set(id, tab);
    }
    this.tabs = newMap;
    this.renderTabs();
    this.renderWorkspaces();
  }
}
