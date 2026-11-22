use std::fs::OpenOptions;
use std::io;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, ExitStatus, Stdio};

use serde_json::Value;

use crate::state::CommandSpec;

pub const SHIELDED: [libc::c_int; 3] = [libc::SIGTERM, libc::SIGHUP, libc::SIGINT];

fn empty_set() -> libc::sigset_t {
    // SAFETY: sigset_t is plain data, and sigemptyset initialises it.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&raw mut set);
        set
    }
}

pub fn pending_shutdown() -> Option<libc::c_int> {
    let mut pending = empty_set();
    // SAFETY: sigpending writes into an initialised set, and sigismember only reads it.
    unsafe {
        libc::sigpending(&raw mut pending);
        [libc::SIGTERM, libc::SIGINT]
            .into_iter()
            .find(|&signal| libc::sigismember(&raw const pending, signal) == 1)
    }
}

pub fn shield_set() -> libc::sigset_t {
    // SAFETY: sigset_t is plain data; sigemptyset initialises it and sigaddset only adds valid signals.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&raw mut set);
        for signal in SHIELDED {
            libc::sigaddset(&raw mut set, signal);
        }
        set
    }
}

pub fn block_in_this_process() -> io::Result<()> {
    let mut set = shield_set();
    // SAFETY: the set is initialised, and SIGCHLD is a valid signal.
    unsafe { libc::sigaddset(&raw mut set, libc::SIGCHLD) };
    // SAFETY: the set is initialised and the old mask is not wanted.
    match unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &raw const set, std::ptr::null_mut()) } {
        0 => Ok(()),
        error => Err(io::Error::from_raw_os_error(error)),
    }
}

fn output(spec: &CommandSpec) -> io::Result<(Stdio, Stdio)> {
    let Some(path) = &spec.log else {
        return Ok((Stdio::null(), Stdio::null()));
    };
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)?;
    Ok((Stdio::from(file.try_clone()?), Stdio::from(file)))
}

pub fn spawn(
    spec: &CommandSpec,
    extra_env: &[(&str, String)],
    own_group: bool,
) -> io::Result<Child> {
    let (program, args) = spec
        .argv
        .split_first()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "argv is empty"))?;
    let (stdout, stderr) = output(spec)?;
    let mut command = Command::new(program);
    command
        .args(args)
        .envs(&spec.env)
        .envs(extra_env.iter().map(|(k, v)| (*k, v.as_str())))
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);
    if own_group {
        command.process_group(0);
    }
    let mask = if spec.shield {
        shield_set()
    } else {
        empty_set()
    };
    let umask = spec
        .umask
        .map(|bits| libc::mode_t::try_from(bits & 0o777).unwrap_or(0o077));
    // SAFETY: the hook runs between fork and exec and calls only pthread_sigmask and umask, which are async-signal-safe, on values built before the fork.
    unsafe {
        command.pre_exec(move || {
            if let Some(bits) = umask {
                libc::umask(bits);
            }
            match libc::pthread_sigmask(libc::SIG_SETMASK, &raw const mask, std::ptr::null_mut()) {
                0 => Ok(()),
                error => Err(io::Error::from_raw_os_error(error)),
            }
        });
    }
    command.spawn()
}

fn signal_raw(target: i32, signal: libc::c_int) -> bool {
    // SAFETY: kill(2) has no memory-safety requirements.
    unsafe { libc::kill(target, signal) == 0 }
}

pub fn kill(pid: i32, signal: libc::c_int) -> bool {
    pid > 1 && signal_raw(pid, signal)
}

pub fn kill_group(group: i32, signal: libc::c_int) -> bool {
    group > 1 && signal_raw(-group, signal)
}

pub fn exit_fields(status: ExitStatus) -> Vec<(&'static str, Value)> {
    match (status.code(), status.signal()) {
        (Some(code), _) => vec![("status", code.into())],
        (None, signal) => vec![
            ("signal", signal.unwrap_or(0).into()),
            ("core", status.core_dumped().into()),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_argv_is_refused() {
        let spec = CommandSpec {
            argv: Vec::new(),
            env: std::collections::BTreeMap::new(),
            log: None,
            shield: true,
            umask: None,
        };
        assert_eq!(
            spawn(&spec, &[], false).map(|_| ()).map_err(|e| e.kind()),
            Err(io::ErrorKind::InvalidInput)
        );
    }

    fn self_term(shield: bool) -> ExitStatus {
        let spec = CommandSpec {
            argv: ["/bin/sh", "-c", "kill -TERM $$; sleep 0.2; exit 0"]
                .map(str::to_owned)
                .to_vec(),
            env: std::collections::BTreeMap::new(),
            log: None,
            shield,
            umask: None,
        };
        spawn(&spec, &[], false)
            .expect("spawn")
            .wait()
            .expect("wait")
    }

    fn set_thread_mask(how: libc::c_int) {
        let set = shield_set();
        // SAFETY: changes only this test thread's mask, with an initialised set.
        unsafe { libc::pthread_sigmask(how, &raw const set, std::ptr::null_mut()) };
    }

    #[test]
    fn a_shielded_child_keeps_term_blocked_even_from_an_unblocked_parent() {
        set_thread_mask(libc::SIG_UNBLOCK);
        assert_eq!(self_term(true).code(), Some(0));
        assert_eq!(self_term(false).signal(), Some(libc::SIGTERM));
    }

    #[test]
    fn an_unshielded_child_starts_unblocked_even_from_a_blocked_parent() {
        set_thread_mask(libc::SIG_BLOCK);
        let unshielded = self_term(false);
        let shielded = self_term(true);
        set_thread_mask(libc::SIG_UNBLOCK);
        assert_eq!(unshielded.signal(), Some(libc::SIGTERM));
        assert_eq!(shielded.code(), Some(0));
    }

    #[test]
    fn kill_reaches_one_real_process_and_never_minus_one_zero_or_one() {
        for pid in [-1, 0, 1] {
            assert!(!kill(pid, 0), "kill({pid})");
        }
        let own = i32::try_from(std::process::id()).expect("a pid");
        assert!(kill(own, 0));
    }

    #[test]
    fn kill_group_never_reaches_every_process_or_this_group() {
        for group in [-5, 0, 1] {
            assert!(!kill_group(group, 0), "kill_group({group})");
        }
    }

    #[test]
    fn exit_fields_carry_a_status_or_a_signal() {
        assert_eq!(
            exit_fields(ExitStatus::from_raw(7 << 8)),
            vec![("status", Value::from(7))]
        );
        assert_eq!(
            exit_fields(ExitStatus::from_raw(9)),
            vec![("signal", Value::from(9)), ("core", Value::from(false))]
        );
    }
}
