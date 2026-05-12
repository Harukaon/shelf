use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::Read,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{
    async_runtime::RwLock,
    ipc::{Channel, InvokeResponseBody},
    AppHandle, Runtime,
};

const HIGH_WATERMARK: usize = 100_000;
const LOW_WATERMARK: usize = 5_000;
const READ_BUF_SIZE: usize = 8192;
const CARRY_FLUSH_LIMIT: usize = 65_536;

#[derive(Default)]
pub struct PtyState {
    session_id: AtomicU32,
    sessions: RwLock<BTreeMap<u32, Arc<PtySession>>>,
}

struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    child_killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    pending: AtomicUsize,
    ack_count: AtomicU64,
    flow_pair: Arc<(Mutex<bool>, Condvar)>,
    shutdown: AtomicBool,
    reader_closed: AtomicBool,
    child_exited: AtomicBool,
}

async fn remove_session_if_done(
    pid: u32,
    session: &Arc<PtySession>,
    state: &tauri::State<'_, PtyState>,
) {
    if session.reader_closed.load(Ordering::Acquire) && session.child_exited.load(Ordering::Acquire)
    {
        let mut sessions = state.sessions.write().await;
        if sessions
            .get(&pid)
            .map_or(false, |current| Arc::ptr_eq(current, session))
        {
            sessions.remove(&pid);
            eprintln!("[pty pid={}] session removed from registry", pid);
        }
    }
}

fn reader_thread(
    pid: u32,
    mut reader: Box<dyn Read + Send>,
    session: Arc<PtySession>,
    on_data: Channel<InvokeResponseBody>,
) {
    eprintln!(
        "[pty pid={}] reader thread started (HIGH={}, LOW={}, READ_BUF={})",
        pid, HIGH_WATERMARK, LOW_WATERMARK, READ_BUF_SIZE
    );

    let mut buf = vec![0u8; READ_BUF_SIZE];
    let mut carry: Vec<u8> = Vec::new();
    let mut total_emitted: u64 = 0;
    let mut emit_count: u64 = 0;

    loop {
        if session.shutdown.load(Ordering::Acquire) {
            eprintln!("[pty pid={}] reader: shutdown signaled, exiting", pid);
            break;
        }

        // ---- backpressure: pause if pending too high ----
        let pending_now = session.pending.load(Ordering::Acquire);
        if pending_now > HIGH_WATERMARK {
            eprintln!(
                "[pty pid={}] reader: PAUSE (pending={} > HIGH={})",
                pid, pending_now, HIGH_WATERMARK
            );
            let (lock, cvar) = &*session.flow_pair;
            let mut paused = lock.lock().unwrap();
            *paused = true;
            while *paused && !session.shutdown.load(Ordering::Acquire) {
                paused = cvar.wait(paused).unwrap();
            }
            let after = session.pending.load(Ordering::Acquire);
            eprintln!("[pty pid={}] reader: RESUME (pending={})", pid, after);
            if session.shutdown.load(Ordering::Acquire) {
                break;
            }
        }

        // ---- blocking read ----
        let n = match reader.read(&mut buf) {
            Ok(0) => {
                eprintln!(
                    "[pty pid={}] reader: EOF after {} chunks / {} bytes",
                    pid, emit_count, total_emitted
                );
                session.reader_closed.store(true, Ordering::Release);
                break;
            }
            Ok(n) => n,
            Err(e) => {
                eprintln!("[pty pid={}] reader: io error: {}", pid, e);
                session.reader_closed.store(true, Ordering::Release);
                break;
            }
        };

        // ---- UTF-8 safe split (avoid cutting a multi-byte char) ----
        carry.extend_from_slice(&buf[..n]);
        let valid_len = match std::str::from_utf8(&carry) {
            Ok(_) => carry.len(),
            Err(e) => e.valid_up_to(),
        };

        let to_send: Vec<u8> = if valid_len == 0 {
            // Carry is entirely a partial UTF-8 sequence right now.
            // Normally tiny (1-3 bytes). Wait for more bytes.
            // Safety valve: if it grew abnormally (binary stream), flush as-is.
            if carry.len() > CARRY_FLUSH_LIMIT {
                eprintln!(
                    "[pty pid={}] reader: carry too large ({}), flushing as binary",
                    pid,
                    carry.len()
                );
                std::mem::take(&mut carry)
            } else {
                continue;
            }
        } else {
            carry.drain(..valid_len).collect()
        };

        let size = to_send.len();
        let prev_pending = session.pending.fetch_add(size, Ordering::SeqCst);
        let new_pending = prev_pending + size;
        emit_count += 1;
        total_emitted += size as u64;

        // Throttle per-chunk log: first 5 chunks, then every 100. Critical
        // events (pause/resume/ack-crossing/errors) below are always logged.
        if emit_count <= 5 || emit_count % 100 == 0 {
            eprintln!(
                "[pty pid={}] reader: emit#{} size={} pending={} carry={} total={}B",
                pid, emit_count, size, new_pending, carry.len(), total_emitted
            );
        }

        if let Err(e) = on_data.send(InvokeResponseBody::Raw(to_send)) {
            eprintln!("[pty pid={}] reader: channel send failed: {}", pid, e);
            session.reader_closed.store(true, Ordering::Release);
            break;
        }
    }

    eprintln!("[pty pid={}] reader thread exit", pid);
}

#[tauri::command]
pub async fn pty_spawn<R: Runtime>(
    file: String,
    args: Vec<String>,
    term_name: Option<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    encoding: Option<String>,
    handle_flow_control: Option<bool>,
    flow_control_pause: Option<String>,
    flow_control_resume: Option<String>,
    on_data: Channel<InvokeResponseBody>,
    state: tauri::State<'_, PtyState>,
    _app_handle: AppHandle<R>,
) -> Result<u32, String> {
    let _ = encoding;
    let _ = handle_flow_control;
    let _ = flow_control_pause;
    let _ = flow_control_resume;

    let cols = cols.max(1);
    let rows = rows.max(1);
    let pid = state.session_id.fetch_add(1, Ordering::Relaxed);

    eprintln!(
        "[pty pid={}] spawn: file={} args={:?} cols={} rows={} cwd={:?}",
        pid, file, args, cols, rows, cwd
    );

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| {
            eprintln!("[pty pid={}] openpty error: {}", pid, e);
            e.to_string()
        })?;

    let writer = pair.master.take_writer().map_err(|e| {
        eprintln!("[pty pid={}] take_writer error: {}", pid, e);
        e.to_string()
    })?;
    let reader = pair.master.try_clone_reader().map_err(|e| {
        eprintln!("[pty pid={}] try_clone_reader error: {}", pid, e);
        e.to_string()
    })?;

    let term_name = term_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value != "Terminal")
        .unwrap_or_else(|| "xterm-256color".to_string());

    let mut cmd = CommandBuilder::new(&file);
    cmd.args(args);

    if let Some(cwd_raw) = cwd {
        // Windows: CreateProcessW misbehaves on cwd with forward slashes.
        // Normalize to backslashes there.
        #[cfg(target_os = "windows")]
        let cwd_norm = cwd_raw.replace('/', "\\");
        #[cfg(not(target_os = "windows"))]
        let cwd_norm = cwd_raw;
        eprintln!("[pty pid={}] cwd: {}", pid, cwd_norm);
        cmd.cwd(OsString::from(cwd_norm));
    }
    cmd.env(OsString::from("TERM"), OsString::from(&term_name));
    cmd.env(OsString::from("COLORTERM"), OsString::from("truecolor"));
    cmd.env(OsString::from("CLICOLOR"), OsString::from("1"));
    cmd.env(OsString::from("TERM_PROGRAM"), OsString::from("Shelf"));

    let user_keys: Vec<&String> = env.keys().collect();
    eprintln!(
        "[pty pid={}] env: TERM={} user_keys={:?}",
        pid, term_name, user_keys
    );
    for (k, v) in env.iter() {
        cmd.env(OsString::from(k), OsString::from(v));
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        eprintln!("[pty pid={}] spawn_command error: {}", pid, e);
        e.to_string()
    })?;
    let child_killer = child.clone_killer();
    let master = pair.master;
    drop(pair.slave);

    let session = Arc::new(PtySession {
        master: Mutex::new(master),
        child: Mutex::new(child),
        child_killer: Mutex::new(child_killer),
        writer: Mutex::new(writer),
        pending: AtomicUsize::new(0),
        ack_count: AtomicU64::new(0),
        flow_pair: Arc::new((Mutex::new(false), Condvar::new())),
        shutdown: AtomicBool::new(false),
        reader_closed: AtomicBool::new(false),
        child_exited: AtomicBool::new(false),
    });

    let session_for_thread = session.clone();
    thread::Builder::new()
        .name(format!("pty-reader-{}", pid))
        .spawn(move || reader_thread(pid, reader, session_for_thread, on_data))
        .map_err(|e| {
            eprintln!("[pty pid={}] reader thread spawn error: {}", pid, e);
            e.to_string()
        })?;

    state.sessions.write().await.insert(pid, session);
    eprintln!("[pty pid={}] spawn OK", pid);
    Ok(pid)
}

#[tauri::command]
pub async fn pty_write(
    pid: u32,
    data: String,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    let n = data.len();
    tauri::async_runtime::spawn_blocking(move || {
        session
            .writer
            .lock()
            .map_err(|e| e.to_string())?
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    eprintln!("[pty pid={}] write {} bytes", pid, n);
    Ok(())
}

#[tauri::command]
pub async fn pty_ack(
    pid: u32,
    bytes: u64,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    let session = match state.sessions.read().await.get(&pid).cloned() {
        Some(s) => s,
        None => return Ok(()), // session already gone; ack is a no-op
    };
    let bytes = bytes as usize;
    if bytes == 0 {
        return Ok(());
    }
    let prev = session.pending.fetch_sub(bytes, Ordering::SeqCst);
    let now = prev.saturating_sub(bytes);
    let count = session.ack_count.fetch_add(1, Ordering::Relaxed) + 1;
    // Resume reader if we crossed below the low watermark
    let crossed = prev > LOW_WATERMARK && now <= LOW_WATERMARK;
    if crossed {
        let (lock, cvar) = &*session.flow_pair;
        let mut paused = lock.lock().unwrap();
        *paused = false;
        cvar.notify_all();
        eprintln!(
            "[pty pid={}] ack#{} {} pending {}->{} (LOW={}) CROSSED, notify",
            pid, count, bytes, prev, now, LOW_WATERMARK
        );
    } else if count <= 5 || count % 100 == 0 {
        eprintln!(
            "[pty pid={}] ack#{} {} pending {}->{}",
            pid, count, bytes, prev, now
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn pty_resize(
    pid: u32,
    cols: u16,
    rows: u16,
    pixel_width: Option<u16>,
    pixel_height: Option<u16>,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    let cols = cols.max(1);
    let rows = rows.max(1);
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    eprintln!(
        "[pty pid={}] resize cols={} rows={} px={}x{}",
        pid,
        cols,
        rows,
        pixel_width.unwrap_or(0),
        pixel_height.unwrap_or(0)
    );
    session
        .master
        .lock()
        .map_err(|e| e.to_string())?
        .resize(PtySize {
            rows,
            cols,
            pixel_width: pixel_width.unwrap_or(0),
            pixel_height: pixel_height.unwrap_or(0),
        })
        .map_err(|e| {
            eprintln!("[pty pid={}] resize error: {}", pid, e);
            e.to_string()
        })?;
    Ok(())
}

#[tauri::command]
pub async fn pty_kill(pid: u32, state: tauri::State<'_, PtyState>) -> Result<(), String> {
    let Some(session) = state.sessions.write().await.remove(&pid) else {
        eprintln!("[pty pid={}] kill: session not in registry (no-op)", pid);
        return Ok(());
    };
    eprintln!("[pty pid={}] kill requested", pid);
    session.shutdown.store(true, Ordering::Release);
    // Wake the reader if it's blocked on the condvar
    {
        let (lock, cvar) = &*session.flow_pair;
        let mut paused = lock.lock().unwrap();
        *paused = false;
        cvar.notify_all();
    }
    let session_kill = session.clone();
    tauri::async_runtime::spawn_blocking(move || {
        session_kill
            .child_killer
            .lock()
            .map_err(|e| e.to_string())?
            .kill()
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    eprintln!("[pty pid={}] kill OK", pid);
    Ok(())
}

#[tauri::command]
pub async fn pty_exitstatus(pid: u32, state: tauri::State<'_, PtyState>) -> Result<u32, String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    let wait_session = session.clone();
    let exit_code = tauri::async_runtime::spawn_blocking(move || {
        wait_session
            .child
            .lock()
            .map_err(|e| e.to_string())?
            .wait()
            .map(|s| s.exit_code())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    session.child_exited.store(true, Ordering::Release);
    eprintln!("[pty pid={}] child exit code={}", pid, exit_code);
    remove_session_if_done(pid, &session, &state).await;
    Ok(exit_code)
}
