import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { escapeHtml, refreshIcons, tauriInvoke } from "../helpers";
import { t } from "../i18n";
import type { AiHistoryMessage, AiRunResponse, ShellCommandApproval } from "../types";

type AiStreamEvent = {
  kind: "text" | "tool-start" | "tool-end" | "tool-result" | "shell-approval" | "error" | "done";
  id?: string | null;
  text?: string | null;
  tool?: string | null;
};

export type AiToolMessage = {
  id: string;
  tool: string;
  el: HTMLElement;
  statusEl: HTMLElement;
  codeEl: HTMLElement;
  actionsEl?: HTMLElement;
  approval?: ShellCommandApproval;
};

export type AiStreamUnlisten = UnlistenFn;

export function _toggleAiWindow(app: any) {
  if (app.aiWindowEl) {
    const hidden = app.aiWindowEl.classList.toggle("hidden");
    app.aiBtn.classList.toggle("active", !hidden);
    return;
  }
  app._createAiWindow();
  app.aiBtn.classList.add("active");
}

export function _createAiWindow(app: any) {
  const panel = document.createElement("div");
  panel.className = "ai-window";
  panel.innerHTML = `
    <div class="ai-window-header">
      <div class="ai-window-title"><i data-lucide="bot"></i><span>${t("ai.title")}</span></div>
      <div class="ai-window-actions">
        <label class="ai-trust-toggle" title="${t("ai.shell_trust_hint")}">
          <input id="ai-shell-trust" type="checkbox">
          <span>${t("ai.shell_trust")}</span>
        </label>
        <button class="ai-icon-btn" id="ai-clear" title="${t("ai.clear")}"><i data-lucide="trash-2"></i></button>
        <button class="ai-icon-btn" id="ai-close" title="${t("ai.close")}"><i data-lucide="x"></i></button>
      </div>
    </div>
    <div class="ai-window-body">
      <div class="ai-log" id="ai-log"></div>
      <div class="ai-compose">
        <textarea id="ai-input" placeholder="${t("ai.placeholder")}"></textarea>
        <button class="ai-send-btn" id="ai-send">${t("ai.send")}</button>
      </div>
    </div>`;
  document.body.appendChild(panel);
  app.aiWindowEl = panel;
  app.aiLogEl = panel.querySelector("#ai-log") as HTMLElement;
  app.aiInputEl = panel.querySelector("#ai-input") as HTMLTextAreaElement;
  const trustToggle = panel.querySelector("#ai-shell-trust") as HTMLInputElement | null;
  if (trustToggle) {
    trustToggle.checked = app.aiShellAutoApprove;
    trustToggle.addEventListener("change", () => {
      app.aiShellAutoApprove = trustToggle.checked;
    });
  }

  panel.querySelector("#ai-close")!.addEventListener("click", () => {
    panel.classList.add("hidden");
    app.aiBtn.classList.remove("active");
  });
  panel.querySelector("#ai-clear")!.addEventListener("click", () => app._clearAiHistory());
  panel.querySelector("#ai-send")!.addEventListener("click", () => {
    if (app.aiBusy) app._stopAiRun();
    else app._sendAiMessage();
  });
  app.aiInputEl.addEventListener("compositionstart", () => { app.aiInputComposing = true; });
  app.aiInputEl.addEventListener("compositionend", () => { app.aiInputComposing = false; });
  app.aiInputEl.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !app.aiInputComposing && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      app._sendAiMessage();
    }
  });
  app._setupAiWindowDragging(panel);
  app._appendAiMessage("system", t("ai.intro"));
  refreshIcons();
}

export function _setupAiWindowDragging(app: any, panel: HTMLElement) {
  const header = panel.querySelector(".ai-window-header") as HTMLElement | null;
  if (!header) return;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let dragging = false;

  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const nextLeft = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, startLeft + e.clientX - startX));
    const nextTop = Math.max(44, Math.min(window.innerHeight - panel.offsetHeight - 8, startTop + e.clientY - startY));
    panel.style.left = `${nextLeft}px`;
    panel.style.top = `${nextTop}px`;
    panel.style.right = "auto";
  };
  const onUp = () => {
    dragging = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  header.addEventListener("pointerdown", (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const rect = panel.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    dragging = true;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

export async function _sendAiMessage(app: any) {
  if (app.aiBusy || !app.aiInputEl) return;
  const message = app.aiInputEl.value.trim();
  if (!message) return;
  app.aiInputEl.value = "";
  app._appendAiMessage("user", message);
  const history = app.aiHistory.slice();
  app.aiHistory.push({ role: "user", content: message });
  await app._runAiTurn(message, history, true);
}

export async function _stopAiRun(app: any) {
  if (!app.aiBusy) return;
  try {
    await tauriInvoke("stop_ai_organizer");
    app._setAiSending(false);
  } catch (e) {
    console.error("[Shelf] stop AI failed:", e);
  }
}

export async function _runAiTurn(app: any, message: string, history: AiHistoryMessage[], rollbackUserOnError = false) {
  app.aiStreamAssistantMsg = null;
  app.aiStreamTools.clear();
  app.aiBusy = true;
  app.aiPendingShellApproval = false;
  app._setAiSending(true);

  try {
    await app._listenToAiStream();
    const active = app.tabs.getActiveTab();
    const response = await tauriInvoke<AiRunResponse>("run_ai_organizer", {
      request: {
        message,
        history,
        workspacePath: app.selectedWorkspace || active?.workspacePath || null,
        provider: active?.sessionProvider || app.ws.selectedProvider || null,
        shellAutoApprove: app.aiShellAutoApprove,
      },
    });
    app.aiSessionMap = response.map;
    if (!app.aiStreamAssistantMsg && response.message) {
      app._appendAiTextDelta(response.message);
    }
    app._renderTabs();
    app._renderWorkspaces();
  } catch (e) {
    if (app._isShellApprovalInterrupt(e)) {
      app.aiPendingShellApproval = true;
    } else if (app._isAiCancelled(e)) {
      app._appendAiMessage("system", t("ai.stopped"));
    } else {
      if (rollbackUserOnError) app.aiHistory.pop();
      app._appendAiMessage("assistant", t("ai.failed", String(e)));
    }
  } finally {
    app._stopAiStreamListener();
    app.aiStreamAssistantMsg = null;
    app.aiBusy = false;
    app._setAiSending(false);
  }
}

export function _isShellApprovalInterrupt(app: any, error: unknown): boolean {
  return String(error).includes("SHELF_SHELL_APPROVAL_REQUIRED:");
}

export function _isAiCancelled(app: any, error: unknown): boolean {
  return String(error).includes("SHELF_AI_CANCELLED:");
}

export function _setAiSending(app: any, sending: boolean) {
  const send = app.aiWindowEl?.querySelector("#ai-send") as HTMLButtonElement | null;
  const clear = app.aiWindowEl?.querySelector("#ai-clear") as HTMLButtonElement | null;
  if (send) {
    send.disabled = false;
    send.classList.toggle("stop", sending);
    send.textContent = sending ? t("ai.stop") : t("ai.send");
  }
  if (clear) clear.disabled = sending;
}

export function _appendAiMessage(app: any, role: "user" | "assistant" | "system", text: string): HTMLElement {
  if (!app.aiLogEl) return document.createElement("div");
  const msg = document.createElement("div");
  msg.className = `ai-msg ${role}`;
  msg.textContent = text;
  app.aiLogEl.appendChild(msg);
  app.aiLogEl.scrollTop = app.aiLogEl.scrollHeight;
  return msg;
}

export async function _listenToAiStream(app: any) {
  app._stopAiStreamListener();
  app.aiStreamUnlisten = await listen<AiStreamEvent>("shelf://ai-stream", (event) => {
    const payload = event.payload;
    if (payload.kind === "text" && payload.text) {
      app._appendAiTextDelta(payload.text);
    } else if (payload.kind === "tool-start") {
      app._appendAiToolCall(payload.id || crypto.randomUUID(), payload.tool || "tool", payload.text || "");
    } else if (payload.kind === "tool-end") {
      app._finishAiToolCall(payload.id || "", payload.tool || "tool", payload.text || "");
    } else if (payload.kind === "tool-result") {
      app._setAiToolResult(payload.id || "", payload.text || "");
    } else if (payload.kind === "shell-approval") {
      app._showShellApproval(payload.id || "", payload.tool || "run_shell_command", payload.text || "");
    } else if (payload.kind === "error" && payload.text) {
      app._appendAiMessage("assistant", payload.text);
    }
  });
}

export function _stopAiStreamListener(app: any) {
  if (!app.aiStreamUnlisten) return;
  app.aiStreamUnlisten();
  app.aiStreamUnlisten = null;
}

export function _appendAiTextDelta(app: any, text: string) {
  const target = app._ensureStreamingAssistantMessage();
  const textEl = app._ensureAiTextEl(target);
  textEl.textContent = `${textEl.textContent || ""}${text}`;
  app._syncStreamingAssistantHistory(textEl.textContent || "");
  if (app.aiLogEl) app.aiLogEl.scrollTop = app.aiLogEl.scrollHeight;
}

export function _syncStreamingAssistantHistory(app: any, content: string) {
  const last = app.aiHistory[app.aiHistory.length - 1];
  if (last?.role === "assistant") {
    last.content = content;
  } else {
    app.aiHistory.push({ role: "assistant", content });
  }
}

export function _ensureStreamingAssistantMessage(app: any): HTMLElement {
  if (!app.aiStreamAssistantMsg) {
    app.aiStreamAssistantMsg = app._appendAiMessage("assistant", "");
  }
  return app.aiStreamAssistantMsg;
}

export function _ensureAiTextEl(app: any, target: HTMLElement): HTMLElement {
  let textEl = target.querySelector(".ai-msg-text") as HTMLElement | null;
  if (!textEl) {
    textEl = document.createElement("div");
    textEl.className = "ai-msg-text";
    const textNodes = Array.from(target.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE);
    textEl.textContent = textNodes.map((node) => node.textContent || "").join("");
    for (const node of textNodes) node.remove();
    target.appendChild(textEl);
  }
  return textEl;
}

export function _clearAiHistory(app: any) {
  if (app.aiBusy || !app.aiLogEl) return;
  app.aiHistory = [];
  app.aiLogEl.innerHTML = "";
}

export function _appendAiToolCall(app: any, id: string, tool: string, args: string) {
  if (!app.aiLogEl) return;
  app.aiStreamAssistantMsg = null;
  const msg = document.createElement("div");
  msg.className = "ai-msg tool";
  msg.innerHTML = `
    <div class="ai-tool-header">
      <span class="ai-tool-name">${escapeHtml(tool)}</span>
      <span class="ai-tool-state">${escapeHtml(t("ai.tool_running"))}</span>
    </div>
    <details class="ai-tool-details">
      <summary>${escapeHtml(t("ai.tool_details"))}</summary>
      <pre><code class="ai-tool-json">${escapeHtml(app._formatJsonLike(args))}</code></pre>
    </details>`;
  app.aiLogEl.appendChild(msg);

  const toolMessage = {
    id,
    tool,
    el: msg,
    statusEl: msg.querySelector(".ai-tool-state") as HTMLElement,
    codeEl: msg.querySelector(".ai-tool-json") as HTMLElement,
    actionsEl: undefined,
  };
  app.aiStreamTools.set(id, toolMessage);
  app.aiLogEl.scrollTop = app.aiLogEl.scrollHeight;
}

export function _finishAiToolCall(app: any, id: string, tool: string, result: string) {
  const toolMessage = app._getOrCreateToolMessage(id, tool);
  toolMessage.statusEl.textContent = t("ai.tool_done");
  toolMessage.el.classList.add("done");
  if (result) {
    toolMessage.codeEl.textContent = app._formatJsonLike(result);
    app._recordAiToolHistory(tool, result);
  }
  if (app.aiLogEl) app.aiLogEl.scrollTop = app.aiLogEl.scrollHeight;
}

export function _setAiToolResult(app: any, id: string, result: string) {
  const toolMessage = app._getOrCreateToolMessage(id, "tool");
  if (result) {
    toolMessage.codeEl.textContent = app._formatJsonLike(result);
    app._recordAiToolHistory(toolMessage.tool, result);
  }
  if (app.aiLogEl) app.aiLogEl.scrollTop = app.aiLogEl.scrollHeight;
}

export function _recordAiToolHistory(app: any, tool: string, content: string) {
  const last = app.aiHistory[app.aiHistory.length - 1];
  if (last?.role === "tool" && last.tool === tool && last.content === content) return;
  app.aiHistory.push({ role: "tool", tool, content });
}

export function _showShellApproval(app: any, id: string, tool: string, value: string) {
  const approval = app._parseShellApproval(value);
  if (!approval) return;
  const toolMessage = app._getOrCreateToolMessage(id, tool);
  toolMessage.approval = approval;
  toolMessage.statusEl.textContent = t("ai.shell_approval_required");
  toolMessage.el.classList.add("approval");
  toolMessage.codeEl.textContent = app._formatJsonLike(JSON.stringify(approval));

  let actions = toolMessage.actionsEl;
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "ai-tool-actions";
    toolMessage.el.appendChild(actions);
    toolMessage.actionsEl = actions;
  }
  actions.innerHTML = `
    <button class="ai-tool-approve" title="${escapeHtml(t("ai.shell_approve"))}">✓</button>
    <button class="ai-tool-deny" title="${escapeHtml(t("ai.shell_deny"))}">×</button>`;
  actions.querySelector(".ai-tool-approve")!.addEventListener("click", () => app._approveShellCommand(toolMessage));
  actions.querySelector(".ai-tool-deny")!.addEventListener("click", () => app._denyShellCommand(toolMessage));
  if (app.aiLogEl) app.aiLogEl.scrollTop = app.aiLogEl.scrollHeight;
}

export function _parseShellApproval(app: any, value: string): ShellCommandApproval | null {
  try {
    return JSON.parse(value) as ShellCommandApproval;
  } catch (_) {
    return null;
  }
}

export async function _approveShellCommand(app: any, toolMessage: AiToolMessage) {
  if (!toolMessage.approval || app.aiBusy) return;
  const approval = toolMessage.approval;
  toolMessage.statusEl.textContent = t("ai.shell_running");
  toolMessage.actionsEl?.querySelectorAll("button").forEach((button) => {
    (button as HTMLButtonElement).disabled = true;
  });
  try {
    const result = await tauriInvoke<unknown>("execute_approved_shell_command", {
      args: {
        command: approval.command,
        cwd: approval.cwd,
        timeoutMs: approval.timeoutMs,
        maxBytes: approval.maxBytes,
        maxLines: approval.maxLines,
        approved: true,
      },
    });
    const resultText = JSON.stringify(result, null, 2);
    toolMessage.statusEl.textContent = t("ai.tool_done");
    toolMessage.el.classList.add("done");
    toolMessage.actionsEl?.remove();
    toolMessage.actionsEl = undefined;
    toolMessage.codeEl.textContent = resultText;
    app._recordAiToolHistory(toolMessage.tool, resultText);
    await app._continueAfterToolResult();
  } catch (e) {
    toolMessage.statusEl.textContent = t("ai.failed", String(e));
    toolMessage.el.classList.add("error");
    toolMessage.actionsEl?.querySelectorAll("button").forEach((button) => {
      (button as HTMLButtonElement).disabled = false;
    });
  }
}

export function _denyShellCommand(app: any, toolMessage: AiToolMessage) {
  toolMessage.statusEl.textContent = t("ai.shell_denied");
  toolMessage.el.classList.add("denied");
  toolMessage.actionsEl?.remove();
  toolMessage.actionsEl = undefined;
  app.aiPendingShellApproval = false;
}

export async function _continueAfterToolResult(app: any) {
  app.aiPendingShellApproval = false;
  const history = app.aiHistory.slice();
  const message = "Continue from the approved shell command result.";
  await app._runAiTurn(message, history, false);
}

export function _getOrCreateToolMessage(app: any, id: string, tool: string): AiToolMessage {
  const existing = app.aiStreamTools.get(id);
  if (existing) return existing;
  const fallbackId = id || crypto.randomUUID();
  app._appendAiToolCall(fallbackId, tool, "");
  return app.aiStreamTools.get(fallbackId)!;
}

export function _formatJsonLike(app: any, value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch (_) {
    return value;
  }
}
