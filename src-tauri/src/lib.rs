use tauri::Manager;

mod commands;
mod session;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.set_title("Shelf").ok();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
        if let tauri::RunEvent::Reopen { .. } = event {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    });
}
