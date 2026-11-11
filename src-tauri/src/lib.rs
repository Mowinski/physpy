//! Backend: file IO and running the Python transpiler (`python -m physpy`).
//!
//! Configuration (environment variables):
//! - `PHYSPY_PYTHON` - Python interpreter (default: `python3`, `python` on Windows)
//! - `PHYSPY_PATH`   - directory containing the `physpy` package
//!                     (default: bundled resource, falling back to `../transpiler/src` in dev)

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};

#[derive(Serialize)]
pub struct RunOutput {
    stdout: String,
    stderr: String,
    code: Option<i32>,
}

#[derive(Serialize, Deserialize)]
pub struct TableColumn {
    name: String,
    unit: Option<String>,
    is_numeric: bool,
}

#[derive(Serialize, Deserialize)]
pub struct TableRow {
    index: String,
    cells: Vec<String>,
}

#[derive(Serialize, Deserialize)]
pub struct TableOutput {
    index_name: String,
    columns: Vec<TableColumn>,
    rows: Vec<TableRow>,
    total_rows: usize,
    truncated: bool,
    raw_text: String,
}

#[derive(Serialize, Deserialize)]
pub struct CellOutput {
    stdout: String,
    stderr: String,
    code: i32,
    exported: HashMap<String, String>,
    all_exports: HashMap<String, String>,
    #[serde(default)]
    plots: Vec<String>,
    #[serde(default)]
    latex: Option<String>,
    #[serde(default)]
    tables: Vec<TableOutput>,
    #[serde(default)]
    non_table_stdout: Option<String>,
}

#[derive(Serialize)]
pub struct DirEntryItem {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize, Clone)]
pub struct PythonInterpreterInfo {
    path: String,
    version: String,
    label: String,
}

#[derive(Serialize)]
pub struct PythonListResponse {
    current: String,
    interpreters: Vec<PythonInterpreterInfo>,
}

#[derive(Serialize, Deserialize)]
pub struct AiAssistResult {
    code: String,
    #[serde(default)]
    explanation: String,
    #[serde(default)]
    model: String,
}

#[derive(Serialize, Deserialize)]
pub struct GeminiModelInfo {
    id: String,
    display_name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppConfig {
    pub font_family: String,
    pub font_size: f64,
    pub matrix_font_size: f64,
    pub line_numbers: bool,
    pub python_path: String,
    pub startup_dir: String,
    /// `restore` | `empty` | `demo` | `file`
    pub startup_mode: String,
    pub startup_file: String,
    /// `off` | `afterDelay` | `onFocusChange` | `onWindowChange`
    pub auto_save: String,
    pub auto_save_delay: u64,
    pub ai_provider: String,
    pub ai_model: String,
    pub ai_api_key: String,
    pub ai_system_prompt: String,
    pub resolved_startup_dir: String,
    pub global_config_path: String,
    pub workspace_config_path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ConfigScopeData {
    pub scope: String,
    pub file_path: String,
    pub exists: bool,
    pub raw_yaml: String,
    pub parsed: AppConfig,
    pub effective: AppConfig,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct InstallResult {
    pub success: bool,
    pub log: String,
    pub requirements_file_written: bool,
}

struct WorkerProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl WorkerProcess {
    fn spawn() -> Result<Self, String> {
        let python = python_exe();
        let mut child = Command::new(&python)
            .arg("-m")
            .arg("physpy")
            .arg("worker")
            .env("PYTHONPATH", transpiler_path())
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Cannot start Python ('{python}'): {e}. Set PHYSPY_PYTHON."))?;

        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = BufReader::new(child.stdout.take().expect("stdout is piped"));
        Ok(Self {
            child,
            stdin,
            stdout,
        })
    }

    fn send(&mut self, req: &serde_json::Value) -> Result<serde_json::Value, String> {
        let mut line = serde_json::to_string(req).map_err(|e| e.to_string())?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.flush())
            .map_err(|e| e.to_string())?;

        let mut resp_line = String::new();
        const RPC_PREFIX: &str = "__PHYSPY_RPC_RES__:";
        loop {
            resp_line.clear();
            let n = self
                .stdout
                .read_line(&mut resp_line)
                .map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("Python worker exited unexpectedly".into());
            }
            let trimmed = resp_line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Some(json_payload) = trimmed.strip_prefix(RPC_PREFIX) {
                return serde_json::from_str(json_payload).map_err(|e| {
                    format!("Malformed RPC JSON response: {e}\nRaw: {json_payload}")
                });
            }
            // Fallback for backwards compatibility if no prefix
            if trimmed.starts_with('{') && trimmed.ends_with('}') {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    if val.get("ok").is_some() {
                        return Ok(val);
                    }
                }
            }
            // Non-RPC output (stray prints, C-library messages, background thread logs)
            eprintln!("[Python worker log] {trimmed}");
        }
    }
}

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// Directory put on PYTHONPATH (must contain the `physpy` package). Resolved once at startup.
static TRANSPILER_PATH: OnceLock<PathBuf> = OnceLock::new();
static WORKER: OnceLock<Mutex<Option<WorkerProcess>>> = OnceLock::new();
static SELECTED_PYTHON: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn selected_python_mutex() -> &'static Mutex<Option<String>> {
    SELECTED_PYTHON.get_or_init(|| Mutex::new(None))
}

fn worker_mutex() -> &'static Mutex<Option<WorkerProcess>> {
    WORKER.get_or_init(|| Mutex::new(None))
}

fn with_worker<T>(f: impl FnOnce(&mut WorkerProcess) -> Result<T, String>) -> Result<T, String> {
    let mut guard = worker_mutex().lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(WorkerProcess::spawn()?);
    }
    let res = f(guard.as_mut().unwrap());
    if res.is_err() {
        // Respawn on next call if the worker died
        *guard = None;
    }
    res
}

fn python_exe() -> String {
    if let Ok(guard) = selected_python_mutex().lock() {
        if let Some(chosen) = guard.as_ref() {
            return chosen.clone();
        }
    }
    if let Ok(p) = std::env::var("PHYSPY_PYTHON") {
        return p;
    }
    if cfg!(windows) {
        return "python".to_string();
    }
    // Prefer the project venv or standard macOS/Linux Python installations with scientific packages
    // over Xcode's minimal `/usr/bin/python3` when launched from Finder.
    let venv_py = Path::new(env!("CARGO_MANIFEST_DIR")).join("../transpiler/.venv/bin/python3");
    for candidate in [
        venv_py.as_path(),
        Path::new("/usr/local/bin/python3"),
        Path::new("/opt/homebrew/bin/python3"),
    ] {
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    "python3".to_string()
}

fn normalize_interpreter_path(path: &Path) -> PathBuf {
    if let Ok(canon_parent) = std::fs::canonicalize(path.parent().unwrap_or(Path::new("."))) {
        if let Some(file_name) = path.file_name() {
            return canon_parent.join(file_name);
        }
    }
    path.to_path_buf()
}

fn probe_python(path: &str) -> Result<PythonInterpreterInfo, String> {
    let out = Command::new(path)
        .arg("-c")
        .arg("import sys; print(sys.version.split()[0])")
        .output()
        .map_err(|e| format!("Cannot execute '{path}': {e}"))?;
    if !out.status.success() {
        return Err(format!("'{path}' exited with status {}", out.status));
    }
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let norm_path = normalize_interpreter_path(Path::new(path)).to_string_lossy().into_owned();
    let label = if path.contains(".venv") || path.contains("/venv/") {
        format!("Python {version} (venv)")
    } else if path.contains("homebrew") {
        format!("Python {version} (Homebrew)")
    } else if path.contains("conda") || path.contains("miniforge") {
        format!("Python {version} (Conda)")
    } else {
        format!("Python {version}")
    };
    Ok(PythonInterpreterInfo {
        path: norm_path,
        version,
        label,
    })
}

/// `PHYSPY_PATH` > bundled resource (`<resources>/physpy`) > source tree (dev).
fn resolve_transpiler_path(app: &tauri::App) -> PathBuf {
    if let Some(p) = std::env::var_os("PHYSPY_PATH") {
        return PathBuf::from(p);
    }
    if let Ok(dir) = app.path().resource_dir() {
        if dir.join("physpy").join("__init__.py").is_file() {
            return dir;
        }
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../transpiler/src")
}

fn transpiler_path() -> &'static Path {
    TRANSPILER_PATH.get().expect("initialized in setup()")
}

/// Runs `python -m physpy <args>` with `stdin` piped in.
fn physpy(args: &[String], stdin: &str, cwd: Option<&Path>) -> Result<RunOutput, String> {
    let python = python_exe();
    let mut cmd = Command::new(&python);
    cmd.arg("-m")
        .arg("physpy")
        .args(args)
        .env("PYTHONPATH", transpiler_path())
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Cannot start Python ('{python}'): {e}. Set PHYSPY_PYTHON."))?;

    child
        .stdin
        .take()
        .expect("stdin is piped")
        .write_all(stdin.as_bytes())
        .map_err(|e| e.to_string())?;

    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok(RunOutput {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        code: out.status.code(),
    })
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn run_cell(
    source: String,
    path: Option<String>,
    cwd: Option<String>,
    cell_index: usize,
    doc_source: Option<String>,
) -> Result<CellOutput, String> {
    blocking(move || {
        with_worker(|w| {
            let resp = w.send(&serde_json::json!({
                "cmd": "run_cell",
                "source": source,
                "path": path,
                "cwd": cwd,
                "cell_index": cell_index,
                "doc_source": doc_source.unwrap_or_default(),
            }))?;
            if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
                return Err(resp
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("worker error")
                    .to_string());
            }
            serde_json::from_value(resp).map_err(|e| e.to_string())
        })
    })
    .await
}

#[tauri::command]
async fn reset_session() -> Result<(), String> {
    blocking(move || {
        with_worker(|w| {
            w.send(&serde_json::json!({ "cmd": "reset" }))?;
            Ok(())
        })
    })
    .await
}

#[tauri::command]
async fn run_code(source: String, path: Option<String>) -> Result<RunOutput, String> {
    blocking(move || {
        let mut args = vec!["run".to_string(), "-".to_string()];
        let cwd = path
            .as_ref()
            .and_then(|p| Path::new(p).parent().map(Path::to_path_buf));
        if let Some(p) = &path {
            args.extend(["--filename".to_string(), p.clone()]);
        }
        physpy(&args, &source, cwd.as_deref())
    })
    .await
}

#[tauri::command]
async fn transpile(source: String) -> Result<String, String> {
    blocking(move || {
        let out = physpy(&["transpile".into(), "-".into()], &source, None)?;
        if out.code == Some(0) {
            Ok(out.stdout)
        } else {
            Err(out.stderr)
        }
    })
    .await
}

#[tauri::command]
async fn ai_assist(
    prompt: String,
    cell_source: String,
    context_before: String,
    exports: HashMap<String, String>,
    workspace_dir: Option<String>,
) -> Result<AiAssistResult, String> {
    blocking(move || {
        let cfg = resolve_hierarchical_config(workspace_dir);
        let payload = serde_json::json!({
            "provider": cfg.ai_provider,
            "model": cfg.ai_model,
            "api_key": cfg.ai_api_key,
            "custom_system_prompt": cfg.ai_system_prompt,
            "prompt": prompt,
            "cell_source": cell_source,
            "context_before": context_before,
            "exports": exports,
        });
        let out = physpy(&["ai".into()], &payload.to_string(), None)?;
        let raw = out.stdout.trim();
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(raw) {
            if val.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                return serde_json::from_value(val).map_err(|e| e.to_string());
            }
            if let Some(err) = val.get("error").and_then(|v| v.as_str()) {
                return Err(err.to_string());
            }
        }
        if !out.stderr.trim().is_empty() {
            return Err(out.stderr.trim().to_string());
        }
        Err("AI request failed".to_string())
    })
    .await
}

#[tauri::command]
async fn list_ai_models(
    api_key: Option<String>,
    workspace_dir: Option<String>,
) -> Result<Vec<GeminiModelInfo>, String> {
    blocking(move || {
        let cfg = resolve_hierarchical_config(workspace_dir);
        let effective_key = api_key
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty())
            .unwrap_or(cfg.ai_api_key);
        let payload = serde_json::json!({
            "action": "list_models",
            "provider": cfg.ai_provider,
            "api_key": effective_key,
        });
        let out = physpy(&["ai".into()], &payload.to_string(), None)?;
        let raw = out.stdout.trim();
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(raw) {
            if val.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                let models_val = val
                    .get("models")
                    .cloned()
                    .unwrap_or_else(|| serde_json::Value::Array(vec![]));
                return serde_json::from_value(models_val).map_err(|e| e.to_string());
            }
            if let Some(err) = val.get("error").and_then(|v| v.as_str()) {
                return Err(err.to_string());
            }
        }
        if !out.stderr.trim().is_empty() {
            return Err(out.stderr.trim().to_string());
        }
        Err("Failed to list Gemini models".to_string())
    })
    .await
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn read_binary_file(path: String, base_dir: Option<String>) -> Result<Vec<u8>, String> {
    let p = Path::new(&path);
    let resolved = if p.is_absolute() {
        p.to_path_buf()
    } else if let Some(base) = base_dir {
        Path::new(&base).join(p)
    } else {
        p.to_path_buf()
    };
    std::fs::read(&resolved).map_err(|e| format!("{}: {e}", resolved.display()))
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn write_binary_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, bytes).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to).map_err(|e| format!("{from} -> {to}: {e}"))
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| format!("{path}: {e}"))
    } else {
        std::fs::remove_file(p).map_err(|e| format!("{path}: {e}"))
    }
}

const DEFAULT_GLOBAL_CONFIG_YAML: &str = "\
# PhysPy Global Configuration (~/.physpy/config.yaml)
# Settings here can be overridden per workspace by creating `.physpy-config.yaml` in a folder.

# 1. Editor font family, size (px), and matrix KaTeX font size (%)
font_family: 'ui-monospace, \"SF Mono\", Menlo, Consolas, monospace'
font_size: 14.5
matrix_font_size: 135

# 2. Show line numbers in notebook cells (true / false)
line_numbers: true

# 3. Default Python interpreter path (leave empty for automatic detection)
python_path: \"\"

# 4. Default directory where PhysPy opens on startup (~ expands to $HOME)
startup_dir: \"~\"

# 5. What to open on startup: restore (restore open tabs/folders) | empty (clean untitled notebook) | demo (demo.ppy) | file (specific file path)
startup_mode: restore
startup_file: \"\"

# 6. Auto Save: off (never) | afterDelay (every X ms) | onFocusChange | onWindowChange
auto_save: off
auto_save_delay: 1000

# 7. AI Cell Assistant (currently Gemini; set GEMINI_API_KEY env var or paste key below)
ai_provider: gemini
ai_model: gemini-3.8-flash
ai_api_key: \"\"
ai_system_prompt: \"\"
";

fn home_dir_path() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
}

fn expand_config_path(raw: &str, base_dir: Option<&Path>) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed == "~" {
        if let Some(h) = home_dir_path() {
            return h.to_string_lossy().into_owned();
        }
    } else if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        if let Some(h) = home_dir_path() {
            return h.join(rest).to_string_lossy().into_owned();
        }
    }
    if let Some(rest) = trimmed.strip_prefix("$HOME/").or_else(|| trimmed.strip_prefix("$HOME_DIR/")) {
        if let Some(h) = home_dir_path() {
            return h.join(rest).to_string_lossy().into_owned();
        }
    } else if trimmed == "$HOME" || trimmed == "$HOME_DIR" {
        if let Some(h) = home_dir_path() {
            return h.to_string_lossy().into_owned();
        }
    }
    let p = Path::new(trimmed);
    if !p.is_absolute() {
        if let Some(base) = base_dir {
            return base.join(p).to_string_lossy().into_owned();
        }
    }
    trimmed.to_string()
}

fn strip_yaml_inline_comment(val: &str) -> &str {
    let mut in_single = false;
    let mut in_double = false;
    let bytes = val.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'\'' if !in_double => in_single = !in_single,
            b'"' if !in_single => in_double = !in_double,
            b'#' if !in_single && !in_double => {
                if i == 0 || bytes[i - 1].is_ascii_whitespace() {
                    return val[..i].trim();
                }
            }
            _ => {}
        }
    }
    val.trim()
}

fn unquote_yaml_scalar(raw: &str) -> String {
    let s = strip_yaml_inline_comment(raw).trim();
    if s.len() >= 2 {
        if (s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')) {
            let inner = &s[1..s.len() - 1];
            return inner.replace("\\\"", "\"").replace("''", "'");
        }
    }
    s.to_string()
}

fn parse_yaml_bool(val: &str) -> Option<bool> {
    match val.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "on" | "1" => Some(true),
        "false" | "no" | "off" | "0" => Some(false),
        _ => None,
    }
}

fn apply_yaml_config_str(yaml_src: &str, base_dir: Option<&Path>, cfg: &mut AppConfig) {
    let mut current_section = String::new();
    for raw_line in yaml_src.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = raw_line.len() - raw_line.trim_start().len();
        if indent == 0 {
            current_section.clear();
        }
        let Some((k_raw, v_raw)) = trimmed.split_once(':') else {
            continue;
        };
        let key = k_raw.trim();
        let val_cleaned = strip_yaml_inline_comment(v_raw);
        if val_cleaned.is_empty() && indent == 0 {
            current_section = key.to_ascii_lowercase();
            continue;
        }
        let scalar = unquote_yaml_scalar(v_raw);
        let full_key = if indent > 0 && !current_section.is_empty() {
            format!("{}.{}", current_section, key)
        } else {
            key.to_string()
        };

        match full_key.as_str() {
            "font_family" | "fontFamily" | "editor.font_family" | "editor.fontFamily" => {
                if !scalar.is_empty() {
                    cfg.font_family = scalar;
                }
            }
            "font_size" | "fontSize" | "editor.font_size" | "editor.fontSize" => {
                let num_str = scalar.trim_end_matches("px").trim();
                if let Ok(sz) = num_str.parse::<f64>() {
                    if (8.0..=48.0).contains(&sz) {
                        cfg.font_size = sz;
                    }
                }
            }
            "matrix_font_size" | "matrixFontSize" | "editor.matrix_font_size" | "editor.matrixFontSize" => {
                let num_str = scalar.trim_end_matches('%').trim();
                if let Ok(sz) = num_str.parse::<f64>() {
                    if (50.0..=300.0).contains(&sz) {
                        cfg.matrix_font_size = sz;
                    }
                }
            }
            "line_numbers"
            | "lineNumbers"
            | "show_line_numbers"
            | "editor.line_numbers"
            | "editor.lineNumbers" => {
                if let Some(b) = parse_yaml_bool(&scalar) {
                    cfg.line_numbers = b;
                }
            }
            "python_path"
            | "pythonPath"
            | "default_python"
            | "python"
            | "python.path"
            | "python.python_path" => {
                cfg.python_path = expand_config_path(&scalar, base_dir);
            }
            "startup_dir"
            | "startupDir"
            | "default_dir"
            | "open_dir"
            | "workspace_dir"
            | "workspace.startup_dir"
            | "workspace.default_dir"
            | "workspace.path" => {
                if !scalar.is_empty() {
                    cfg.startup_dir = scalar.clone();
                    let expanded = expand_config_path(&scalar, base_dir);
                    if !expanded.is_empty() && Path::new(&expanded).is_dir() {
                        cfg.resolved_startup_dir = expanded;
                    }
                }
            }
            "startup_mode" | "startupMode" | "startup.mode" => {
                let m = scalar.trim().to_ascii_lowercase();
                if matches!(m.as_str(), "restore" | "empty" | "demo" | "file") {
                    cfg.startup_mode = m;
                }
            }
            "startup_file" | "startupFile" | "startup.file" => {
                cfg.startup_file = expand_config_path(&scalar, base_dir);
            }
            "auto_save" | "autoSave" | "autosave" | "files.autoSave" => {
                let m = scalar.trim().to_ascii_lowercase();
                let normalized = match m.as_str() {
                    "off" | "never" | "false" => "off",
                    "afterdelay" | "after_delay" | "delay" => "afterDelay",
                    "onfocuschange" | "on_focus_change" | "focus" => "onFocusChange",
                    "onwindowchange" | "on_window_change" | "window" => "onWindowChange",
                    _ => "off",
                };
                cfg.auto_save = normalized.to_string();
            }
            "auto_save_delay" | "autoSaveDelay" | "autosave_delay" | "files.autoSaveDelay" => {
                if let Ok(ms) = scalar.trim().parse::<u64>() {
                    cfg.auto_save_delay = ms.max(100);
                }
            }
            "ai_provider" | "aiProvider" | "ai.provider" => {
                if !scalar.is_empty() {
                    cfg.ai_provider = scalar.trim().to_ascii_lowercase();
                }
            }
            "ai_model" | "aiModel" | "ai.model" | "gemini_model" => {
                if !scalar.is_empty() {
                    cfg.ai_model = scalar;
                }
            }
            "ai_api_key" | "aiApiKey" | "ai.api_key" | "gemini_api_key" => {
                cfg.ai_api_key = scalar;
            }
            "ai_system_prompt" | "aiSystemPrompt" | "ai.system_prompt" => {
                cfg.ai_system_prompt = scalar;
            }
            _ => {}
        }
    }
}

fn resolve_hierarchical_config(workspace_dir: Option<String>) -> AppConfig {
    let home = home_dir_path();
    let default_startup = home
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".".to_string());

    let global_config_file = home
        .as_ref()
        .map(|h| h.join(".physpy").join("config.yaml"))
        .unwrap_or_else(|| PathBuf::from(".physpy/config.yaml"));

    // Create default `$HOME/.physpy/config.yaml` on first run if missing
    if !global_config_file.exists() {
        if let Some(parent) = global_config_file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&global_config_file, DEFAULT_GLOBAL_CONFIG_YAML);
    }

    let mut cfg = AppConfig {
        font_family: "ui-monospace, \"SF Mono\", Menlo, Consolas, monospace".to_string(),
        font_size: 14.5,
        matrix_font_size: 135.0,
        line_numbers: true,
        python_path: String::new(),
        startup_dir: "~".to_string(),
        startup_mode: "restore".to_string(),
        startup_file: String::new(),
        auto_save: "off".to_string(),
        auto_save_delay: 1000,
        ai_provider: "gemini".to_string(),
        ai_model: "gemini-3.8-flash".to_string(),
        ai_api_key: String::new(),
        ai_system_prompt: String::new(),
        resolved_startup_dir: default_startup,
        global_config_path: global_config_file.to_string_lossy().into_owned(),
        workspace_config_path: None,
    };

    // 1. Load global `$HOME/.physpy/config.yaml`
    if let Ok(global_text) = std::fs::read_to_string(&global_config_file) {
        apply_yaml_config_str(&global_text, home.as_deref(), &mut cfg);
    }

    // 2. Determine active folder to check for `.physpy-config.yaml`
    let active_dir = workspace_dir
        .filter(|s| !s.trim().is_empty())
        .map(|s| expand_config_path(&s, home.as_deref()))
        .unwrap_or_else(|| cfg.resolved_startup_dir.clone());

    let active_path = PathBuf::from(&active_dir);
    for candidate_name in [".physpy-config.yaml", ".physpy-config.yml"] {
        let ws_cfg_path = active_path.join(candidate_name);
        if ws_cfg_path.is_file() {
            if let Ok(ws_text) = std::fs::read_to_string(&ws_cfg_path) {
                apply_yaml_config_str(&ws_text, Some(&active_path), &mut cfg);
                cfg.workspace_config_path = Some(ws_cfg_path.to_string_lossy().into_owned());
            }
            break;
        }
    }

    cfg
}

#[tauri::command]
fn load_config(workspace_dir: Option<String>) -> Result<AppConfig, String> {
    Ok(resolve_hierarchical_config(workspace_dir))
}

fn format_config_yaml_template(scope_title: &str, cfg: &AppConfig) -> String {
    let escaped_font = cfg.font_family.replace('\'', "''");
    let escaped_py = cfg.python_path.replace('"', "\\\"");
    let escaped_dir = cfg.startup_dir.replace('"', "\\\"");
    let escaped_file = cfg.startup_file.replace('"', "\\\"");
    let escaped_model = cfg.ai_model.replace('"', "\\\"");
    let escaped_sys = cfg.ai_system_prompt.replace('"', "\\\"");
    format!(
        "# {scope_title}\n\n\
# 1. Editor font family, size (px), and matrix KaTeX font size (%)\n\
font_family: '{escaped_font}'\n\
font_size: {}\n\
matrix_font_size: {}\n\n\
# 2. Show line numbers in notebook cells (true / false)\n\
line_numbers: {}\n\n\
# 3. Default Python interpreter path (leave empty for automatic detection)\n\
python_path: \"{escaped_py}\"\n\n\
# 4. Default directory where PhysPy opens on startup (~ expands to $HOME)\n\
startup_dir: \"{escaped_dir}\"\n\n\
# 5. What to open on startup: restore (previous session) | empty (nothing) | demo (demo.ppy) | file (startup_file)\n\
startup_mode: {}\n\
startup_file: \"{escaped_file}\"\n\n\
# 6. Auto Save: off (never) | afterDelay (every X ms) | onFocusChange | onWindowChange\n\
auto_save: {}\n\
auto_save_delay: {}\n\n\
# 7. AI Cell Assistant (keep ai_api_key in global ~/.physpy/config.yaml)\n\
ai_provider: {}\n\
ai_model: \"{escaped_model}\"\n\
ai_system_prompt: \"{escaped_sys}\"\n",
        cfg.font_size,
        cfg.matrix_font_size,
        cfg.line_numbers,
        cfg.startup_mode,
        cfg.auto_save,
        cfg.auto_save_delay,
        cfg.ai_provider
    )
}

#[tauri::command]
fn read_config_scope(
    scope: String,
    workspace_dir: Option<String>,
) -> Result<ConfigScopeData, String> {
    let effective = resolve_hierarchical_config(workspace_dir.clone());
    let home = home_dir_path();

    if scope == "workspace" {
        let active_dir = workspace_dir
            .filter(|s| !s.trim().is_empty())
            .map(|s| expand_config_path(&s, home.as_deref()))
            .unwrap_or_else(|| effective.resolved_startup_dir.clone());
        let active_path = PathBuf::from(&active_dir);
        let yml_alt = active_path.join(".physpy-config.yml");
        let target_path = if yml_alt.is_file() {
            yml_alt
        } else {
            active_path.join(".physpy-config.yaml")
        };
        let exists = target_path.is_file();
        let raw_yaml = if exists {
            std::fs::read_to_string(&target_path).unwrap_or_default()
        } else {
            format_config_yaml_template(
                "PhysPy Workspace Configuration (.physpy-config.yaml)",
                &effective,
            )
        };
        let mut parsed = effective.clone();
        apply_yaml_config_str(&raw_yaml, Some(&active_path), &mut parsed);
        Ok(ConfigScopeData {
            scope: "workspace".to_string(),
            file_path: target_path.to_string_lossy().into_owned(),
            exists,
            raw_yaml,
            parsed,
            effective,
        })
    } else {
        let global_path = PathBuf::from(&effective.global_config_path);
        let exists = global_path.is_file();
        let raw_yaml = if exists {
            std::fs::read_to_string(&global_path)
                .unwrap_or_else(|_| DEFAULT_GLOBAL_CONFIG_YAML.to_string())
        } else {
            DEFAULT_GLOBAL_CONFIG_YAML.to_string()
        };
        let mut parsed = AppConfig {
            font_family: "ui-monospace, \"SF Mono\", Menlo, Consolas, monospace".to_string(),
            font_size: 14.5,
            matrix_font_size: 135.0,
            line_numbers: true,
            python_path: String::new(),
            startup_dir: "~".to_string(),
            startup_mode: "restore".to_string(),
            startup_file: String::new(),
            auto_save: "off".to_string(),
            auto_save_delay: 1000,
            ai_provider: "gemini".to_string(),
            ai_model: "gemini-3.8-flash".to_string(),
            ai_api_key: String::new(),
            ai_system_prompt: String::new(),
            resolved_startup_dir: effective.resolved_startup_dir.clone(),
            global_config_path: effective.global_config_path.clone(),
            workspace_config_path: effective.workspace_config_path.clone(),
        };
        apply_yaml_config_str(&raw_yaml, home.as_deref(), &mut parsed);
        Ok(ConfigScopeData {
            scope: "global".to_string(),
            file_path: global_path.to_string_lossy().into_owned(),
            exists,
            raw_yaml,
            parsed,
            effective,
        })
    }
}

#[tauri::command]
fn save_config_scope(
    scope: String,
    workspace_dir: Option<String>,
    raw_yaml: String,
) -> Result<ConfigScopeData, String> {
    let current_eff = resolve_hierarchical_config(workspace_dir.clone());
    let home = home_dir_path();

    let target_path = if scope == "workspace" {
        let active_dir = workspace_dir
            .clone()
            .filter(|s| !s.trim().is_empty())
            .map(|s| expand_config_path(&s, home.as_deref()))
            .unwrap_or_else(|| current_eff.resolved_startup_dir.clone());
        let active_path = PathBuf::from(&active_dir);
        let yml_alt = active_path.join(".physpy-config.yml");
        if yml_alt.is_file() {
            yml_alt
        } else {
            active_path.join(".physpy-config.yaml")
        }
    } else {
        PathBuf::from(&current_eff.global_config_path)
    };

    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    std::fs::write(&target_path, &raw_yaml)
        .map_err(|e| format!("{}: {e}", target_path.display()))?;

    read_config_scope(scope, workspace_dir)
}

#[tauri::command]
async fn pick_file_with_hidden(default_dir: Option<String>) -> Result<Option<String>, String> {
    blocking(move || {
        #[cfg(target_os = "macos")]
        {
            let start_dir = default_dir
                .filter(|s| !s.trim().is_empty())
                .map(|s| expand_config_path(&s, home_dir_path().as_deref()))
                .filter(|s| Path::new(s).is_dir())
                .or_else(|| home_dir_path().map(|p| p.to_string_lossy().into_owned()));

            let script = if let Some(dir) = start_dir {
                let escaped = dir.replace('\\', "\\\\").replace('"', "\\\"");
                format!(
                    "POSIX path of (choose file with prompt \"Select File (hidden folders like .venv are visible)\" default location (POSIX file \"{escaped}\") with invisibles and showing package contents)"
                )
            } else {
                "POSIX path of (choose file with prompt \"Select File (hidden folders like .venv are visible)\" with invisibles and showing package contents)".to_string()
            };

            let out = Command::new("osascript").arg("-e").arg(&script).output();
            if let Ok(res) = out {
                if res.status.success() {
                    let chosen = String::from_utf8_lossy(&res.stdout).trim().to_string();
                    if !chosen.is_empty() {
                        return Ok(Some(chosen));
                    }
                } else {
                    // User cancelled (-128)
                    return Ok(None);
                }
            }
        }
        Ok(None)
    })
    .await
}

#[tauri::command]
async fn pick_folder_with_hidden(default_dir: Option<String>) -> Result<Option<String>, String> {
    blocking(move || {
        #[cfg(target_os = "macos")]
        {
            let start_dir = default_dir
                .filter(|s| !s.trim().is_empty())
                .map(|s| expand_config_path(&s, home_dir_path().as_deref()))
                .filter(|s| Path::new(s).is_dir())
                .or_else(|| home_dir_path().map(|p| p.to_string_lossy().into_owned()));

            let script = if let Some(dir) = start_dir {
                let escaped = dir.replace('\\', "\\\\").replace('"', "\\\"");
                format!(
                    "POSIX path of (choose folder with prompt \"Select Folder (hidden folders are visible)\" default location (POSIX file \"{escaped}\") with invisibles and showing package contents)"
                )
            } else {
                "POSIX path of (choose folder with prompt \"Select Folder (hidden folders are visible)\" with invisibles and showing package contents)".to_string()
            };

            let out = Command::new("osascript").arg("-e").arg(&script).output();
            if let Ok(res) = out {
                if res.status.success() {
                    let mut chosen = String::from_utf8_lossy(&res.stdout).trim().to_string();
                    if chosen.len() > 1 && chosen.ends_with('/') {
                        chosen.pop();
                    }
                    if !chosen.is_empty() {
                        return Ok(Some(chosen));
                    }
                } else {
                    return Ok(None);
                }
            }
        }
        Ok(None)
    })
    .await
}

#[tauri::command]
fn initial_root_dir() -> Result<String, String> {
    let cfg = resolve_hierarchical_config(None);
    if Path::new(&cfg.resolved_startup_dir).is_dir() {
        return Ok(cfg.resolved_startup_dir);
    }
    if let Some(home) = home_dir_path() {
        return Ok(home.to_string_lossy().into_owned());
    }
    if let Ok(cwd) = std::env::current_dir() {
        let s = cwd.to_string_lossy();
        // macOS sets cwd to "/" when launching a `.app` bundle from Finder.
        if cwd != Path::new("/") && !s.contains(".app/Contents") {
            return Ok(s.into_owned());
        }
    }
    Ok(".".to_string())
}

const IGNORED_NAMES: &[&str] = &[
    ".git",
    ".DS_Store",
    "node_modules",
    "target",
    ".venv",
    "__pycache__",
    ".pytest_cache",
];

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntryItem>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))?;
    let mut items: Vec<DirEntryItem> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if IGNORED_NAMES.contains(&name.as_str()) {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        items.push(DirEntryItem {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
        });
    }
    items.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(items)
}

#[tauri::command]
async fn list_python_interpreters(
    workspace_dir: Option<String>,
) -> Result<PythonListResponse, String> {
    blocking(move || {
        let current = python_exe();
        let mut candidates: Vec<PathBuf> = Vec::new();

        candidates.push(PathBuf::from(&current));
        if let Some(ws) = workspace_dir {
            let ws_path = PathBuf::from(ws);
            candidates.push(ws_path.join(".venv/bin/python3"));
            candidates.push(ws_path.join("venv/bin/python3"));
            candidates.push(ws_path.join("transpiler/.venv/bin/python3"));
        }
        candidates.push(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../transpiler/.venv/bin/python3"),
        );
        for std_path in [
            "/usr/local/bin/python3",
            "/opt/homebrew/bin/python3",
            "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
            "/usr/bin/python3",
        ] {
            candidates.push(PathBuf::from(std_path));
        }

        if let Some(home) = std::env::var_os("HOME") {
            let home_path = PathBuf::from(home);
            for base in ["miniconda3/envs", "miniforge3/envs", "anaconda3/envs", ".pyenv/versions"]
            {
                if let Ok(entries) = std::fs::read_dir(home_path.join(base)) {
                    for e in entries.flatten() {
                        candidates.push(e.path().join("bin/python3"));
                    }
                }
            }
        }

        let mut seen = std::collections::HashSet::new();
        let mut interpreters = Vec::new();
        for cand in candidates {
            let s = cand.to_string_lossy().into_owned();
            if !cand.is_file() && s != current {
                continue;
            }
            // Deduplicate by exact path string so venv symlinks remain distinct from system python
            let norm = if cand.exists() {
                normalize_interpreter_path(&cand).to_string_lossy().into_owned()
            } else {
                s.clone()
            };
            if !seen.insert(norm.clone()) {
                continue;
            }
            if let Ok(info) = probe_python(&norm) {
                interpreters.push(info);
            }
        }

        let active_norm = normalize_interpreter_path(Path::new(&current))
            .to_string_lossy()
            .into_owned();

        if !interpreters.iter().any(|i| i.path == active_norm) {
            if let Ok(info) = probe_python(&active_norm) {
                interpreters.insert(0, info);
            }
        }

        Ok(PythonListResponse {
            current: active_norm,
            interpreters,
        })
    })
    .await
}

#[tauri::command]
async fn set_python_interpreter(path: String) -> Result<PythonInterpreterInfo, String> {
    blocking(move || {
        let trimmed = path.trim().to_string();
        if trimmed.is_empty() {
            return Err("Python path cannot be empty".into());
        }
        let info = probe_python(&trimmed)?;
        let mut changed = false;
        {
            let mut sel = selected_python_mutex().lock().map_err(|e| e.to_string())?;
            if sel.as_deref() != Some(info.path.as_str()) {
                *sel = Some(info.path.clone());
                changed = true;
            }
        }
        if changed {
            // Restart the persistent worker so it runs on the newly chosen interpreter
            let mut guard = worker_mutex().lock().map_err(|e| e.to_string())?;
            *guard = None;
        }
        Ok(info)
    })
    .await
}

fn find_uv_exe() -> Option<PathBuf> {
    if let Ok(out) = Command::new("uv").arg("--version").output() {
        if out.status.success() {
            return Some(PathBuf::from("uv"));
        }
    }
    let mut candidates = Vec::new();
    if let Some(home) = home_dir_path() {
        candidates.push(home.join(".local/bin/uv"));
        candidates.push(home.join(".cargo/bin/uv"));
    }
    candidates.push(PathBuf::from("/usr/local/bin/uv"));
    candidates.push(PathBuf::from("/opt/homebrew/bin/uv"));
    for c in candidates {
        if c.is_file() {
            return Some(c);
        }
    }
    None
}

fn get_python_exe_in_venv(venv_dir: &Path) -> Option<PathBuf> {
    let unix_candidates = [
        venv_dir.join("bin/python3"),
        venv_dir.join("bin/python"),
    ];
    for c in unix_candidates {
        if c.is_file() {
            return Some(c);
        }
    }
    let win_candidates = [
        venv_dir.join("Scripts/python.exe"),
        venv_dir.join("python.exe"),
    ];
    for c in win_candidates {
        if c.is_file() {
            return Some(c);
        }
    }
    None
}

fn relative_path(from: &Path, to: &Path) -> PathBuf {
    if let Ok(rel) = to.strip_prefix(from) {
        if rel.as_os_str().is_empty() {
            PathBuf::from(".")
        } else {
            rel.to_path_buf()
        }
    } else {
        let from_components: Vec<_> = from.components().collect();
        let to_components: Vec<_> = to.components().collect();
        let mut common = 0;
        while common < from_components.len()
            && common < to_components.len()
            && from_components[common] == to_components[common]
        {
            common += 1;
        }
        let mut rel = PathBuf::new();
        for _ in common..from_components.len() {
            rel.push("..");
        }
        for c in &to_components[common..] {
            rel.push(c.as_os_str());
        }
        if rel.as_os_str().is_empty() {
            PathBuf::from(".")
        } else {
            rel
        }
    }
}

#[tauri::command]
async fn create_venv(
    base_dir: String,
    name: Option<String>,
) -> Result<PythonInterpreterInfo, String> {
    blocking(move || {
        let base = Path::new(&base_dir);
        if !base.is_dir() {
            return Err(format!("Base directory does not exist: {base_dir}"));
        }
        let venv_name = name.unwrap_or_else(|| ".venv".to_string());
        let target_dir = base.join(&venv_name);

        let uv_opt = find_uv_exe();
        let output = if let Some(ref uv) = uv_opt {
            Command::new(uv)
                .arg("venv")
                .arg(&target_dir)
                .current_dir(base)
                .output()
                .map_err(|e| format!("Failed to run uv venv: {e}"))?
        } else {
            let base_py = python_exe();
            Command::new(base_py)
                .arg("-m")
                .arg("venv")
                .arg(&target_dir)
                .current_dir(base)
                .output()
                .map_err(|e| format!("Failed to run python -m venv: {e}"))?
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Failed to create virtualenv: {stderr}"));
        }

        let py_exe = get_python_exe_in_venv(&target_dir)
            .ok_or_else(|| format!("Created venv but python executable not found in {}", target_dir.display()))?;

        let info = probe_python(&py_exe.to_string_lossy())?;

        // Switch active interpreter to this new venv
        {
            let mut sel = selected_python_mutex().lock().map_err(|e| e.to_string())?;
            *sel = Some(info.path.clone());
        }
        {
            let mut guard = worker_mutex().lock().map_err(|e| e.to_string())?;
            *guard = None;
        }

        Ok(info)
    })
    .await
}

#[tauri::command]
async fn install_requirements(
    python_path: String,
    requirements: String,
    base_dir: Option<String>,
    sync_file: bool,
) -> Result<InstallResult, String> {
    blocking(move || {
        let req_content = requirements.trim().to_string();
        let mut req_file_written = false;

        let req_path = if let Some(ref dir) = base_dir {
            let p = Path::new(dir).join("requirements.txt");
            if sync_file {
                std::fs::write(&p, format!("{req_content}\n"))
                    .map_err(|e| format!("Failed to write requirements.txt: {e}"))?;
                req_file_written = true;
            }
            p
        } else {
            let temp_dir = std::env::temp_dir();
            let p = temp_dir.join(format!("physpy_reqs_{}.txt", std::process::id()));
            std::fs::write(&p, format!("{req_content}\n"))
                .map_err(|e| format!("Failed to write temp requirements: {e}"))?;
            p
        };

        let uv_opt = find_uv_exe();
        let (output, engine_name) = if let Some(ref uv) = uv_opt {
            let mut cmd = Command::new(uv);
            cmd.arg("pip")
                .arg("install")
                .arg("--python")
                .arg(&python_path)
                .arg("-r")
                .arg(&req_path);
            if let Some(ref dir) = base_dir {
                cmd.current_dir(dir);
            }
            (cmd.output().map_err(|e| format!("uv pip install failed: {e}"))?, "uv")
        } else {
            let mut cmd = Command::new(&python_path);
            cmd.arg("-m")
                .arg("pip")
                .arg("install")
                .arg("-r")
                .arg(&req_path);
            if let Some(ref dir) = base_dir {
                cmd.current_dir(dir);
            }
            (cmd.output().map_err(|e| format!("pip install failed: {e}"))?, "pip")
        };

        if base_dir.is_none() {
            let _ = std::fs::remove_file(&req_path);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let success = output.status.success();

        let log = format!(
            "[{engine_name}] {}\n{}{}",
            if success { "Installation completed successfully." } else { "Installation failed." },
            stdout,
            if !stderr.is_empty() { format!("\nOutput:\n{stderr}") } else { String::new() }
        );

        // Restart worker so newly installed packages are immediately importable
        {
            let mut guard = worker_mutex().lock().map_err(|e| e.to_string())?;
            *guard = None;
        }

        Ok(InstallResult {
            success,
            log,
            requirements_file_written: req_file_written,
        })
    })
    .await
}

#[tauri::command]
async fn resolve_venv(
    base_dir: String,
    venv_rel: String,
) -> Result<Option<PythonInterpreterInfo>, String> {
    blocking(move || {
        let base = Path::new(&base_dir);
        let trimmed = venv_rel.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        let venv_path = if Path::new(trimmed).is_absolute() {
            PathBuf::from(trimmed)
        } else {
            base.join(trimmed)
        };

        if let Some(py_exe) = get_python_exe_in_venv(&venv_path) {
            if let Ok(info) = probe_python(&py_exe.to_string_lossy()) {
                return Ok(Some(info));
            }
        }
        if venv_path.is_file() {
            if let Ok(info) = probe_python(&venv_path.to_string_lossy()) {
                return Ok(Some(info));
            }
        }
        Ok(None)
    })
    .await
}

#[tauri::command]
fn compute_relative_path(base_dir: String, target_path: String) -> Result<String, String> {
    let from = Path::new(&base_dir);
    let to = Path::new(&target_path);
    let rel = relative_path(from, to);
    Ok(rel.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            TRANSPILER_PATH.get_or_init(|| resolve_transpiler_path(app));

            // Build native system menu with Settings... (Cmd+, / Ctrl+,)
            let settings_item = MenuItemBuilder::with_id("open_settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let app_submenu = SubmenuBuilder::new(app, "PhysPy")
                .about(None)
                .separator()
                .item(&settings_item)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let new_tab_item = MenuItemBuilder::with_id("menu_new_tab", "New Tab")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;
            let open_file_item = MenuItemBuilder::with_id("menu_open_file", "Open File…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let open_folder_item = MenuItemBuilder::with_id("menu_open_folder", "Open Folder…")
                .accelerator("CmdOrCtrl+Shift+O")
                .build(app)?;
            let save_item = MenuItemBuilder::with_id("menu_save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(app)?;
            let close_tab_item = MenuItemBuilder::with_id("menu_close_tab", "Close Tab")
                .accelerator("CmdOrCtrl+W")
                .build(app)?;

            let file_submenu = SubmenuBuilder::new(app, "File")
                .item(&new_tab_item)
                .separator()
                .item(&open_file_item)
                .item(&open_folder_item)
                .separator()
                .item(&save_item)
                .separator()
                .item(&close_tab_item)
                .build()?;

            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let window_submenu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .separator()
                .close_window()
                .build()?;
            let menu = MenuBuilder::new(app)
                .items(&[&app_submenu, &file_submenu, &edit_submenu, &window_submenu])
                .build()?;
            app.set_menu(menu)?;

            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "open_settings" {
                let _ = app.emit("menu-open-settings", ());
            }
            let _ = app.emit("menu-action", id.to_string());
        })
        .invoke_handler(tauri::generate_handler![
            run_cell,
            reset_session,
            run_code,
            transpile,
            ai_assist,
            list_ai_models,
            read_file,
            read_binary_file,
            write_file,
            write_binary_file,
            create_dir,
            rename_path,
            delete_path,
            load_config,
            read_config_scope,
            save_config_scope,
            pick_file_with_hidden,
            pick_folder_with_hidden,
            initial_root_dir,
            list_dir,
            list_python_interpreters,
            set_python_interpreter,
            create_venv,
            install_requirements,
            resolve_venv,
            compute_relative_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_config() -> AppConfig {
        AppConfig {
            font_family: "monospace".to_string(),
            font_size: 14.5,
            matrix_font_size: 135.0,
            line_numbers: true,
            python_path: String::new(),
            startup_dir: "~".to_string(),
            startup_mode: "restore".to_string(),
            startup_file: String::new(),
            auto_save: "off".to_string(),
            auto_save_delay: 1000,
            ai_provider: "gemini".to_string(),
            ai_model: "gemini-3.8-flash".to_string(),
            ai_api_key: String::new(),
            ai_system_prompt: String::new(),
            resolved_startup_dir: "/tmp".to_string(),
            global_config_path: "/tmp/config.yaml".to_string(),
            workspace_config_path: None,
        }
    }

    #[test]
    fn test_flat_yaml_override() {
        let mut cfg = dummy_config();
        let global_yaml = r#"
font_family: "JetBrains Mono, monospace"
font_size: 15
line_numbers: true
python_path: "/usr/local/bin/python3"
startup_dir: "/tmp"
"#;
        apply_yaml_config_str(global_yaml, None, &mut cfg);
        assert_eq!(cfg.font_family, "JetBrains Mono, monospace");
        assert_eq!(cfg.font_size, 15.0);
        assert!(cfg.line_numbers);
        assert_eq!(cfg.python_path, "/usr/local/bin/python3");

        let workspace_yaml = r#"
# Project override (.physpy-config.yaml)
font_size: 17.5
line_numbers: false # hide line numbers in this project
python_path: ".venv/bin/python3"
"#;
        apply_yaml_config_str(workspace_yaml, Some(Path::new("/tmp/myproj")), &mut cfg);
        assert_eq!(cfg.font_family, "JetBrains Mono, monospace");
        assert_eq!(cfg.font_size, 17.5);
        assert!(!cfg.line_numbers);
        assert_eq!(cfg.python_path, "/tmp/myproj/.venv/bin/python3");
    }

    #[test]
    fn test_nested_yaml_sections() {
        let mut cfg = dummy_config();
        let nested = r#"
editor:
  font_family: 'Fira Code, monospace'
  font_size: 16px
  line_numbers: off
python:
  path: /opt/homebrew/bin/python3
workspace:
  startup_dir: /tmp
"#;
        apply_yaml_config_str(nested, None, &mut cfg);
        assert_eq!(cfg.font_family, "Fira Code, monospace");
        assert_eq!(cfg.font_size, 16.0);
        assert!(!cfg.line_numbers);
        assert_eq!(cfg.python_path, "/opt/homebrew/bin/python3");
    }
}
