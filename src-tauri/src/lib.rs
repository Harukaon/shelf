use tauri::Manager;

mod commands;
mod pty_plugin;
mod session;

#[cfg(target_os = "windows")]
fn apply_windows_title_bar_colors(window: &tauri::WebviewWindow) {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::Foundation::{COLORREF, HWND};
    use windows_sys::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR,
        DWMWA_TEXT_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE,
    };
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageW, WM_NCACTIVATE};

    static DID_LOG_SUPPORT: AtomicBool = AtomicBool::new(false);

    let Ok(hwnd) = window.hwnd() else {
        eprintln!("[Shelf] Windows title bar: could not get HWND");
        return;
    };

    if !DID_LOG_SUPPORT.swap(true, Ordering::Relaxed) {
        log_windows_version();
    }

    let hwnd = hwnd.0;
    apply_windows_title_bar_colors_to_hwnd(hwnd, "setup");

    let hwnd_value = hwnd as usize;
    let _ = window.run_on_main_thread(move || {
        apply_windows_title_bar_colors_to_hwnd(hwnd_value as HWND, "main-thread");
    });

    fn log_windows_version() {
        let mut version = OSVERSIONINFOW {
            dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
            ..Default::default()
        };
        let status = unsafe { RtlGetVersion(&mut version) };
        if status >= 0 {
            eprintln!(
                "[Shelf] Windows version {}.{}.{}",
                version.dwMajorVersion, version.dwMinorVersion, version.dwBuildNumber
            );
            if version.dwBuildNumber < 22000 {
                eprintln!(
                    "[Shelf] Windows title bar: custom caption/text/border colors need Windows 11 build 22000+; older Windows can keep the dark system title bar black"
                );
            }
        } else {
            eprintln!(
                "[Shelf] Windows title bar: failed to read Windows version, NTSTATUS={:#010x}",
                status as u32
            );
        }
    }

    fn apply_windows_title_bar_colors_to_hwnd(hwnd: HWND, phase: &str) {
        let dark_mode = 1i32;
        log_dwm_i32_set(
            phase,
            hwnd,
            "immersive_dark_mode",
            DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
            dark_mode,
        );

        log_dwm_color_set(
            phase,
            hwnd,
            "caption",
            DWMWA_CAPTION_COLOR as u32,
            rgb(0x34, 0x3b, 0x49),
        );
        log_dwm_color_set(
            phase,
            hwnd,
            "text",
            DWMWA_TEXT_COLOR as u32,
            rgb(0xe0, 0xe0, 0xe1),
        );
        log_dwm_color_set(
            phase,
            hwnd,
            "border",
            DWMWA_BORDER_COLOR as u32,
            rgb(0x4a, 0x54, 0x66),
        );

        unsafe {
            let _ = SendMessageW(hwnd, WM_NCACTIVATE, 0, 0);
            let _ = SendMessageW(hwnd, WM_NCACTIVATE, 1, 0);
        }
    }

    fn log_dwm_i32_set(phase: &str, hwnd: HWND, name: &str, attribute: u32, value: i32) {
        let result = unsafe {
            DwmSetWindowAttribute(
                hwnd,
                attribute,
                &value as *const i32 as *const c_void,
                std::mem::size_of::<i32>() as u32,
            )
        };
        eprintln!(
            "[Shelf] Windows title bar {phase}: set {name} attr={attribute} value={value} result={:#010x}",
            result as u32
        );
    }

    fn log_dwm_color_set(phase: &str, hwnd: HWND, name: &str, attribute: u32, color: COLORREF) {
        let result = unsafe {
            DwmSetWindowAttribute(
                hwnd,
                attribute,
                &color as *const COLORREF as *const c_void,
                std::mem::size_of::<COLORREF>() as u32,
            )
        };

        let mut readback = 0u32;
        let read_result = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                attribute,
                &mut readback as *mut COLORREF as *mut c_void,
                std::mem::size_of::<COLORREF>() as u32,
            )
        };

        eprintln!(
            "[Shelf] Windows title bar {phase}: set {name} attr={attribute} color={} result={:#010x}; read result={:#010x} value={}",
            format_color(color),
            result as u32,
            read_result as u32,
            format_color(readback)
        );
    }

    fn format_color(color: COLORREF) -> String {
        format!(
            "#{:02x}{:02x}{:02x}",
            color & 0xff,
            (color >> 8) & 0xff,
            (color >> 16) & 0xff
        )
    }
}

#[cfg(target_os = "windows")]
const fn rgb(red: u32, green: u32, blue: u32) -> windows_sys::Win32::Foundation::COLORREF {
    red | (green << 8) | (blue << 16)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(pty_plugin::PtyState::default());
            let window = app.get_webview_window("main").unwrap();
            window.set_title("Shelf").ok();
            #[cfg(target_os = "windows")]
            {
                window.set_theme(Some(tauri::Theme::Dark)).ok();
                apply_windows_title_bar_colors(&window);
            }
            #[cfg(target_os = "macos")]
            let _ = window.set_title_bar_style(tauri::TitleBarStyle::Overlay);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_plugin::pty_spawn,
            pty_plugin::pty_write,
            pty_plugin::pty_read,
            pty_plugin::pty_resize,
            pty_plugin::pty_kill,
            pty_plugin::pty_exitstatus,
            commands::workspace::add_workspace,
            commands::workspace::remove_workspace,
            commands::workspace::list_workspaces,
            commands::workspace::get_settings,
            commands::workspace::save_settings,
            commands::workspace::detect_terminals,
            commands::workspace::pin_session,
            commands::workspace::unpin_session,
            commands::workspace::get_pinned,
            commands::workspace::exit_app,
            commands::workspace::find_claude,
            commands::sessions::scan_sessions,
            commands::sessions::create_session,
            commands::sessions::rename_session,
            commands::sessions::delete_session,
            commands::files::list_files,
            commands::files::delete_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    });
}
