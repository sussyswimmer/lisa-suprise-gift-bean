use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize, Deserialize, Clone)]
struct ClaudeEvent {
    source: String,
    session: Option<String>,
    status: String,
    timestamp: String,
}

#[derive(Default)]
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
    let mut running = state.observer.child.lock().map_err(|e| format!("observer lock failed: {e}"))?;
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
    let stdout = child.stdout.take().ok_or_else(|| "observer helper did not provide stdout".to_string())?;

    let emit_target = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().flatten() {
            if !line.trim().is_empty() {
                if let Ok(event) = serde_json::from_str::<ClaudeEvent>(&line) {
                    let _ = emit_target.emit("bean-claude-event", event);
                }
            }
        }
    });

    *running = Some(child);
    Ok("started".into())
}

#[tauri::command]
async fn stop_observer(state: State<'_, BeanState>) -> Result<String, String> {
    let mut running = state.observer.child.lock().map_err(|e| format!("observer lock failed: {e}"))?;
    if let Some(mut child) = running.take() {
        let _ = child.kill();
    }
    Ok("stopped".into())
}

#[tauri::command]
async fn set_asset_pack_path(path: String, state: State<'_, BeanState>) -> Result<serde_json::Value, String> {
    let mut lock = state.asset_pack_path.lock().map_err(|e| format!("asset path lock failed: {e}"))?;
    if !Path::new(&path).exists() {
        return Err("path does not exist".into());
    }
    *lock = Some(path.clone());
    Ok(serde_json::json!({ "manifestPath": path, "path": path }))
}

#[tauri::command]
async fn request_accessibility_permission(app: AppHandle) -> Result<bool, String> {
    let sidecar = resolve_sidecar_path(&app)?;
    Command::new(sidecar)
        .arg("--request-permission")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| true)
        .map_err(|e| format!("failed to request Accessibility permission: {e}"))
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
    let dir = app.path().resource_dir().map_err(|e| format!("resource dir missing: {e}"))?;
    let helper_in_resources = dir.join("helpers").join("bean-claude-observer");
    let fallback = dir.join("bean-claude-observer");
    if helper_in_resources.exists() {
        return Ok(helper_in_resources);
    }
    if fallback.exists() {
        return Ok(fallback);
    }
    Err(format!("helper not found at {helper_in_resources:?} or {fallback:?}"))
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