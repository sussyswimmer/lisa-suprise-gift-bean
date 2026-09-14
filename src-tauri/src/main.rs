use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

#[derive(Serialize, Deserialize, Clone)]
struct ClaudeEvent {
    source: String,
    session: Option<String>,
    status: String,
    timestamp: String,
}

struct ObserverState {
    child: Mutex<Option<Child>>,
}

#[derive(Default)]
struct BeanState {
    observer: Arc<ObserverState>,
    asset_pack_path: Mutex<Option<String>>,
}

#[tauri::command]
async fn start_observer(state: State<'_, BeanState>, app: AppHandle) -> Result<String, String> {
    let mut running = state
        .observer
        .child
        .lock()
        .map_err(|e| format!("observer lock failed: {e}"))?;

    if running.is_some() {
        return Ok("already_running".into());
    }

    let sidecar = resolve_sidecar_path(&app)?;
    let mut child = Command::new(&sidecar)
        .arg("--mode")
        .arg("observe")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to launch observer helper at {sidecar:?}: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "observer helper did not provide stdout".to_string())?;

    let emit_target = app.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(payload) if !payload.trim().is_empty() => {
                    if let Ok(event) = serde_json::from_str::<ClaudeEvent>(payload.as_str()) {
                        let _ = emit_target.emit("bean-claude-event", event);
                    }
                }
                _ => {}
            }
        }
    });

    *running = Some(child);
    Ok("started".into())
}

#[tauri::command]
async fn stop_observer(state: State<'_, BeanState>) -> Result<String, String> {
    let mut running = state
        .observer
        .child
        .lock()
        .map_err(|e| format!("observer lock failed: {e}"))?;
    if let Some(mut child) = running.take() {
        let _ = child.kill();
    }
    Ok("stopped".into())
}

#[tauri::command]
async fn set_asset_pack_path(path: String, state: State<'_, BeanState>) -> Result<serde_json::Value, String> {
    let mut lock = state
        .asset_pack_path
        .lock()
        .map_err(|e| format!("asset path lock failed: {e}"))?;
    if !Path::new(&path).exists() {
        return Err("path does not exist".into());
    }
    *lock = Some(path.clone());
    let result = serde_json::json!({
        "manifestPath": path,
        "path": path
    });
    Ok(result)
}

#[tauri::command]
async fn request_accessibility_permission() -> bool {
    true
}

#[tauri::command]
fn get_asset_pack_path(state: State<'_, BeanState>) -> Option<String> {
    state.asset_pack_path.lock().ok().and_then(|s| s.clone())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn resolve_sidecar_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource dir missing: {e}"))?;
    let mut helper_in_resources = PathBuf::from(&dir);
    helper_in_resources.push("helpers");
    helper_in_resources.push("bean-claude-observer");
    let mut fallback = PathBuf::from(&dir);
    fallback.push("bean-claude-observer");

    if helper_in_resources.exists() {
        return Ok(helper_in_resources);
    }

    if fallback.exists() {
        return Ok(fallback);
    }

    Err(format!("helper not found at {:?} or {:?}", helper_in_resources, fallback))
}

fn main() {
    tauri::Builder::default()
        .manage(BeanState::default())
        .invoke_handler(tauri::generate_handler![
            start_observer,
            stop_observer,
            set_asset_pack_path,
            get_asset_pack_path,
            request_accessibility_permission,
            quit_app
        ])
        .setup(|app| {
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.set_always_on_top(true);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
