use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
fn install_claude_code_hooks(app: AppHandle, include_content: bool) -> Result<String, String> {
    let sidecar = resolve_sidecar_path(&app)?;
    let quoted_sidecar = format!("'{}'", sidecar.to_string_lossy().replace("'", "'\\''"));
    let home = std::env::var_os("HOME").ok_or("home directory is unavailable")?;
    let claude_dir = PathBuf::from(home).join(".claude");
    fs::create_dir_all(&claude_dir).map_err(|e| format!("could not create Claude Code settings directory: {e}"))?;

    let hook_path = claude_dir.join("bean-claude-code-hook.sh");
    let hook_script = format!("#!/bin/sh\nset -eu\npgrep -x Bean >/dev/null 2>&1 || exit 0\nexec {quoted_sidecar} --claude-code-hook \"$1\" {}\n", if include_content { "content" } else { "status" });
    fs::write(&hook_path, hook_script).map_err(|e| format!("could not write Bean's local Claude Code hook: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook_path, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("could not make Bean's Claude Code hook executable: {e}"))?;
    }

    let settings_path = claude_dir.join("settings.json");
    let mut settings = if settings_path.exists() {
        let raw = fs::read_to_string(&settings_path).map_err(|e| format!("could not read Claude Code settings: {e}"))?;
        serde_json::from_str::<Value>(&raw).map_err(|e| format!("Claude Code settings are not valid JSON; Bean left them unchanged: {e}"))?
    } else {
        json!({})
    };

    let root = settings.as_object_mut().ok_or("Claude Code settings must be a JSON object")?;
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().ok_or("Claude Code hooks must be a JSON object")?;
    let hook_command = |status: &str| format!("\"$HOME/.claude/bean-claude-code-hook.sh\" {status}");

    for (event, status) in [
        ("UserPromptSubmit", "working"),
        ("Stop", "completed"),
        ("MessageDisplay", "reply"),
        ("StopFailure", "failed"),
        ("Notification", "attention_needed"),
        ("SessionEnd", "stopped"),
    ] {
        let groups = hooks.entry(event.to_string()).or_insert_with(|| json!([]));
        let groups = groups.as_array_mut().ok_or_else(|| format!("Claude Code hook '{event}' must be an array"))?;
        groups.retain(|group| !group.to_string().contains("bean-claude-code-hook.sh"));
        groups.push(json!({
            "matcher": "",
            "hooks": [{ "type": "command", "command": hook_command(status) }]
        }));
    }

    let pretty = serde_json::to_string_pretty(&settings).map_err(|e| format!("could not serialize Claude Code settings: {e}"))?;
    fs::write(&settings_path, format!("{pretty}\n")).map_err(|e| format!("could not save Claude Code settings: {e}"))?;
    Ok("Claude Code hooks installed".into())
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
    let resources = app.path().resource_dir().map_err(|e| format!("resource dir missing: {e}"))?;
    // Tauri packages `externalBin` sidecars next to the app executable on macOS.
    // Development and older bundles can place the helper under Resources instead.
    let candidates = [
        resources.join("helpers").join("bean-claude-observer"),
        resources.join("bean-claude-observer"),
        resources.parent().map(|contents| contents.join("MacOS").join("bean-claude-observer")).unwrap_or_default(),
    ];

    if let Some(path) = candidates.iter().find(|path| path.exists()) {
        return Ok(path.clone());
    }
    Err(format!("bundled Accessibility helper was not found; checked {candidates:?}"))
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
            install_claude_code_hooks,
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
