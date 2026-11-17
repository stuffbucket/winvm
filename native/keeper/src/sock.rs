use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::state::SOCKET;

const IO_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_REQUEST_BYTES: u64 = 64 * 1024;

pub struct Server {
    listener: UnixListener,
    path: PathBuf,
}

fn same_user(stream: &UnixStream) -> bool {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    // SAFETY: the descriptor is a connected socket and both out-pointers are valid for writes.
    let got = unsafe { libc::getpeereid(stream.as_raw_fd(), &raw mut uid, &raw mut gid) };
    // SAFETY: geteuid has no preconditions.
    got == 0 && uid == unsafe { libc::geteuid() }
}

impl Server {
    pub fn bind(dir: &Path) -> io::Result<Self> {
        let path = dir.join(SOCKET);
        match fs::remove_file(&path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        let listener = UnixListener::bind(&path)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        Ok(Self { listener, path })
    }

    pub fn fd(&self) -> RawFd {
        self.listener.as_raw_fd()
    }

    pub fn pending(&self) -> Vec<UnixStream> {
        let mut streams = Vec::new();
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => streams.push(stream),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return streams,
                Err(e) => {
                    eprintln!("winvm-keeper: accept on {}: {e}", self.path.display());
                    return streams;
                }
            }
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub fn read_request(stream: &UnixStream) -> io::Result<Value> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    if !same_user(stream) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "another user",
        ));
    }
    let mut line = String::new();
    BufReader::new(stream.take(MAX_REQUEST_BYTES)).read_line(&mut line)?;
    Ok(serde_json::from_str(&line)
        .unwrap_or_else(|e| json!({ "op": null, "error": e.to_string() })))
}

pub fn reply(mut stream: &UnixStream, answer: &Value) {
    if let Err(e) = stream.write_all(format!("{answer}\n").as_bytes()) {
        eprintln!("winvm-keeper: reply: {e}");
    }
}

pub fn ctl(dir: &Path, message: &str) -> io::Result<String> {
    let request: Value = serde_json::from_str(message)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let mut stream = UnixStream::connect(dir.join(SOCKET))?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    writeln!(stream, "{request}")?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line)?;
    if line.is_empty() {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "no answer"));
    }
    Ok(line.trim_end().to_owned())
}
