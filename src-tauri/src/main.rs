use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Size, State, WebviewUrl, WebviewWindowBuilder, Wry,
};

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
    generation: AtomicU64,
    // Generation of the running supervisor, or 0 when Bean is not observing.
    active_generation: AtomicU64,
    last_event: Mutex<Option<ClaudeEvent>>,
}

/// Menu bar items whose text follows Bean's state.
struct TrayItems {
    pause: MenuItem<Wry>,
    visibility: MenuItem<Wry>,
}

#[derive(Default)]
struct BeanState {
    observer: Arc<ObserverState>,
    asset_pack_path: Mutex<Option<String>>,
    hook_install: Mutex<()>,
}

fn publish_observer_event(app: &AppHandle, event: &ClaudeEvent) {
    // Keep the normal Tauri event for consumers that use the module API.
    let _ = app.emit("bean-claude-event", event);

    // WebKit can finish restoring the React application after the first native
    // event was emitted. Dispatch a DOM event as a second, direct delivery path
    // so the visible companion always catches the current observer state.
    let Ok(event_json) = serde_json::to_string(event) else {
        return;
    };
    let Ok(event_literal) = serde_json::to_string(&event_json) else {
        return;
    };
    let script = format!(
        "window.dispatchEvent(new CustomEvent('bean-observer-status', {{ detail: JSON.parse({event_literal}) }}));"
    );
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(script);
    }
}

#[tauri::command]
fn start_observer(state: State<'_, BeanState>, app: AppHandle) -> Result<String, String> {
    let helper = resolve_sidecar_path(&app)?;
    start_supervised_observer(&state.observer, helper, move |event| {
        publish_observer_event(&app, &event)
    })
}

fn spawn_observer_helper(helper: &Path) -> Result<(Child, ChildStdout), String> {
    let mut child = Command::new(helper)
        .arg("--mode")
        .arg("observe")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to launch observer helper at {helper:?}: {e}"))?;
    match child.stdout.take() {
        Some(stdout) => Ok((child, stdout)),
        None => {
            let _ = child.kill();
            let _ = child.wait();
            Err("observer helper did not provide stdout".into())
        }
    }
}

fn start_supervised_observer<F>(
    observer: &Arc<ObserverState>,
    helper: PathBuf,
    publish: F,
) -> Result<String, String>
where
    F: Fn(ClaudeEvent) + Send + 'static,
{
    let mut running = observer
        .child
        .lock()
        .map_err(|e| format!("observer lock failed: {e}"))?;
    if observer.active_generation.load(Ordering::SeqCst) != 0 {
        return Ok("already_running".into());
    }

    // Launch the first helper here so a missing or broken helper is reported
    // to the caller instead of only being retried in the background.
    let (child, stdout) = spawn_observer_helper(&helper)?;
    let generation = observer.generation.fetch_add(1, Ordering::SeqCst) + 1;
    observer
        .active_generation
        .store(generation, Ordering::SeqCst);
    if let Ok(mut cached) = observer.last_event.lock() {
        *cached = None;
    }
    *running = Some(child);

    let supervised = observer.clone();
    thread::spawn(move || {
        supervise_observer(&supervised, &helper, generation, stdout, publish);
        let _ = supervised.active_generation.compare_exchange(
            generation,
            0,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
    });
    Ok("started".into())
}

// Keep the helper alive for as long as Bean is observing. Without this, one
// helper crash or exit silently stopped every Claude update until Bean was
// restarted or the connection was refreshed by hand.
fn supervise_observer<F>(
    observer: &ObserverState,
    helper: &Path,
    generation: u64,
    stdout: ChildStdout,
    publish: F,
) where
    F: Fn(ClaudeEvent),
{
    let is_current = || observer.generation.load(Ordering::SeqCst) == generation;
    let mut stdout = Some(stdout);
    let mut failures: u32 = 0;
    loop {
        if let Some(output) = stdout.take() {
            let started = Instant::now();
            for line in BufReader::new(output).lines().map_while(Result::ok) {
                let Ok(event) = serde_json::from_str::<ClaudeEvent>(&line) else {
                    continue;
                };
                if !is_current() {
                    return;
                }
                if let Ok(mut last_event) = observer.last_event.lock() {
                    *last_event = Some(event.clone());
                }
                publish(event);
            }
            if started.elapsed() >= Duration::from_secs(30) {
                failures = 0;
            }
        }

        {
            let Ok(mut running) = observer.child.lock() else {
                return;
            };
            if !is_current() {
                return;
            }
            if let Some(mut child) = running.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }

        failures = failures.saturating_add(1);
        thread::sleep(Duration::from_millis(500 * u64::from(failures.min(10))));

        let Ok(mut running) = observer.child.lock() else {
            return;
        };
        if !is_current() {
            return;
        }
        if let Ok((child, output)) = spawn_observer_helper(helper) {
            stdout = Some(output);
            *running = Some(child);
        }
    }
}

fn stop_supervised_observer(observer: &ObserverState) -> Result<(), String> {
    let mut running = observer
        .child
        .lock()
        .map_err(|e| format!("observer lock failed: {e}"))?;
    observer.generation.fetch_add(1, Ordering::SeqCst);
    observer.active_generation.store(0, Ordering::SeqCst);
    if let Some(mut child) = running.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    if let Ok(mut cached) = observer.last_event.lock() {
        *cached = None;
    }
    Ok(())
}

#[tauri::command]
fn get_observer_status(state: State<'_, BeanState>) -> Option<ClaudeEvent> {
    state
        .observer
        .last_event
        .lock()
        .ok()
        .and_then(|event| event.clone())
}

#[tauri::command]
fn stop_observer(state: State<'_, BeanState>) -> Result<String, String> {
    stop_supervised_observer(&state.observer)?;
    Ok("stopped".into())
}

#[tauri::command]
async fn set_asset_pack_path(
    path: String,
    state: State<'_, BeanState>,
) -> Result<serde_json::Value, String> {
    let mut lock = state
        .asset_pack_path
        .lock()
        .map_err(|e| format!("asset path lock failed: {e}"))?;
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

// Test builds are ad-hoc signed, so every new build has a different signature.
// macOS keeps showing the old Accessibility switch as on while denying the new
// build. Clearing Bean's entry lets the next request register this build.
#[tauri::command]
async fn reset_accessibility_permission(app: AppHandle) -> Result<bool, String> {
    let identifier = app.config().identifier.clone();
    let status = Command::new("/usr/bin/tccutil")
        .args(["reset", "Accessibility", &identifier])
        .status()
        .map_err(|e| format!("could not reset Accessibility permission: {e}"))?;
    if !status.success() {
        return Err(format!(
            "tccutil could not reset Bean's permission ({status})"
        ));
    }
    request_accessibility_permission(app).await
}

#[tauri::command]
fn install_claude_code_hooks(
    app: AppHandle,
    state: State<'_, BeanState>,
    include_content: bool,
) -> Result<String, String> {
    let _guard = state
        .hook_install
        .lock()
        .map_err(|e| format!("hook install lock failed: {e}"))?;
    let sidecar = resolve_sidecar_path(&app)?;
    let quoted_sidecar = format!("'{}'", sidecar.to_string_lossy().replace("'", "'\\''"));
    let home = std::env::var_os("HOME").ok_or("home directory is unavailable")?;
    let claude_dir = PathBuf::from(home).join(".claude");
    fs::create_dir_all(&claude_dir)
        .map_err(|e| format!("could not create Claude Code settings directory: {e}"))?;

    let hook_path = claude_dir.join("bean-claude-code-hook.sh");
    let hook_script = format!("#!/bin/sh\nset -eu\n(pgrep -x bean >/dev/null 2>&1 || pgrep -x Bean >/dev/null 2>&1) || exit 0\nexec {quoted_sidecar} --claude-code-hook \"$1\" {}\n", if include_content { "content" } else { "status" });
    let settings_path = claude_dir.join("settings.json");
    let mut settings = if settings_path.exists() {
        let raw = fs::read_to_string(&settings_path)
            .map_err(|e| format!("could not read Claude Code settings: {e}"))?;
        serde_json::from_str::<Value>(&raw).map_err(|e| {
            format!("Claude Code settings are not valid JSON; Bean left them unchanged: {e}")
        })?
    } else {
        json!({})
    };

    update_claude_hooks(&mut settings)?;
    let pretty = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("could not serialize Claude Code settings: {e}"))?;
    atomic_write(&hook_path, hook_script.as_bytes())?;
    atomic_write(&settings_path, format!("{pretty}\n").as_bytes())?;
    Ok("Claude Code hooks installed".into())
}
fn update_claude_hooks(settings: &mut Value) -> Result<(), String> {
    let root = settings
        .as_object_mut()
        .ok_or("Claude Code settings must be a JSON object")?;
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks
        .as_object_mut()
        .ok_or("Claude Code hooks must be a JSON object")?;
    let hook_command =
        |status: &str| format!("\"$HOME/.claude/bean-claude-code-hook.sh\" {status}");

    for (event, status) in [
        ("UserPromptSubmit", "working"),
        // Tool results keep a long turn alive in the helper and end a
        // permission prompt once it is answered; they are not shown directly.
        ("PostToolUse", "heartbeat"),
        ("Stop", "completed"),
        ("MessageDisplay", "reply"),
        ("StopFailure", "failed"),
        ("Notification", "attention_needed"),
        ("SessionEnd", "stopped"),
    ] {
        let groups = hooks.entry(event.to_string()).or_insert_with(|| json!([]));
        let groups = groups
            .as_array_mut()
            .ok_or_else(|| format!("Claude Code hook '{event}' must be an array"))?;
        for group in groups.iter_mut() {
            if let Some(commands) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                commands.retain(|hook| {
                    !hook
                        .get("command")
                        .and_then(Value::as_str)
                        .is_some_and(|command| {
                            command.starts_with("\"$HOME/.claude/bean-claude-code-hook.sh\" ")
                        })
                });
            }
        }
        groups.retain(|group| {
            !group
                .get("hooks")
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty)
        });
        groups.push(json!({
            "matcher": "",
            "hooks": [{ "type": "command", "command": hook_command(status) }]
        }));
    }

    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let temp = path.with_extension(format!("bean-{}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(if path.extension().is_some_and(|ext| ext == "sh") {
                0o700
            } else {
                0o600
            });
        }
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|e| format!("could not save {}: {e}", path.display()))
}

#[tauri::command]
fn get_asset_pack_path(state: State<'_, BeanState>) -> Option<String> {
    state.asset_pack_path.lock().ok().and_then(|s| s.clone())
}

// The helper retries while Claude builds its accessibility tree; run it off the
// main thread so Bean's window stays responsive.
#[tauri::command]
async fn get_connection_status(app: AppHandle) -> Result<ClaudeEvent, String> {
    let output = Command::new(resolve_sidecar_path(&app)?)
        .arg("--connection-status")
        .output()
        .map_err(|e| format!("could not inspect Claude: {e}"))?;
    if !output.status.success() {
        return Err(format!("Claude helper exited with {}", output.status));
    }
    // There can be several installed Claude hosts; prefer a readable one.
    let events: Vec<ClaudeEvent> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    events
        .iter()
        .find(|event| event.status != "unavailable")
        .or_else(|| events.first())
        .cloned()
        .ok_or_else(|| "Claude helper did not return connection status".into())
}

#[tauri::command]
fn open_claude() -> Result<(), String> {
    Command::new("/usr/bin/open")
        .args(["-b", "com.anthropic.claudefordesktop"])
        .status()
        .map_err(|e| format!("could not open Claude Desktop: {e}"))?
        .success()
        .then_some(())
        .ok_or_else(|| "Claude Desktop is not installed".into())
}

#[tauri::command]
fn open_accessibility_settings() -> Result<(), String> {
    Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .status()
        .map_err(|e| format!("could not open Accessibility settings: {e}"))?
        .success()
        .then_some(())
        .ok_or_else(|| "could not open Accessibility settings".into())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn drag_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window is unavailable")?;
    window
        .start_dragging()
        .map_err(|e| format!("could not drag Bean: {e}"))
}

#[tauri::command]
fn set_window_mode(app: AppHandle, compact: bool, scale: Option<f64>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window is unavailable")?;
    // Bean's size setting scales her 140 px box from her feet; grow the
    // window by the same amount so she never overlaps her speech bubble.
    let scale = scale.unwrap_or(1.0).clamp(0.5, 2.0);
    let (width, height) = if compact {
        (272.0, 248.0 + 140.0 * (scale - 1.0))
    } else {
        (360.0, 370.0)
    };
    window
        .set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|e| format!("could not resize Bean: {e}"))
}

#[tauri::command]
fn set_always_on_top(app: AppHandle, on_top: bool) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or("main window is unavailable")?
        .set_always_on_top(on_top)
        .map_err(|e| format!("could not change Bean's window level: {e}"))
}

#[tauri::command]
fn reset_window_position(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window is unavailable")?;
    window
        .show()
        .and_then(|_| window.center())
        .map_err(|e| format!("could not move Bean: {e}"))?;
    sync_visibility_item(&app);
    Ok(())
}

/// Bean's window reports pause changes so the menu bar item reads correctly.
#[tauri::command]
fn set_tray_state(app: AppHandle, paused: bool) -> Result<(), String> {
    let items = app.state::<TrayItems>();
    items
        .pause
        .set_text(if paused {
            "Resume Monitoring"
        } else {
            "Pause Monitoring"
        })
        .map_err(|e| format!("could not update the menu bar: {e}"))
}

fn sync_visibility_item(app: &AppHandle) {
    let visible = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(true);
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items
            .visibility
            .set_text(if visible { "Hide Bean" } else { "Show Bean" });
    }
}

fn open_settings_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show()?;
        window.unminimize()?;
        return window.set_focus();
    }
    // The same page as Bean's window; it renders Settings for this label.
    let window = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .title("Bean Settings")
        .inner_size(720.0, 560.0)
        .min_inner_size(600.0, 460.0)
        .center()
        .focused(true)
        .build()?;
    window.set_focus()
}

fn toggle_bean_visibility(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible()? {
            window.hide()?;
        } else {
            window.show()?;
        }
    }
    sync_visibility_item(app);
    Ok(())
}

/// Bean's icon in the macOS menu bar, with Settings, Pause, Show/Hide and Quit.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let pause = MenuItem::with_id(app, "pause", "Pause Monitoring", true, None::<&str>)?;
    let visibility = MenuItem::with_id(app, "visibility", "Hide Bean", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Bean", true, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(
        app,
        &[
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &pause,
            &visibility,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    TrayIconBuilder::with_id("bean")
        .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        // A template image follows the menu bar's light or dark appearance.
        .icon_as_template(true)
        .tooltip("Bean")
        .menu(&menu)
        .on_menu_event(|app, event| {
            let result = match event.id.as_ref() {
                "settings" => open_settings_window(app),
                "pause" => app.emit_to("main", "bean-tray-action", "toggle-pause"),
                "visibility" => toggle_bean_visibility(app),
                "quit" => {
                    app.exit(0);
                    Ok(())
                }
                _ => Ok(()),
            };
            if let Err(error) = result {
                eprintln!("Bean menu bar action failed: {error}");
            }
        })
        .build(app)?;
    app.manage(TrayItems { pause, visibility });
    Ok(())
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
    Err(format!(
        "bundled Accessibility helper was not found; checked {candidates:?}"
    ))
}

fn main() {
    tauri::Builder::default()
        .manage(BeanState::default())
        .invoke_handler(tauri::generate_handler![
            start_observer,
            stop_observer,
            get_observer_status,
            set_asset_pack_path,
            get_asset_pack_path,
            request_accessibility_permission,
            reset_accessibility_permission,
            install_claude_code_hooks,
            get_connection_status,
            open_claude,
            open_accessibility_settings,
            drag_window,
            set_window_mode,
            set_always_on_top,
            reset_window_position,
            set_tray_state,
            quit_app
        ])
        .setup(|app| {
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.set_always_on_top(true);
            }
            build_tray(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let _ = stop_supervised_observer(&app.state::<BeanState>().observer);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hook_install_preserves_other_commands_and_is_idempotent() {
        let mut settings = json!({"model": "sonnet", "hooks": {"Stop": [{"matcher": "", "hooks": [
            {"type": "command", "command": "echo keep-me"},
            {"type": "command", "command": "\"$HOME/.claude/bean-claude-code-hook.sh\" completed"}
        ]}]}});
        update_claude_hooks(&mut settings).unwrap();
        let first = settings.clone();
        update_claude_hooks(&mut settings).unwrap();
        assert_eq!(settings, first);
        assert_eq!(settings["model"], "sonnet");
        assert_eq!(
            settings["hooks"]["Stop"][0]["hooks"][0]["command"],
            "echo keep-me"
        );
        assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn rejects_malformed_hook_configuration() {
        assert!(update_claude_hooks(&mut json!({"hooks": []})).is_err());
        assert!(update_claude_hooks(&mut json!({"hooks": {"Stop": {}}})).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn observer_restarts_an_exited_helper_until_stopped() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::mpsc;

        let dir = std::env::temp_dir().join(format!("bean-observer-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let helper = dir.join("helper");
        fs::write(
            &helper,
            "#!/bin/sh\necho '{\"source\":\"chat\",\"session\":null,\"status\":\"idle\",\"timestamp\":\"2026-09-30T00:00:00Z\"}'\n",
        )
        .unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)).unwrap();

        let observer = Arc::new(ObserverState::default());
        let (sender, receiver) = mpsc::channel();
        let started = start_supervised_observer(&observer, helper.clone(), move |event| {
            let _ = sender.send(event.status);
        });
        assert_eq!(started.unwrap(), "started");
        // The helper exits after one event, so a second event means it was relaunched.
        for _ in 0..2 {
            let status = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(status, "idle");
        }
        assert_eq!(
            start_supervised_observer(&observer, helper, |_| {}).unwrap(),
            "already_running"
        );

        stop_supervised_observer(&observer).unwrap();
        while receiver.recv_timeout(Duration::from_millis(1_500)).is_ok() {}
        assert!(receiver.recv_timeout(Duration::from_secs(2)).is_err());
        assert_eq!(observer.active_generation.load(Ordering::SeqCst), 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn observer_start_reports_a_missing_helper() {
        let observer = Arc::new(ObserverState::default());
        let missing = std::env::temp_dir().join("bean-observer-missing-helper");
        assert!(start_supervised_observer(&observer, missing, |_| {}).is_err());
        assert_eq!(observer.active_generation.load(Ordering::SeqCst), 0);
    }
}
