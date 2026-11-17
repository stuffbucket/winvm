use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::state::SOCKET;

const IO_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const REPLY_TIMEOUT: Duration = Duration::from_millis(200);

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

pub enum Received {
    Pending,
    Line(String),
    Closed,
}

pub struct Connection {
    stream: UnixStream,
    buffer: Vec<u8>,
    pub deadline: Instant,
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

    pub fn accept(&self) -> Vec<Connection> {
        let mut connections = Vec::new();
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    if same_user(&stream) && stream.set_nonblocking(true).is_ok() {
                        connections.push(Connection {
                            stream,
                            buffer: Vec::new(),
                            deadline: Instant::now() + IO_TIMEOUT,
                        });
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return connections,
                Err(e) => {
                    eprintln!("winvm-keeper: accept on {}: {e}", self.path.display());
                    return connections;
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

impl Connection {
    pub fn fd(&self) -> RawFd {
        self.stream.as_raw_fd()
    }

    pub fn read(&mut self) -> Received {
        let mut chunk = [0u8; 4096];
        loop {
            match (&self.stream).read(&mut chunk) {
                Ok(0) => {
                    return if self.buffer.is_empty() {
                        Received::Closed
                    } else {
                        Received::Line(String::from_utf8_lossy(&self.buffer).into_owned())
                    };
                }
                Ok(n) => {
                    self.buffer.extend_from_slice(&chunk[..n]);
                    if self.buffer.len() > MAX_REQUEST_BYTES && !self.buffer.contains(&b'\n') {
                        return Received::Closed;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => return Received::Closed,
            }
        }
        if let Some(end) = self.buffer.iter().position(|&b| b == b'\n') {
            return Received::Line(String::from_utf8_lossy(&self.buffer[..end]).into_owned());
        }
        if self.buffer.len() > MAX_REQUEST_BYTES {
            Received::Closed
        } else {
            Received::Pending
        }
    }

    pub fn reply(&self, answer: &Value) {
        let sent = self
            .stream
            .set_nonblocking(false)
            .and_then(|()| self.stream.set_write_timeout(Some(REPLY_TIMEOUT)))
            .and_then(|()| (&self.stream).write_all(format!("{answer}\n").as_bytes()));
        if let Err(e) = sent {
            eprintln!("winvm-keeper: reply: {e}");
        }
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
