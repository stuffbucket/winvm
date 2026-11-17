use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::time::Duration;

pub enum Event {
    Signal(i32),
    Exit(i32),
    Readable,
}

pub struct Kqueue {
    fd: OwnedFd,
}

fn change(ident: usize, filter: i16, flags: u16, notes: u32) -> libc::kevent {
    libc::kevent {
        ident,
        filter,
        flags,
        fflags: notes,
        data: 0,
        udata: std::ptr::null_mut(),
    }
}

impl Kqueue {
    pub fn new() -> io::Result<Self> {
        // SAFETY: kqueue takes no arguments and returns a new descriptor or -1.
        let fd = unsafe { libc::kqueue() };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: fd is a freshly created descriptor that nothing else owns.
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        Ok(Self { fd })
    }

    fn apply(&self, event: &libc::kevent) -> io::Result<()> {
        // SAFETY: one valid change record in, no event buffer out.
        let got = unsafe {
            libc::kevent(
                self.fd.as_raw_fd(),
                std::ptr::from_ref(event),
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        };
        if got < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    pub fn watch_signal(&self, signal: i32) -> io::Result<()> {
        let ident = usize::try_from(signal).map_err(io::Error::other)?;
        self.apply(&change(ident, libc::EVFILT_SIGNAL, libc::EV_ADD, 0))
    }

    pub fn watch_exit(&self, pid: i32) -> io::Result<bool> {
        let ident = usize::try_from(pid).map_err(io::Error::other)?;
        match self.apply(&change(
            ident,
            libc::EVFILT_PROC,
            libc::EV_ADD | libc::EV_ONESHOT,
            libc::NOTE_EXIT,
        )) {
            Ok(()) => Ok(true),
            Err(e) if e.raw_os_error() == Some(libc::ESRCH) => Ok(false),
            Err(e) => Err(e),
        }
    }

    pub fn watch_readable(&self, fd: RawFd) -> io::Result<()> {
        let ident = usize::try_from(fd).map_err(io::Error::other)?;
        self.apply(&change(ident, libc::EVFILT_READ, libc::EV_ADD, 0))
    }

    pub fn wait(&self, timeout: Option<Duration>) -> io::Result<Vec<Event>> {
        let limit = timeout.map(|t| libc::timespec {
            tv_sec: libc::time_t::try_from(t.as_secs()).unwrap_or(libc::time_t::MAX),
            tv_nsec: libc::c_long::from(t.subsec_nanos()),
        });
        let mut out = [change(0, 0, 0, 0); 16];
        let capacity = libc::c_int::try_from(out.len()).map_err(io::Error::other)?;
        // SAFETY: the output buffer holds `capacity` records and the timeout, if any, outlives the call.
        let got = unsafe {
            libc::kevent(
                self.fd.as_raw_fd(),
                std::ptr::null(),
                0,
                out.as_mut_ptr(),
                capacity,
                limit.as_ref().map_or(std::ptr::null(), std::ptr::from_ref),
            )
        };
        if got < 0 {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::Interrupted {
                Ok(Vec::new())
            } else {
                Err(error)
            };
        }
        let got = usize::try_from(got).map_err(io::Error::other)?;
        Ok(out[..got]
            .iter()
            .filter_map(|e| {
                let ident = i32::try_from(e.ident).ok()?;
                match e.filter {
                    libc::EVFILT_SIGNAL => Some(Event::Signal(ident)),
                    libc::EVFILT_PROC => Some(Event::Exit(ident)),
                    libc::EVFILT_READ => Some(Event::Readable),
                    _ => None,
                }
            })
            .collect())
    }
}
