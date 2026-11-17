use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use serde_json::Value;

pub fn post(socket: &Path, path: &str, body: &Value, timeout: Duration) -> Result<u16, String> {
    let shown = socket.display();
    let stream = UnixStream::connect(socket).map_err(|e| format!("{shown}: {e}"))?;
    stream
        .set_write_timeout(Some(timeout))
        .and_then(|()| stream.set_read_timeout(Some(timeout)))
        .map_err(|e| format!("{shown}: {e}"))?;
    let text = body.to_string();
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    );
    (&stream)
        .write_all(request.as_bytes())
        .map_err(|e| format!("{shown}: {e}"))?;
    let mut status = String::new();
    BufReader::new(&stream)
        .read_line(&mut status)
        .map_err(|e| format!("{shown}: {e}"))?;
    status
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| format!("{shown}: no HTTP answer"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::unix::net::UnixListener;

    #[test]
    fn a_post_sends_its_body_and_reads_the_status_code() {
        let path = std::env::temp_dir().join(format!("wkc-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).expect("bind");
        let serving = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut seen = [0u8; 512];
            let n = stream.read(&mut seen).expect("read");
            stream
                .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n")
                .expect("answer");
            String::from_utf8_lossy(&seen[..n]).into_owned()
        });
        let code = post(
            &path,
            "/host-ending",
            &serde_json::json!({ "deadlineMs": 7 }),
            Duration::from_secs(2),
        );
        let seen = serving.join().expect("join");
        let _ = std::fs::remove_file(&path);
        assert_eq!(code, Ok(202));
        assert!(seen.starts_with("POST /host-ending HTTP/1.1\r\n"), "{seen}");
        assert!(seen.ends_with(r#"{"deadlineMs":7}"#), "{seen}");
    }

    #[test]
    fn a_missing_socket_is_an_error_naming_it() {
        let answer = post(
            Path::new("/nonexistent/control.sock"),
            "/host-ending",
            &Value::Null,
            Duration::from_secs(1),
        );
        assert!(answer.is_err_and(|e| e.contains("/nonexistent/control.sock")));
    }
}
