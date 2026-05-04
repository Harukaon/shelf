import { TabInfo } from "../types";
import { flushTabBuffer, repaintTerminal } from "./terminal";

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
    if (!activate && this.activeTabId) this.renderTabs();
    this.renderWorkspaces();
  }

  activateTab(tabId: string) {
    if (this.activeTabId === tabId) return;
    const prev = this.tabs.get(this.activeTabId || "");
    if (prev?.terminal) try { prev.terminal.blur(); } catch (_) {}
    this.tabs.forEach((t) => {
      t.containerEl.style.visibility = "hidden";
      t.containerEl.style.pointerEvents = "none";
      t.active = false;
    });
    const tab = this.tabs.get(tabId);
    if (tab) {
      tab.containerEl.style.visibility = "visible";
      tab.containerEl.style.pointerEvents = "auto";
      tab.active = true;
      flushTabBuffer(tab);
      repaintTerminal(tab);
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
    if (tab.resizeObserver) tab.resizeObserver.disconnect();
    if (tab.resizeTimer) clearTimeout(tab.resizeTimer);
    if (tab.ptyResizeTimer) clearTimeout(tab.ptyResizeTimer);
    if (tab.resizeFrame) cancelAnimationFrame(tab.resizeFrame);
    if (tab.resizeFinalFrame) cancelAnimationFrame(tab.resizeFinalFrame);
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

  async closeAllPtys() {
    const tasks: Promise<void>[] = [];
    for (const tab of this.tabs.values()) {
      if (tab.pty) tasks.push(tab.pty.killAndWait());
    }
    await Promise.allSettled(tasks);
  }

  switchToStartPage(startTabId: string) {
    this.tabs.forEach((t) => {
      t.containerEl.style.visibility = "hidden";
      t.containerEl.style.pointerEvents = "none";
      t.active = false;
    });
    const start = this.tabs.get(startTabId);
    if (start) {
      start.containerEl.style.visibility = "visible";
      start.containerEl.style.pointerEvents = "auto";
      start.active = true;
    }
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

  reorderSilent(tabId: string, newIndex: number) {
    const order = this.getTabOrder().filter(id => id !== tabId);
    order.splice(newIndex, 0, tabId);
    const newMap = new Map<string, TabInfo>();
    for (const id of order) {
      const tab = this.tabs.get(id);
      if (tab) newMap.set(id, tab);
    }
    this.tabs = newMap;
  }
}
