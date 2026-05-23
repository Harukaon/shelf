import { tauriInvoke } from "../helpers";
import { t, setLang, getLang } from "../i18n";
import type { AiSettings, AiModelListResponse } from "../types";

type AppTheme = "dark" | "light" | "github-light" | "solarized-light" | "dracula" | "monokai";

export async function _showSettings(app: any, appThemes: Set<AppTheme>) {
  const panel = document.createElement("div");
  panel.className = "settings-panel";
  panel.innerHTML = `
    <div class="settings-title">${t("settings.title")}</div>
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

  try {
    const [data, aiSettings] = await Promise.all([
      tauriInvoke<any>("detect_terminals"),
      tauriInvoke<AiSettings>("get_ai_settings"),
    ]);
    const shellSel = panel.querySelector("#settings-shell") as HTMLSelectElement;
    shellSel.innerHTML = "";
    for (const s of data.shells || ["zsh"]) {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      if (s === app.shellSetting) opt.selected = true;
      shellSel.appendChild(opt);
    }
    const langSel = panel.querySelector("#settings-lang") as HTMLSelectElement;
    langSel.value = getLang();
    const themeSel = panel.querySelector("#settings-theme") as HTMLSelectElement;
    themeSel.value = app.theme;
    (panel.querySelector("#settings-ai-endpoint") as HTMLSelectElement).value = aiSettings.endpoint || "openAi";
    (panel.querySelector("#settings-ai-base-url") as HTMLInputElement).value = aiSettings.baseUrl || "";
    (panel.querySelector("#settings-ai-api-key") as HTMLInputElement).value = aiSettings.apiKey || "";
    (panel.querySelector("#settings-ai-model") as HTMLInputElement).value = aiSettings.model || "";
  } catch (e) {
    console.error("load_settings failed:", e);
  }

  panel.querySelector("#settings-ai-load-models")!.addEventListener("click", () => app._loadAiModelsForSettings(panel));

  panel.querySelector("#settings-save")!.addEventListener("click", async () => {
    app.shellSetting = (panel.querySelector("#settings-shell") as HTMLSelectElement).value;
    const newLang = (panel.querySelector("#settings-lang") as HTMLSelectElement).value;
    const selectedTheme = (panel.querySelector("#settings-theme") as HTMLSelectElement).value as AppTheme;
    const newTheme = appThemes.has(selectedTheme) ? selectedTheme : "dark";
    setLang(newLang);
    app._setTheme(newTheme);
    const aiSettings: AiSettings = {
      endpoint: ((panel.querySelector("#settings-ai-endpoint") as HTMLSelectElement).value === "claude") ? "claude" : "openAi",
      baseUrl: (panel.querySelector("#settings-ai-base-url") as HTMLInputElement).value.trim(),
      apiKey: (panel.querySelector("#settings-ai-api-key") as HTMLInputElement).value.trim(),
      model: (panel.querySelector("#settings-ai-model") as HTMLInputElement).value.trim(),
    };
    try {
      await Promise.all([
        tauriInvoke("save_settings", { settings: { shell: app.shellSetting, language: newLang } }),
        tauriInvoke("save_ai_settings", { settings: aiSettings }),
      ]);
    } catch (e) {
      console.error("save_settings failed:", e);
    }
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
