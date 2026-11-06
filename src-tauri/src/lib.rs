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
    cell_index: usize,
) -> Result<CellOutput, String> {
    blocking(move || {
        with_worker(|w| {
            let resp = w.send(&serde_json::json!({
                "cmd": "run_cell",
                "source": source,
                "path": path,
                "cell_index": cell_index,
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
fn write_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
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
            write_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
