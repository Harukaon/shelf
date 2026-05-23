import { tauriInvoke, refreshIcons, escapeHtml } from "../helpers";
import { t } from "../i18n";
import { showToast } from "./toast";
import type { SshTarget } from "../types";

interface FilePreview {
  content: string;
  size: number;
  truncated: boolean;
  is_binary: boolean;
}

const MAX_PREVIEWABLE_LINES = 20_000;

export async function openFilePreview(filePath: string, ssh?: SshTarget): Promise<void> {
  if (document.querySelector(".file-preview-panel")) return; // single preview at a time

  const fileName = filePath.split(/[/\\]/).pop() || filePath;

  const panel = document.createElement("div");
  panel.className = "file-preview-panel";
  panel.innerHTML = `
    <div class="file-preview-header">
      <i data-lucide="file" class="file-preview-icon"></i>
      <div class="file-preview-title">
        <span class="file-preview-name">${escapeHtml(fileName)}</span>
        <span class="file-preview-path" title="${escapeHtml(filePath)}">${escapeHtml(filePath)}</span>
      </div>
      <span class="file-preview-meta" id="fp-meta"></span>
      <button class="file-preview-close" type="button" title="${t("settings.cancel")}">
        <i data-lucide="x"></i>
      </button>
    </div>
    <div class="file-preview-body" id="fp-body">
      <div class="file-preview-state"><i data-lucide="loader" class="spin"></i> ${t("session.loading")}</div>
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
    if (e.key === "Escape") { e.preventDefault(); close(); }
  };
  document.addEventListener("keydown", onKeydown);
  backdrop.addEventListener("click", close);
  panel.querySelector(".file-preview-close")!.addEventListener("click", close);

  document.body.appendChild(backdrop);
  document.body.appendChild(panel);
  refreshIcons();

  const meta = panel.querySelector<HTMLSpanElement>("#fp-meta")!;
  const body = panel.querySelector<HTMLDivElement>("#fp-body")!;

  try {
    const result = await tauriInvoke<FilePreview>("read_text_file", { path: filePath, ssh: ssh || null });
    if (closed) return;
    renderPreview(body, meta, result);
  } catch (e) {
    if (closed) return;
    body.innerHTML = `<div class="file-preview-state error">${escapeHtml(t("file.failed"))}: ${escapeHtml(String(e))}</div>`;
    showToast(`${t("file.failed")}: ${String(e)}`, { variant: "error" });
  }
}

function renderPreview(body: HTMLElement, meta: HTMLElement, result: FilePreview): void {
  meta.textContent = formatSize(result.size) + (result.truncated ? ` · ${t("file.preview_truncated")}` : "");

  if (result.is_binary) {
    body.innerHTML = `<div class="file-preview-state">${escapeHtml(t("file.preview_binary"))}</div>`;
    return;
  }

  // Normalize CRLF and strip a single trailing newline so we don't render an
  // empty last gutter line.
  let content = result.content.replace(/\r\n/g, "\n");
  if (content.endsWith("\n")) content = content.slice(0, -1);

  const lines = content.split("\n");
  const totalLines = lines.length;
  const renderLines = lines.slice(0, MAX_PREVIEWABLE_LINES);
  if (totalLines > MAX_PREVIEWABLE_LINES) {
    meta.textContent += ` · ${t("file.preview_line_cap", String(MAX_PREVIEWABLE_LINES), String(totalLines))}`;
  }

  const numbers = renderLines.map((_, i) => String(i + 1)).join("\n");
  const code = renderLines.join("\n");

  body.innerHTML = `
    <pre class="file-preview-gutter">${escapeHtml(numbers)}</pre>
    <pre class="file-preview-code">${escapeHtml(code)}</pre>`;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

const TEXT_EXTENSIONS = new Set([
  "txt", "log", "md", "markdown", "rst", "csv", "tsv", "tex",
  "json", "json5", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties",
  "xml", "xsd", "xsl", "html", "htm", "svg",
  "css", "scss", "sass", "less", "styl",
  "js", "jsx", "mjs", "cjs", "ts", "tsx",
  "vue", "svelte", "astro",
  "py", "rb", "php", "pl", "pm", "lua",
  "go", "rs", "c", "h", "cc", "cpp", "cxx", "hpp", "hxx", "m", "mm",
  "java", "kt", "kts", "groovy", "scala", "clj", "cljs", "edn",
  "cs", "fs", "fsi", "vb",
  "swift", "dart",
  "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd",
  "dockerfile", "containerfile", "makefile", "mk", "cmake", "gradle", "bazel", "buck",
  "graphql", "gql", "proto", "thrift", "capnp",
  "sql", "psql", "mysql",
  "rml", "patch", "diff",
  "ipynb", "r", "rmd",
  "gitignore", "gitattributes", "editorconfig", "prettierrc", "eslintrc", "nvmrc",
  "lock",
]);

// Filenames that don't have a useful extension but are still text.
const TEXT_FILENAMES = new Set([
  "readme", "license", "licence", "copying", "authors", "contributors", "changelog", "notice",
  "makefile", "dockerfile", "containerfile", "vagrantfile", "procfile", "rakefile", "gemfile",
  "cargo.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock",
  ".gitignore", ".gitattributes", ".editorconfig", ".nvmrc", ".prettierrc", ".eslintrc",
  ".env", ".envrc", ".bashrc", ".zshrc", ".profile",
]);

/**
 * Best-effort guess for whether a filename looks like a text file. We err on
 * the side of "yes" — the backend will detect actual binaries by sniffing
 * for a NUL byte and the preview UI will show a "binary file" placeholder
 * for those.
 */
export function looksLikeTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (TEXT_FILENAMES.has(lower)) return true;
  const dot = lower.lastIndexOf(".");
  if (dot < 0) {
    // No extension: most likely a script / config / readme — let backend decide.
    return true;
  }
  const ext = lower.slice(dot + 1);
  return TEXT_EXTENSIONS.has(ext);
}
