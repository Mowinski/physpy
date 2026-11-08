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
use tauri::Manager;

#[derive(Serialize)]
pub struct RunOutput {
    stdout: String,
    stderr: String,
    code: Option<i32>,
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
        let n = self
            .stdout
            .read_line(&mut resp_line)
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("Python worker exited unexpectedly".into());
        }
        serde_json::from_str(&resp_line).map_err(|e| e.to_string())
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
        path: path.to_string(),
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

#[tauri::command]
fn initial_root_dir() -> Result<String, String> {
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let p = PathBuf::from(home);
        if p.is_dir() {
            return Ok(p.to_string_lossy().into_owned());
        }
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
                std::fs::canonicalize(cand.parent().unwrap_or(Path::new(".")))
                    .map(|p| p.join(cand.file_name().unwrap_or_default()))
                    .unwrap_or(cand)
                    .to_string_lossy()
                    .into_owned()
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

        let active_norm = Path::new(&current)
            .parent()
            .and_then(|p| std::fs::canonicalize(p).ok())
            .and_then(|p| Path::new(&current).file_name().map(|f| p.join(f)))
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or(current);

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
        {
            let mut sel = selected_python_mutex().lock().map_err(|e| e.to_string())?;
            *sel = Some(info.path.clone());
        }
        // Restart the persistent worker so it runs on the newly chosen interpreter
        {
            let mut guard = worker_mutex().lock().map_err(|e| e.to_string())?;
            *guard = None;
        }
        Ok(info)
    })
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            TRANSPILER_PATH.get_or_init(|| resolve_transpiler_path(app));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_cell,
            reset_session,
            run_code,
            transpile,
            read_file,
            read_binary_file,
            write_file,
            write_binary_file,
            create_dir,
            rename_path,
            delete_path,
            initial_root_dir,
            list_dir,
            list_python_interpreters,
            set_python_interpreter
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
