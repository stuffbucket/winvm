use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

pub const MAX_LINE_BYTES: usize = 8192;

pub struct Record {
    path: Option<PathBuf>,
    instance: String,
}

fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

pub fn iso(at: SystemTime) -> String {
    let since = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = i64::try_from(since.as_secs()).unwrap_or(i64::MAX);
    let (year, month, day) = civil(secs.div_euclid(86_400));
    let of_day = secs.rem_euclid(86_400);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3600,
        of_day / 60 % 60,
        of_day % 60,
        since.subsec_millis()
    )
}

pub fn epoch_ms(at: SystemTime) -> u64 {
    u64::try_from(
        at.duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

fn generation() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = bytes.iter().fold(String::new(), |mut hex, b| {
        let _ = write!(hex, "{b:02x}");
        hex
    });
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

fn head(at: SystemTime, instance: &str, kind: &str) -> String {
    format!(
        "{{\"t\":{},\"instance\":{},\"kind\":{}",
        Value::from(iso(at)),
        Value::from(instance),
        Value::from(kind)
    )
}

pub fn line(at: SystemTime, instance: &str, what: &str, fields: &[(&str, Value)]) -> String {
    let start = format!(
        "{},\"what\":{}",
        head(at, instance, "keeper"),
        Value::from(what)
    );
    let mut full = start.clone();
    for (key, value) in fields {
        let _ = write!(full, ",{}:{value}", Value::from(*key));
    }
    full.push('}');
    if full.len() < MAX_LINE_BYTES {
        full
    } else {
        format!("{start},\"truncated\":{}}}", full.len())
    }
}

fn header(at: SystemTime, instance: &str) -> io::Result<String> {
    Ok(format!(
        "{},\"generation\":{}}}\n",
        head(at, instance, "generation"),
        Value::from(generation()?)
    ))
}

fn create(path: &Path, instance: &str) -> io::Result<()> {
    let scratch = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        generation()?
    ));
    let written = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&scratch)
        .and_then(|mut file| file.write_all(header(SystemTime::now(), instance)?.as_bytes()));
    let linked = written.and_then(|()| fs::hard_link(&scratch, path));
    let _ = fs::remove_file(&scratch);
    match linked {
        Err(e) if e.kind() != io::ErrorKind::AlreadyExists => Err(e),
        _ => Ok(()),
    }
}

fn open_appending(path: &Path, instance: &str) -> io::Result<File> {
    match OpenOptions::new().append(true).open(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            create(path, instance)?;
            OpenOptions::new().append(true).open(path)
        }
        opened => opened,
    }
}

impl Record {
    pub fn new(path: Option<PathBuf>, instance: String) -> Self {
        Self { path, instance }
    }

    pub fn instance(&self) -> &str {
        &self.instance
    }

    pub fn note(&self, what: &str, fields: &[(&str, Value)]) {
        let text = line(SystemTime::now(), &self.instance, what, fields);
        eprintln!("{text}");
        let Some(path) = &self.path else {
            return;
        };
        let bytes = format!("{text}\n");
        let written =
            open_appending(path, &self.instance).and_then(|mut file| file.write(bytes.as_bytes()));
        match written {
            Ok(n) if n == bytes.len() => {}
            Ok(n) => eprintln!(
                "winvm-keeper: short write to {} ({n} of {})",
                path.display(),
                bytes.len()
            ),
            Err(e) => eprintln!("winvm-keeper: cannot append to {}: {e}", path.display()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    const FIXTURE: &str = include_str!("../tests/fixtures/record.jsonl");

    fn at(ms: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(ms)
    }

    #[test]
    fn iso_matches_known_instants() {
        assert_eq!(iso(at(0)), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(at(951_782_400_000)), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso(at(1_794_898_380_123)), "2026-11-17T06:53:00.123Z");
        assert_eq!(iso(at(4_102_444_799_999)), "2099-12-31T23:59:59.999Z");
    }

    #[test]
    fn the_lines_match_the_shared_golden_fixture() {
        let t = at(1_794_898_380_123);
        let lines = [
            line(
                t,
                "default",
                "started",
                &[("pid", 4242.into()), ("version", "0.1.0".into())],
            ),
            line(
                t,
                "default",
                "launched",
                &[
                    ("child", "qemu".into()),
                    ("pid", 4243.into()),
                    ("program", "/x/qemu-system-aarch64".into()),
                ],
            ),
            line(
                t,
                "default",
                "adopted",
                &[
                    ("child", "qemu".into()),
                    ("pid", 4243.into()),
                    ("by", "pidfile".into()),
                ],
            ),
            line(
                t,
                "default",
                "host-ending",
                &[("signal", "SIGTERM".into()), ("budgetMs", 55_000.into())],
            ),
            line(
                t,
                "default",
                "host-end",
                &[
                    ("step", "stop-action".into()),
                    ("ok", true.into()),
                    ("status", 0.into()),
                    ("ms", 4012.into()),
                ],
            ),
            line(
                t,
                "default",
                "host-end",
                &[("step", "kill".into()), ("pid", 4243.into())],
            ),
            line(
                t,
                "default",
                "exited",
                &[
                    ("child", "qemu".into()),
                    ("pid", 4243.into()),
                    ("signal", 9.into()),
                    ("core", false.into()),
                ],
            ),
            line(
                t,
                "default",
                "exited-unknown",
                &[("child", "qemu".into()), ("pid", 4243.into())],
            ),
            line(t, "default", "host-end", &[("step", "done".into())]),
            line(t, "default", "exiting", &[("reason", "host-end".into())]),
        ];
        assert_eq!(lines.join("\n") + "\n", FIXTURE);
    }

    #[test]
    fn an_oversized_line_keeps_only_its_head() {
        let long = "x".repeat(MAX_LINE_BYTES);
        let text = line(at(0), "i", "launched", &[("program", long.into())]);
        assert!(text.len() < 200);
        let parsed: Value = serde_json::from_str(&text).expect("JSON");
        assert_eq!(parsed["what"], "launched");
        assert!(
            parsed["truncated"].as_u64().is_some_and(|n| n > 8192),
            "{text}"
        );
        assert!(parsed.get("program").is_none());
    }

    #[test]
    fn a_missing_record_gets_one_generation_line_then_appends() {
        let dir = std::env::temp_dir().join(format!("wkr-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("events.jsonl");
        let _ = fs::remove_file(&path);
        let record = Record::new(Some(path.clone()), "box".to_owned());
        record.note("started", &[("pid", 1.into())]);
        record.note("exiting", &[("reason", "idle".into())]);
        let text = fs::read_to_string(&path).expect("the record");
        let lines: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).expect("JSON"))
            .collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["kind"], "generation");
        assert_eq!(lines[0]["instance"], "box");
        assert_eq!(lines[1]["what"], "started");
        assert_eq!(lines[2]["reason"], "idle");
        assert_eq!(fs::read_dir(&dir).expect("listing").count(), 1);
        fs::remove_dir_all(&dir).expect("cleanup");
    }
}
