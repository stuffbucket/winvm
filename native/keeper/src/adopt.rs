use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use crate::state::Kept;

fn whole_file_write_lock() -> libc::flock {
    // SAFETY: flock is a plain C struct for which all-zero bytes are a valid value.
    let mut lock: libc::flock = unsafe { std::mem::zeroed() };
    lock.l_type = libc::F_WRLCK;
    lock.l_whence = libc::c_short::try_from(libc::SEEK_SET).unwrap_or_default();
    lock
}

pub fn lock_holder(path: &Path) -> Option<i32> {
    let file = File::open(path).ok()?;
    let mut lock = whole_file_write_lock();
    // SAFETY: the descriptor is open for the duration of the call and F_GETLK writes into a valid flock.
    let got = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETLK, &raw mut lock) };
    if got != 0 {
        return None;
    }
    holder_of(&lock)
}

fn holder_of(lock: &libc::flock) -> Option<i32> {
    (lock.l_type != libc::F_UNLCK && lock.l_pid > 0).then_some(lock.l_pid)
}

pub fn hold(path: &Path) -> io::Result<Option<File>> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)?;
    let lock = whole_file_write_lock();
    // SAFETY: the descriptor is open and F_SETLK only reads the flock.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &raw const lock) } != 0 {
        let error = io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::EAGAIN | libc::EACCES) => Ok(None),
            _ => Err(error),
        };
    }
    file.set_len(0)?;
    writeln!(file, "{}", std::process::id())?;
    Ok(Some(file))
}

pub fn start_time_us(pid: i32) -> Option<u64> {
    // SAFETY: proc_bsdinfo is a plain C struct for which all-zero bytes are a valid value.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).ok()?;
    // SAFETY: the buffer is a proc_bsdinfo of exactly `size` bytes, as PROC_PIDTBSDINFO expects.
    let got =
        unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size) };
    (got == size).then(|| info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
}

pub fn boot_session() -> Option<String> {
    let mut buffer = [0u8; 64];
    let mut size = buffer.len();
    // SAFETY: the name is NUL-terminated, and the output buffer is writable for `size` bytes.
    let got = unsafe {
        libc::sysctlbyname(
            c"kern.bootsessionuuid".as_ptr(),
            buffer.as_mut_ptr().cast(),
            &raw mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if got != 0 {
        return None;
    }
    let text = buffer.get(..size)?;
    let text = text.split(|&b| b == 0).next()?;
    let uuid = std::str::from_utf8(text).ok()?.trim();
    (!uuid.is_empty()).then(|| uuid.to_owned())
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn lstart_epoch(text: &str) -> Option<i64> {
    let fields: Vec<&str> = text.split_whitespace().collect();
    let [_, month, day, time, year] = fields.as_slice() else {
        return None;
    };
    let month = i64::try_from(MONTHS.iter().position(|m| m == month)?).ok()? + 1;
    let day: i64 = day.parse().ok()?;
    let year: i64 = year.parse().ok()?;
    let clock: Vec<i64> = time
        .split(':')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    let [h, m, sec] = clock.as_slice() else {
        return None;
    };
    Some(days_from_civil(year, month, day) * 86_400 + h * 3600 + m * 60 + sec)
}

pub fn started_as(pid: i32, lstart: &str) -> bool {
    let (Some(said), Some(us)) = (lstart_epoch(lstart), start_time_us(pid)) else {
        return false;
    };
    let actual = i64::try_from(us / 1_000_000).unwrap_or(i64::MAX);
    (actual - said).abs() <= 1
}

pub fn identify(kept: &Kept) -> Option<&'static str> {
    if kept.pid <= 1 {
        return None;
    }
    if let Some(pidfile) = &kept.pidfile {
        if let Some(holder) = lock_holder(pidfile) {
            return (holder == kept.pid).then_some("pidfile");
        }
    }
    (kept.start_us != 0 && start_time_us(kept.pid) == Some(kept.start_us)).then_some("start-time")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_process_has_a_start_time_and_a_lock_it_holds_names_it() {
        let me = i32::try_from(std::process::id()).expect("a pid");
        assert!(start_time_us(me).is_some_and(|t| t > 0));
        let path = std::env::temp_dir().join(format!("wka-{me}.pid"));
        let held = hold(&path).expect("open").expect("the lock");
        assert_eq!(
            std::fs::read_to_string(&path).expect("pid").trim(),
            me.to_string()
        );
        assert_eq!(lock_holder(&path), None);
        drop(held);
        std::fs::remove_file(&path).expect("cleanup");
    }

    #[test]
    fn the_boot_session_is_a_stable_uuid() {
        let first = boot_session().expect("kern.bootsessionuuid");
        assert_eq!(first.len(), 36, "{first}");
        assert_eq!(first.matches('-').count(), 4, "{first}");
        assert_eq!(boot_session(), Some(first));
    }

    #[test]
    fn a_lock_held_by_no_single_process_names_no_holder() {
        let mut lock = whole_file_write_lock();
        for pid in [-1, 0] {
            lock.l_pid = pid;
            assert_eq!(holder_of(&lock), None, "l_pid {pid}");
        }
        lock.l_pid = 4242;
        assert_eq!(holder_of(&lock), Some(4242));
        lock.l_type = libc::F_UNLCK;
        assert_eq!(holder_of(&lock), None);
    }

    #[test]
    fn a_state_naming_pid_one_or_less_is_never_identified() {
        for pid in [1, 0, -1] {
            let kept = Kept {
                name: "x".to_owned(),
                pid,
                start_us: start_time_us(pid).unwrap_or(1),
                pidfile: None,
                qmp: None,
                runtime: None,
                legacy: false,
            };
            assert_eq!(identify(&kept), None, "{pid}");
        }
    }

    #[test]
    fn a_ps_start_time_reads_as_seconds_since_the_epoch() {
        assert_eq!(lstart_epoch("Thu Jan  1 00:00:00 1970"), Some(0));
        assert_eq!(
            lstart_epoch("Tue Nov 17 19:35:19 2026"),
            Some(1_794_944_119)
        );
        assert_eq!(
            lstart_epoch("Sun Feb 29 12:00:00 2032"),
            Some(1_961_668_800)
        );
        assert_eq!(lstart_epoch("not a time"), None);
        assert_eq!(lstart_epoch(""), None);
    }

    #[test]
    fn a_process_that_is_gone_is_not_identified() {
        let kept = Kept {
            name: "x".to_owned(),
            pid: i32::MAX,
            start_us: 1,
            pidfile: None,
            qmp: None,
            runtime: None,
            legacy: false,
        };
        assert_eq!(identify(&kept), None);
    }
}
