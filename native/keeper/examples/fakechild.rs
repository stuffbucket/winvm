use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::time::{Duration, Instant};

static HANDLED: AtomicI32 = AtomicI32::new(0);
static QUIT: AtomicBool = AtomicBool::new(false);
static POWERED_DOWN: AtomicBool = AtomicBool::new(false);

struct Monitor {
    path: PathBuf,
    report: PathBuf,
    status: String,
    migrate_ms: Option<u64>,
    on_powerdown: String,
    on_quit: String,
}

fn qmp_answer(monitor: &Monitor, started: Instant, cancelled: &mut bool, command: &str) -> String {
    let migrating = !*cancelled
        && monitor
            .migrate_ms
            .is_some_and(|ms| started.elapsed() < Duration::from_millis(ms));
    match command {
        "query-status" => format!(r#"{{"return":{{"status":"{}"}}}}"#, monitor.status),
        "query-migrate" if migrating => r#"{"return":{"status":"active"}}"#.to_owned(),
        "query-migrate" if *cancelled => r#"{"return":{"status":"cancelled"}}"#.to_owned(),
        "query-migrate" if monitor.migrate_ms.is_some() => {
            r#"{"return":{"status":"completed"}}"#.to_owned()
        }
        "migrate_cancel" => {
            *cancelled = true;
            r#"{"return":{}}"#.to_owned()
        }
        "system_powerdown" => {
            if monitor.on_powerdown == "exit" {
                POWERED_DOWN.store(true, Ordering::SeqCst);
            }
            "{\"event\":\"POWERDOWN\"}\n{\"return\":{}}".to_owned()
        }
        "qmp_capabilities" | "query-migrate" | "cont" | "quit" => r#"{"return":{}}"#.to_owned(),
        _ => r#"{"error":{"class":"CommandNotFound","desc":"unknown"}}"#.to_owned(),
    }
}

fn serve_client(monitor: &Monitor, started: Instant, cancelled: &mut bool, stream: UnixStream) {
    let mut report = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&monitor.report)
        .expect("open the report");
    let mut writer = stream.try_clone().expect("clone the stream");
    writeln!(writer, r#"{{"QMP":{{"version":{{}},"capabilities":[]}}}}"#).expect("greet");
    for line in BufReader::new(stream).lines() {
        let Ok(line) = line else { return };
        let request: serde_json::Value = serde_json::from_str(&line).expect("a QMP request");
        let command = request["execute"].as_str().unwrap_or("").to_owned();
        writeln!(report, "qmp {command}").expect("write the report");
        let answer = qmp_answer(monitor, started, cancelled, &command);
        if writeln!(writer, "{answer}").is_err() {
            return;
        }
        if command == "quit" && monitor.on_quit == "exit" {
            std::process::exit(0);
        }
    }
}

fn serve_qmp(monitor: &Monitor) {
    let _ = std::fs::remove_file(&monitor.path);
    let listener = UnixListener::bind(&monitor.path).expect("bind the QMP socket");
    let started = Instant::now();
    let mut cancelled = false;
    for stream in listener.incoming().flatten() {
        serve_client(monitor, started, &mut cancelled, stream);
    }
}

extern "C" fn on_signal(signal: libc::c_int) {
    if signal == libc::SIGUSR1 {
        QUIT.store(true, Ordering::SeqCst);
    } else {
        HANDLED.store(signal, Ordering::SeqCst);
    }
}

fn install(signal: libc::c_int) {
    let handler: extern "C" fn(libc::c_int) = on_signal;
    // SAFETY: a zeroed sigaction is a valid starting value; the handler only stores to atomics.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = handler as libc::sighandler_t;
        libc::sigemptyset(&raw mut action.sa_mask);
        libc::sigaction(signal, &raw const action, std::ptr::null_mut());
    }
}

fn blocked() -> libc::sigset_t {
    // SAFETY: the set is initialised by sigemptyset before pthread_sigmask writes the current mask into it.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&raw mut set);
        libc::pthread_sigmask(libc::SIG_BLOCK, std::ptr::null(), &raw mut set);
        set
    }
}

fn pending_term() -> bool {
    // SAFETY: sigpending fills the zeroed set, and sigismember only reads it.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigpending(&raw mut set);
        libc::sigismember(&raw const set, libc::SIGTERM) == 1
    }
}

fn lock(path: &Path) -> File {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .expect("open the pidfile");
    // SAFETY: a zeroed flock is valid; fcntl reads it and the descriptor is open.
    let locked = unsafe {
        let mut lock: libc::flock = std::mem::zeroed();
        lock.l_type = libc::F_WRLCK;
        lock.l_whence = libc::c_short::try_from(libc::SEEK_SET).unwrap_or_default();
        libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &raw const lock)
    };
    assert_eq!(locked, 0, "lock the pidfile");
    file.set_len(0).expect("truncate the pidfile");
    writeln!(file, "{}", std::process::id()).expect("write the pidfile");
    file
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let report_path = args
        .first()
        .expect("usage: fakechild REPORT [--pidfile P] [--exit CODE --after-ms N]");
    let mut report = OpenOptions::new()
        .create(true)
        .append(true)
        .open(report_path)
        .expect("open the report");
    let value = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    for signal in [libc::SIGTERM, libc::SIGHUP, libc::SIGINT, libc::SIGUSR1] {
        install(signal);
    }
    let _held = value("--pidfile").map(|p| lock(Path::new(&p)));
    if let Some(path) = value("--touch") {
        File::create(path).expect("create the touched file");
    }
    if let Some(path) = value("--qmp") {
        let monitor = Monitor {
            path: PathBuf::from(path),
            report: PathBuf::from(report_path),
            status: value("--status").unwrap_or_else(|| "running".to_owned()),
            migrate_ms: value("--migrate-ms").map(|m| m.parse().expect("--migrate-ms N")),
            on_powerdown: value("--powerdown").unwrap_or_else(|| "exit".to_owned()),
            on_quit: value("--quit").unwrap_or_else(|| "exit".to_owned()),
        };
        std::thread::spawn(move || serve_qmp(&monitor));
    }
    let mask = blocked();
    let member = |signal| {
        // SAFETY: sigismember only reads the set returned by blocked().
        u8::from(unsafe { libc::sigismember(&raw const mask, signal) } == 1)
    };
    writeln!(
        report,
        "blocked TERM={} HUP={} INT={} pid={}",
        member(libc::SIGTERM),
        member(libc::SIGHUP),
        member(libc::SIGINT),
        std::process::id()
    )
    .expect("write the report");
    let exit_code: Option<i32> = value("--exit").map(|c| c.parse().expect("--exit CODE"));
    let after =
        Duration::from_millis(value("--after-ms").map_or(0, |m| m.parse().expect("--after-ms N")));
    let started = Instant::now();
    let mut said_pending = false;
    loop {
        let handled = HANDLED.swap(0, Ordering::SeqCst);
        if handled != 0 {
            writeln!(report, "handled {handled}").expect("write the report");
        }
        if !said_pending && pending_term() {
            said_pending = true;
            writeln!(report, "pending TERM").expect("write the report");
        }
        if QUIT.load(Ordering::SeqCst) {
            writeln!(report, "quit").expect("write the report");
            std::process::exit(0);
        }
        if POWERED_DOWN.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(100));
            writeln!(report, "shut down").expect("write the report");
            std::process::exit(0);
        }
        if let Some(code) = exit_code {
            if started.elapsed() >= after {
                std::process::exit(code);
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
