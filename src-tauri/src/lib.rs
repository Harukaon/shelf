use tauri::Manager;

mod commands;
mod pty_plugin;
mod session;

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
                window.set_decorations(false).ok();
            }
            #[cfg(target_os = "macos")]
            let _ = window.set_title_bar_style(tauri::TitleBarStyle::Overlay);
            window.show().ok();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_plugin::pty_spawn,
            pty_plugin::pty_write,
            pty_plugin::pty_read,
            pty_plugin::pty_resize,
            pty_plugin::pty_kill,
            pty_plugin::pty_exitstatus,
            commands::ai::get_ai_settings,
            commands::ai::save_ai_settings,
            commands::ai::get_ai_session_map,
            commands::ai::save_ai_session_map,
            commands::ai::stop_ai_organizer,
            commands::ai::execute_approved_shell_command,
            commands::ai::list_ai_models,
            commands::ai::run_ai_organizer,
            commands::ssh::ssh_test_connection,
            commands::ssh::ssh_resolve_path,
            commands::ssh::ssh_list_config_hosts,
            commands::ssh::ssh_find_command,
            commands::ssh::ssh_get_history,
            commands::ssh::ssh_add_history,
            commands::workspace::add_workspace,
            commands::workspace::remove_workspace,
            commands::workspace::list_workspaces,
            commands::workspace::get_settings,
            commands::workspace::save_settings,
            commands::workspace::detect_terminals,
            commands::workspace::pin_session,
            commands::workspace::unpin_session,
            commands::workspace::get_pinned,
            commands::workspace::get_app_state,
            commands::workspace::save_app_state,
            commands::workspace::exit_app,
            commands::workspace::find_claude,
            commands::workspace::find_codex,
            commands::sessions::scan_sessions,
            commands::sessions::scan_codex_sessions,
            commands::sessions::create_session,
            commands::sessions::rename_session,
            commands::sessions::delete_session,
            commands::files::list_files,
            commands::files::read_text_file,
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
