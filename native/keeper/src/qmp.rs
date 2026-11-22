use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const MAX_LINE: usize = 64 * 1024;

struct Session {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    deadline: Instant,
}

impl Session {
    fn next(&mut self) -> Result<Value, String> {
        if Instant::now() >= self.deadline {
            return Err("no answer in time".to_owned());
        }
        let mut line = String::new();
        let read = (&mut self.reader)
            .take(u64::try_from(MAX_LINE).unwrap_or(u64::MAX))
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        if read == 0 {
            return Err("the monitor closed the connection".to_owned());
        }
        serde_json::from_str(&line).map_err(|e| format!("a bad answer: {e}"))
    }

    fn execute(&mut self, command: &str) -> Result<Value, String> {
        writeln!(self.writer, "{}", json!({ "execute": command })).map_err(|e| e.to_string())?;
        loop {
            let answer = self.next()?;
            if let Some(value) = answer.get("return") {
                return Ok(value.clone());
            }
            if let Some(error) = answer.get("error") {
                return Err(error["desc"].as_str().unwrap_or("an error").to_owned());
            }
        }
    }
}

pub fn execute(socket: &Path, command: &str, timeout: Duration) -> Result<Value, String> {
    let stream = UnixStream::connect(socket).map_err(|e| format!("{}: {e}", socket.display()))?;
    stream
        .set_write_timeout(Some(timeout))
        .and_then(|()| stream.set_read_timeout(Some(timeout)))
        .map_err(|e| e.to_string())?;
    let writer = stream.try_clone().map_err(|e| e.to_string())?;
    let mut session = Session {
        reader: BufReader::new(stream),
        writer,
        deadline: Instant::now() + timeout,
    };
    if session.next()?.get("QMP").is_none() {
        return Err("no QMP greeting".to_owned());
    }
    session.execute("qmp_capabilities")?;
    session.execute(command)
}

pub fn migrating(answer: &Value) -> bool {
    !matches!(
        answer["status"].as_str(),
        None | Some("none" | "completed" | "failed" | "cancelled")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    fn monitor(
        script: &'static [&'static str],
    ) -> (std::path::PathBuf, std::thread::JoinHandle<()>) {
        let path =
            std::env::temp_dir().join(format!("wkq-{}-{}.sock", std::process::id(), script.len()));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).expect("bind");
        let serving = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            let mut writer = stream.try_clone().expect("clone");
            let mut reader = BufReader::new(stream);
            writeln!(writer, r#"{{"QMP":{{}}}}"#).expect("greet");
            for answer in script {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    return;
                }
                writeln!(writer, "{answer}").expect("answer");
            }
        });
        (path, serving)
    }

    #[test]
    fn an_answer_skips_events_and_carries_the_return_value() {
        let (path, serving) = monitor(&[
            r#"{"return":{}}"#,
            "{\"event\":\"STOP\"}\n{\"return\":{\"status\":\"paused\"}}",
        ]);
        let answer = execute(&path, "query-status", Duration::from_secs(2));
        serving.join().expect("join");
        let _ = std::fs::remove_file(&path);
        assert_eq!(answer, Ok(json!({ "status": "paused" })));
    }

    #[test]
    fn an_error_answer_is_an_error_with_its_description() {
        let (path, serving) = monitor(&[r#"{"return":{}}"#, r#"{"error":{"desc":"nope"}}"#, "x"]);
        let answer = execute(&path, "cont", Duration::from_secs(2));
        drop(serving);
        let _ = std::fs::remove_file(&path);
        assert_eq!(answer, Err("nope".to_owned()));
    }

    #[test]
    fn a_missing_monitor_is_an_error() {
        let answer = execute(
            Path::new("/nonexistent/qmp.sock"),
            "quit",
            Duration::from_secs(1),
        );
        assert!(answer.is_err_and(|e| e.contains("/nonexistent/qmp.sock")));
    }

    #[test]
    fn only_an_unfinished_migration_counts_as_migrating() {
        assert!(!migrating(&json!({})));
        for done in ["none", "completed", "failed", "cancelled"] {
            assert!(!migrating(&json!({ "status": done })), "{done}");
        }
        for busy in [
            "setup",
            "active",
            "device",
            "pre-switchover",
            "postcopy-active",
        ] {
            assert!(migrating(&json!({ "status": busy })), "{busy}");
        }
    }
}
