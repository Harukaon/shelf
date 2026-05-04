use tauri::Manager;

mod commands;
mod pty_plugin;
mod session;

#[cfg(target_os = "windows")]
fn apply_windows_title_bar_colors(window: &tauri::WebviewWindow) {
    use std::ffi::c_void;
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::Foundation::{COLORREF, HWND};
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
        DWMWA_USE_IMMERSIVE_DARK_MODE,
    };
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageW, WM_NCACTIVATE};

    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    let hwnd = hwnd.0;
    let supports_custom_colors = matches!(windows_build_number(), Some(build) if build >= 22000);
    apply_windows_title_bar_colors_to_hwnd(hwnd, supports_custom_colors);

    let hwnd_value = hwnd as usize;
    let _ = window.run_on_main_thread(move || {
        apply_windows_title_bar_colors_to_hwnd(hwnd_value as HWND, supports_custom_colors);
    });

    fn windows_build_number() -> Option<u32> {
        let mut version = OSVERSIONINFOW {
            dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
            ..Default::default()
        };
        let status = unsafe { RtlGetVersion(&mut version) };
        if status >= 0 {
            Some(version.dwBuildNumber)
        } else {
            None
        }
    }

    fn apply_windows_title_bar_colors_to_hwnd(hwnd: HWND, supports_custom_colors: bool) {
        set_i32_attribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE as u32, 1);

        if supports_custom_colors {
            set_color_attribute(hwnd, DWMWA_CAPTION_COLOR as u32, rgb(0x34, 0x3b, 0x49));
            set_color_attribute(hwnd, DWMWA_TEXT_COLOR as u32, rgb(0xe0, 0xe0, 0xe1));
            set_color_attribute(hwnd, DWMWA_BORDER_COLOR as u32, rgb(0x4a, 0x54, 0x66));
        }

        refresh_title_bar(hwnd);
    }

    fn set_i32_attribute(hwnd: HWND, attribute: u32, value: i32) {
        let _ = unsafe {
            DwmSetWindowAttribute(
                hwnd,
                attribute,
                &value as *const i32 as *const c_void,
                std::mem::size_of::<i32>() as u32,
            )
        };
    }

    fn set_color_attribute(hwnd: HWND, attribute: u32, color: COLORREF) {
        let _ = unsafe {
            DwmSetWindowAttribute(
                hwnd,
                attribute,
                &color as *const COLORREF as *const c_void,
                std::mem::size_of::<COLORREF>() as u32,
            )
        };
    }

    fn refresh_title_bar(hwnd: HWND) {
        unsafe {
            let _ = SendMessageW(hwnd, WM_NCACTIVATE, 0, 0);
            let _ = SendMessageW(hwnd, WM_NCACTIVATE, 1, 0);
        }
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

    app.run(|_app_handle, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            if let Some(window) = _app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    });
}
