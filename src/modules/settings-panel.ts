import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { tauriInvoke } from "../helpers";
import { t, setLang, getLang } from "../i18n";
import type { AiSettings, AiModelListResponse, SessionProvider } from "../types";
import { buildLocalCliCommand, formatCliArgs, formatCliCommand, parseCliArgs } from "./cli-launch";

type AppTheme = "dark" | "light" | "github-light" | "solarized-light" | "dracula" | "monokai";

export async function _showSettings(app: any, appThemes: Set<AppTheme>) {
  const panel = document.createElement("div");
  panel.className = "settings-panel";
  panel.innerHTML = `
    <div class="settings-title">${t("settings.title")}</div>
    <div class="dialog-scroll">
      <div class="settings-section-title">${t("settings.general_title")}</div>
      <div class="settings-row"><label>${t("settings.shell")}</label><select id="settings-shell"></select></div>
      <div class="settings-row"><label>${t("settings.language")}</label>
        <select id="settings-lang">
          <option value="en">${t("settings.language_en")}</option>
          <option value="zh">${t("settings.language_zh")}</option>
        </select>
      </div>
      <div class="settings-row"><label>${t("settings.theme")}</label>
        <select id="settings-theme">
          <option value="dark">${t("settings.theme_dark")}</option>
          <option value="light">${t("settings.theme_light")}</option>
          <option value="github-light">${t("settings.theme_github_light")}</option>
          <option value="solarized-light">${t("settings.theme_solarized_light")}</option>
          <option value="dracula">${t("settings.theme_dracula")}</option>
          <option value="monokai">${t("settings.theme_monokai")}</option>
        </select>
      </div>
      <div class="settings-section-title">${t("settings.cli_title")}</div>
      <div class="settings-note">${t("settings.cli_help")}</div>
      <div class="settings-row stacked">
        <label for="settings-claude-args">${t("settings.claude_args")}</label>
        <input id="settings-claude-args" autocomplete="off" spellcheck="false" placeholder="${t("settings.claude_args_placeholder")}">
        <div class="settings-cli-preview">
          <div class="settings-cli-preview-row">
            <span>${t("settings.cli_preview_new")}</span>
            <code id="settings-claude-preview-new"></code>
          </div>
          <div class="settings-cli-preview-row">
            <span>${t("settings.cli_preview_resume")}</span>
            <code id="settings-claude-preview-resume"></code>
          </div>
        </div>
      </div>
      <div class="settings-row stacked">
        <label for="settings-codex-args">${t("settings.codex_args")}</label>
        <input id="settings-codex-args" autocomplete="off" spellcheck="false" placeholder="${t("settings.codex_args_placeholder")}">
        <div class="settings-cli-preview">
          <div class="settings-cli-preview-row">
            <span>${t("settings.cli_preview_new")}</span>
            <code id="settings-codex-preview-new"></code>
          </div>
          <div class="settings-cli-preview-row">
            <span>${t("settings.cli_preview_resume")}</span>
            <code id="settings-codex-preview-resume"></code>
          </div>
        </div>
      </div>
      <div class="settings-row stacked">
        <label for="settings-pi-args">${t("settings.pi_args")}</label>
        <input id="settings-pi-args" autocomplete="off" spellcheck="false" placeholder="${t("settings.pi_args_placeholder")}">
        <div class="settings-cli-preview">
          <div class="settings-cli-preview-row">
            <span>${t("settings.cli_preview_new")}</span>
            <code id="settings-pi-preview-new"></code>
          </div>
          <div class="settings-cli-preview-row">
            <span>${t("settings.cli_preview_resume")}</span>
            <code id="settings-pi-preview-resume"></code>
          </div>
        </div>
      </div>
      <div class="settings-status" id="settings-cli-status"></div>
      <div class="settings-section-title">${t("settings.ai_title")}</div>
      <div class="settings-note">${t("settings.ai_help")}</div>
      <div class="settings-row stacked">
        <label for="settings-ai-endpoint">${t("settings.ai_endpoint")}</label>
        <select id="settings-ai-endpoint">
          <option value="openAi">${t("settings.ai_endpoint_openai")}</option>
          <option value="claude">${t("settings.ai_endpoint_claude")}</option>
        </select>
      </div>
      <div class="settings-row stacked">
        <label for="settings-ai-base-url">${t("settings.ai_base_url")}</label>
        <input id="settings-ai-base-url" placeholder="https://api.openai.com/v1">
      </div>
      <div class="settings-row stacked">
        <label for="settings-ai-api-key">${t("settings.ai_api_key")}</label>
        <input id="settings-ai-api-key" type="password" placeholder="sk-...">
      </div>
      <div class="settings-row stacked">
        <label for="settings-ai-model">${t("settings.ai_model")}</label>
        <div class="settings-inline-actions">
          <input id="settings-ai-model" placeholder="${t("settings.ai_model_placeholder")}">
          <button id="settings-ai-load-models" type="button">${t("settings.ai_load_models")}</button>
        </div>
        <div class="settings-model-list hidden" id="settings-ai-model-list"></div>
        <div class="settings-status" id="settings-ai-model-status"></div>
      </div>
      <div class="settings-section-title">${t("settings.logs_title")}</div>
      <div class="settings-row stacked">
        <label for="settings-log-path">${t("settings.log_path")}</label>
        <div class="settings-inline-actions">
          <input id="settings-log-path" readonly value="${t("settings.log_path_unavailable")}">
          <button id="settings-log-open" type="button" disabled>${t("settings.log_path_open")}</button>
        </div>
      </div>
    </div>
    <div class="settings-actions">
      <button id="settings-save">${t("settings.save")}</button>
      <button id="settings-cancel">${t("settings.cancel")}</button>
    </div>`;
  const backdrop = document.createElement("div");
  backdrop.className = "picker-backdrop";
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeydown);
    panel.remove();
    backdrop.remove();
  };
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener("keydown", onKeydown);
  backdrop.addEventListener("click", close);
  document.body.appendChild(backdrop);
  document.body.appendChild(panel);

  const shellSel = panel.querySelector("#settings-shell") as HTMLSelectElement;
  const currentShellOption = document.createElement("option");
  currentShellOption.value = app.shellSetting;
  currentShellOption.textContent = app.shellSetting;
  shellSel.appendChild(currentShellOption);
  (panel.querySelector("#settings-lang") as HTMLSelectElement).value = getLang();
  (panel.querySelector("#settings-theme") as HTMLSelectElement).value = app.theme;
  (panel.querySelector("#settings-claude-args") as HTMLInputElement).value = formatCliArgs(app.claudeArgs || []);
  (panel.querySelector("#settings-codex-args") as HTMLInputElement).value = formatCliArgs(app.codexArgs || []);
  (panel.querySelector("#settings-pi-args") as HTMLInputElement).value = formatCliArgs(app.piArgs || []);

  const previewCwd = app.selectedWorkspace || "WORKSPACE_PATH";
  const previewSessionId = "SESSION_ID";
  const renderCommandPreview = (
    provider: SessionProvider,
    input: HTMLInputElement,
    bin: string,
    newOutput: HTMLElement,
    resumeOutput: HTMLElement,
  ) => {
    try {
      const extraArgs = parseCliArgs(input.value);
      newOutput.textContent = formatCliCommand(
        buildLocalCliCommand(provider, bin, extraArgs, previewCwd),
      );
      resumeOutput.textContent = formatCliCommand(
        buildLocalCliCommand(provider, bin, extraArgs, previewCwd, previewSessionId),
      );
      newOutput.classList.remove("invalid");
      resumeOutput.classList.remove("invalid");
    } catch (_) {
      newOutput.textContent = t("settings.cli_preview_invalid");
      resumeOutput.textContent = t("settings.cli_preview_invalid");
      newOutput.classList.add("invalid");
      resumeOutput.classList.add("invalid");
    }
  };
  const refreshCommandPreviews = () => {
    renderCommandPreview(
      "claude",
      panel.querySelector("#settings-claude-args") as HTMLInputElement,
      app.claudePath || "claude",
      panel.querySelector("#settings-claude-preview-new") as HTMLElement,
      panel.querySelector("#settings-claude-preview-resume") as HTMLElement,
    );
    renderCommandPreview(
      "codex",
      panel.querySelector("#settings-codex-args") as HTMLInputElement,
      app.codexPath || "codex",
      panel.querySelector("#settings-codex-preview-new") as HTMLElement,
      panel.querySelector("#settings-codex-preview-resume") as HTMLElement,
    );
    renderCommandPreview(
      "pi",
      panel.querySelector("#settings-pi-args") as HTMLInputElement,
      app.piPath || "pi",
      panel.querySelector("#settings-pi-preview-new") as HTMLElement,
      panel.querySelector("#settings-pi-preview-resume") as HTMLElement,
    );
  };
  panel.querySelector("#settings-claude-args")!.addEventListener("input", refreshCommandPreviews);
  panel.querySelector("#settings-codex-args")!.addEventListener("input", refreshCommandPreviews);
  panel.querySelector("#settings-pi-args")!.addEventListener("input", refreshCommandPreviews);
  refreshCommandPreviews();

  try {
    const [data, aiSettings] = await Promise.all([
      tauriInvoke<any>("detect_terminals"),
      tauriInvoke<AiSettings>("get_ai_settings"),
    ]);
    shellSel.innerHTML = "";
    for (const s of data.shells || ["zsh"]) {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      if (s === app.shellSetting) opt.selected = true;
      shellSel.appendChild(opt);
    }
    (panel.querySelector("#settings-ai-endpoint") as HTMLSelectElement).value = aiSettings.endpoint || "openAi";
    (panel.querySelector("#settings-ai-base-url") as HTMLInputElement).value = aiSettings.baseUrl || "";
    (panel.querySelector("#settings-ai-api-key") as HTMLInputElement).value = aiSettings.apiKey || "";
    (panel.querySelector("#settings-ai-model") as HTMLInputElement).value = aiSettings.model || "";
  } catch (e) {
    console.error("load_settings failed:", e);
  }

  panel.querySelector("#settings-ai-load-models")!.addEventListener("click", () => app._loadAiModelsForSettings(panel));

  // Logs section — populate the path async; safe if the dir hasn't been
  // created yet (first launch races plugin initialization).
  const logPathInput = panel.querySelector("#settings-log-path") as HTMLInputElement;
  const logOpenBtn = panel.querySelector("#settings-log-open") as HTMLButtonElement;
  tauriInvoke<string>("get_log_dir")
    .then((dir) => {
      if (!dir) return;
      logPathInput.value = dir;
      logOpenBtn.disabled = false;
      logOpenBtn.addEventListener("click", () => {
        revealItemInDir(dir).catch((e) => console.error("reveal log dir failed:", e));
      });
    })
    .catch((e) => console.warn("get_log_dir failed:", e));

  panel.querySelector("#settings-save")!.addEventListener("click", async () => {
    const cliStatus = panel.querySelector("#settings-cli-status") as HTMLElement;
    let claudeArgs: string[];
    let codexArgs: string[];
    let piArgs: string[];
    try {
      claudeArgs = parseCliArgs((panel.querySelector("#settings-claude-args") as HTMLInputElement).value);
    } catch (_) {
      cliStatus.className = "settings-status error";
      cliStatus.textContent = t("settings.cli_args_invalid", "Claude");
      return;
    }
    try {
      codexArgs = parseCliArgs((panel.querySelector("#settings-codex-args") as HTMLInputElement).value);
    } catch (_) {
      cliStatus.className = "settings-status error";
      cliStatus.textContent = t("settings.cli_args_invalid", "Codex");
      return;
    }
    try {
      piArgs = parseCliArgs((panel.querySelector("#settings-pi-args") as HTMLInputElement).value);
    } catch (_) {
      cliStatus.className = "settings-status error";
      cliStatus.textContent = t("settings.cli_args_invalid", "pi");
      return;
    }

    const newShell = (panel.querySelector("#settings-shell") as HTMLSelectElement).value;
    const newLang = (panel.querySelector("#settings-lang") as HTMLSelectElement).value;
    const selectedTheme = (panel.querySelector("#settings-theme") as HTMLSelectElement).value as AppTheme;
    const newTheme = appThemes.has(selectedTheme) ? selectedTheme : "dark";
    const aiSettings: AiSettings = {
      endpoint: ((panel.querySelector("#settings-ai-endpoint") as HTMLSelectElement).value === "claude") ? "claude" : "openAi",
      baseUrl: (panel.querySelector("#settings-ai-base-url") as HTMLInputElement).value.trim(),
      apiKey: (panel.querySelector("#settings-ai-api-key") as HTMLInputElement).value.trim(),
      model: (panel.querySelector("#settings-ai-model") as HTMLInputElement).value.trim(),
    };
    try {
      await Promise.all([
        tauriInvoke("save_settings", { settings: { shell: newShell, language: newLang, claudeArgs, codexArgs, piArgs } }),
        tauriInvoke("save_ai_settings", { settings: aiSettings }),
      ]);
    } catch (e) {
      console.error("save_settings failed:", e);
      cliStatus.className = "settings-status error";
      cliStatus.textContent = t("settings.save_failed", String(e));
      return;
    }
    app.shellSetting = newShell;
    app.claudeArgs = claudeArgs;
    app.codexArgs = codexArgs;
    app.piArgs = piArgs;
    setLang(newLang);
    app._setTheme(newTheme);
    close();
    app._updateStaticTexts();
    app._createStartTab();
    app._renderWorkspaces();
    app._scheduleSaveAppState();
  });
  panel.querySelector("#settings-cancel")!.addEventListener("click", close);
}

export async function _loadAiModelsForSettings(app: any, panel: HTMLElement) {
  const status = panel.querySelector("#settings-ai-model-status") as HTMLElement | null;
  const list = panel.querySelector("#settings-ai-model-list") as HTMLElement | null;
  const loadButton = panel.querySelector("#settings-ai-load-models") as HTMLButtonElement | null;
  if (!status || !list || !loadButton) return;

  const settings: AiSettings = {
    endpoint: ((panel.querySelector("#settings-ai-endpoint") as HTMLSelectElement).value === "claude") ? "claude" : "openAi",
    baseUrl: (panel.querySelector("#settings-ai-base-url") as HTMLInputElement).value.trim(),
    apiKey: (panel.querySelector("#settings-ai-api-key") as HTMLInputElement).value.trim(),
    model: (panel.querySelector("#settings-ai-model") as HTMLInputElement).value.trim(),
  };

  loadButton.disabled = true;
  status.className = "settings-status";
  status.textContent = t("settings.ai_loading_models");
  try {
    const response = await tauriInvoke<AiModelListResponse>("list_ai_models", { settings });
    const baseUrlInput = panel.querySelector("#settings-ai-base-url") as HTMLInputElement;
    const modelInput = panel.querySelector("#settings-ai-model") as HTMLInputElement;
    baseUrlInput.value = response.baseUrl;
    app._renderAiModelList(list, modelInput, response.models);
    if (!modelInput.value && response.models.length > 0) {
      modelInput.value = response.models[0];
    }
    status.className = "settings-status success";
    status.textContent = t("settings.ai_models_loaded", String(response.models.length), response.baseUrl);
  } catch (e) {
    status.className = "settings-status error";
    status.textContent = t("settings.ai_models_failed", String(e));
  } finally {
    loadButton.disabled = false;
  }
}

export function _renderAiModelList(app: any, list: HTMLElement, modelInput: HTMLInputElement, models: string[]) {
  list.innerHTML = "";
  list.classList.toggle("hidden", models.length === 0);
  for (const model of models) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "settings-model-item";
    item.textContent = model;
    item.addEventListener("click", () => {
      modelInput.value = model;
      for (const sibling of list.querySelectorAll(".settings-model-item.selected")) {
        sibling.classList.remove("selected");
      }
      item.classList.add("selected");
      modelInput.focus();
    });
    if (modelInput.value === model) item.classList.add("selected");
    list.appendChild(item);
  }
}
