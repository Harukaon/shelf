use tauri::Manager;

mod commands;
mod pty_plugin;
mod session;

#[cfg(target_os = "windows")]
fn apply_windows_title_bar_colors(window: &tauri::WebviewWindow) {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::COLORREF;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
        DWMWA_USE_IMMERSIVE_DARK_MODE,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    let set_color = |attribute, color: COLORREF| {
        let _ = unsafe {
            DwmSetWindowAttribute(
                hwnd.0,
                attribute,
                &color as *const COLORREF as *const c_void,
                std::mem::size_of::<COLORREF>() as u32,
            )
        };
    };

    let dark_mode = 0i32;
    let _ = unsafe {
        DwmSetWindowAttribute(
            hwnd.0,
            DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
            &dark_mode as *const i32 as *const c_void,
            std::mem::size_of::<i32>() as u32,
        )
    };

    set_color(DWMWA_CAPTION_COLOR as u32, rgb(0x3a, 0x42, 0x50));
    set_color(DWMWA_TEXT_COLOR as u32, rgb(0xe0, 0xe0, 0xe1));
    set_color(DWMWA_BORDER_COLOR as u32, rgb(0x4a, 0x54, 0x66));
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
                window.set_theme(Some(tauri::Theme::Light)).ok();
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
