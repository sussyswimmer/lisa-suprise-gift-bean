use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Size, State};

#[derive(Serialize, Deserialize, Clone)]
struct ClaudeEvent {
    source: String,
    session: Option<String>,
    status: String,
    timestamp: String,
    preview: Option<String>,
    reason: Option<String>,
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
fn start_observer(state: State<'_, BeanState>, app: AppHandle) -> Result<String, String> {
    let mut running = state.observer.child.lock().map_err(|e| format!("observer lock failed: {e}"))?;
    if let Some(child) = running.as_mut() {
        if child.try_wait().map_err(|e| format!("could not check observer: {e}"))?.is_none() {
            return Ok("already_running".into());
        }
        *running = None;
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
    let output = Command::new(sidecar)
        .arg("--request-permission")
        .output()
        .map_err(|e| format!("failed to request Accessibility permission: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "Accessibility helper exited with {}",
            output.status
        ));
    }

    let event: ClaudeEvent = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Accessibility helper returned an invalid response: {e}"))?;
    Ok(event.status != "unavailable")
}

#[tauri::command]
fn install_claude_code_hooks(app: AppHandle, include_content: bool) -> Result<String, String> {
    let sidecar = resolve_sidecar_path(&app)?;
    let quoted_sidecar = format!("'{}'", sidecar.to_string_lossy().replace("'", "'\\''"));
    let home = std::env::var_os("HOME").ok_or("home directory is unavailable")?;
    let claude_dir = PathBuf::from(home).join(".claude");
    fs::create_dir_all(&claude_dir).map_err(|e| format!("could not create Claude Code settings directory: {e}"))?;

    let hook_path = claude_dir.join("bean-claude-code-hook.sh");
    let hook_script = format!("#!/bin/sh\nset -eu\n(pgrep -x bean >/dev/null 2>&1 || pgrep -x Bean >/dev/null 2>&1) || exit 0\nexec {quoted_sidecar} --claude-code-hook \"$1\" {}\n", if include_content { "content" } else { "status" });
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
fn get_connection_status(app: AppHandle) -> Result<ClaudeEvent, String> {
    let output = Command::new(resolve_sidecar_path(&app)?)
        .arg("--connection-status")
        .output()
        .map_err(|e| format!("could not inspect Claude: {e}"))?;
    if !output.status.success() {
        return Err(format!("Claude helper exited with {}", output.status));
    }
    // There can be several installed Claude hosts; prefer a readable one.
    let events: Vec<ClaudeEvent> = String::from_utf8_lossy(&output.stdout)
        .lines().filter_map(|line| serde_json::from_str(line).ok()).collect();
    events.iter().find(|event| event.status != "unavailable")
        .or_else(|| events.first()).cloned()
        .ok_or_else(|| "Claude helper did not return connection status".into())
}

#[tauri::command]
fn open_claude() -> Result<(), String> {
    Command::new("/usr/bin/open").args(["-b", "com.anthropic.claudefordesktop"])
        .status().map_err(|e| format!("could not open Claude Desktop: {e}"))?
        .success().then_some(()).ok_or_else(|| "Claude Desktop is not installed".into())
}

#[tauri::command]
fn open_accessibility_settings() -> Result<(), String> {
    Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .status().map_err(|e| format!("could not open Accessibility settings: {e}"))?
        .success().then_some(()).ok_or_else(|| "could not open Accessibility settings".into())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn drag_window(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("main window is unavailable")?;
    window.start_dragging().map_err(|e| format!("could not drag Bean: {e}"))
}

#[tauri::command]
fn set_window_mode(app: AppHandle, compact: bool) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("main window is unavailable")?;
    let (width, height) = if compact { (272.0, 248.0) } else { (360.0, 370.0) };
    window
        .set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|e| format!("could not resize Bean: {e}"))
}

fn resolve_sidecar_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();

    // Tauri's resource directory differs between a development run and a macOS
    // app bundle. Keep these locations for both cases.
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("helpers").join("bean-claude-observer"));
        candidates.push(resources.join("bean-claude-observer"));
        if let Some(contents) = resources.parent() {
            candidates.push(contents.join("MacOS").join("bean-claude-observer"));
        }
    }

    // `externalBin` is packaged next to the main executable in a macOS DMG.
    // Resolve from the live executable rather than assuming a Resources folder:
    // a minimal bundle need not contain one at all.
    if let Ok(executable) = std::env::current_exe() {
        if let Some(executable_dir) = executable.parent() {
            candidates.push(executable_dir.join("bean-claude-observer"));
        }
    }

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
            get_connection_status,
            open_claude,
            open_accessibility_settings,
            drag_window,
            set_window_mode,
            quit_app
        ])
        .setup(|app| {
            // Start the observer from the native process. This keeps monitoring
            // alive even if the webview restores an existing session before its
            // React effects have registered.
            let app_handle = app.handle().clone();
            let state = app.state::<BeanState>();
            let _ = start_observer(state, app_handle);

            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.set_always_on_top(true);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
