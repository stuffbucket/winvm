use std::fs::OpenOptions;
use std::io;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, ExitStatus, Stdio};

use serde_json::Value;

use crate::state::CommandSpec;

pub const SHIELDED: [libc::c_int; 3] = [libc::SIGTERM, libc::SIGHUP, libc::SIGINT];

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
    let set = shield_set();
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
    if spec.shield {
        let set = shield_set();
        // SAFETY: the hook runs between fork and exec and calls only pthread_sigmask, which is async-signal-safe, on a set built before the fork.
        unsafe {
            command.pre_exec(move || {
                match libc::pthread_sigmask(libc::SIG_BLOCK, &raw const set, std::ptr::null_mut()) {
                    0 => Ok(()),
                    error => Err(io::Error::from_raw_os_error(error)),
                }
            });
        }
    }
    command.spawn()
}

pub fn kill(pid: i32, signal: libc::c_int) -> bool {
    // SAFETY: kill(2) has no memory-safety requirements.
    unsafe { libc::kill(pid, signal) == 0 }
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
        };
        assert_eq!(
            spawn(&spec, &[], false).map(|_| ()).map_err(|e| e.kind()),
            Err(io::ErrorKind::InvalidInput)
        );
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
