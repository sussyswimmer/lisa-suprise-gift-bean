//! Keeps Bean's window on every Space, including full-screen apps, so she
//! stays in view when you swipe between desktops. Tauri's own
//! "visibleOnAllWorkspaces" only covers ordinary desktops.

use std::ffi::{c_char, c_void};

#[link(name = "objc")]
extern "C" {
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    fn objc_msgSend();
}

// NSWindowCollectionBehavior flags.
const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
const MOVE_TO_ACTIVE_SPACE: usize = 1 << 1;
const STATIONARY: usize = 1 << 4;
const IGNORES_CYCLE: usize = 1 << 6;
const FULL_SCREEN_PRIMARY: usize = 1 << 7;
const FULL_SCREEN_AUXILIARY: usize = 1 << 8;
const FULL_SCREEN_NONE: usize = 1 << 9;

// NSWindow levels. The status level sits above full-screen apps but below
// menus, alerts and the screen saver.
const NORMAL_WINDOW_LEVEL: isize = 0;
const STATUS_WINDOW_LEVEL: isize = 25;

/// Applies Bean's Space behavior to her NSWindow. Must run on the main thread.
///
/// # Safety
/// `ns_window` must be a live NSWindow pointer.
pub unsafe fn follow_all_spaces(ns_window: *mut c_void, on_top: bool) {
    if ns_window.is_null() {
        return;
    }
    let get_behavior: unsafe extern "C" fn(*mut c_void, *mut c_void) -> usize =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let set_behavior: unsafe extern "C" fn(*mut c_void, *mut c_void, usize) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let set_level: unsafe extern "C" fn(*mut c_void, *mut c_void, isize) =
        std::mem::transmute(objc_msgSend as unsafe extern "C" fn());

    let behavior = get_behavior(ns_window, sel_registerName(c"collectionBehavior".as_ptr()));
    let behavior = (behavior & !(MOVE_TO_ACTIVE_SPACE | FULL_SCREEN_PRIMARY | FULL_SCREEN_NONE))
        | CAN_JOIN_ALL_SPACES
        | STATIONARY
        | IGNORES_CYCLE
        | FULL_SCREEN_AUXILIARY;
    set_behavior(
        ns_window,
        sel_registerName(c"setCollectionBehavior:".as_ptr()),
        behavior,
    );
    set_level(
        ns_window,
        sel_registerName(c"setLevel:".as_ptr()),
        if on_top {
            STATUS_WINDOW_LEVEL
        } else {
            NORMAL_WINDOW_LEVEL
        },
    );
}
