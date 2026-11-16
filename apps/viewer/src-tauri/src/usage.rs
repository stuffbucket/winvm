use serde::Serialize;
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::agent::Agents;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostUsage {
    cpu_seconds: f64,
    rss_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    at_ms: f64,
    host: Option<HostUsage>,
    guest: Option<Value>,
    guest_error: Option<String>,
}

pub fn parse_ps(out: &str) -> Option<HostUsage> {
    let mut words = out.split_whitespace();
    let time = words.next()?;
    let rss: u64 = words.next()?.parse().ok()?;
    let (days, clock) = match time.split_once('-') {
        Some((d, rest)) => (d.parse::<f64>().ok()?, rest),
        None => (0.0, time),
    };
    let mut seconds = 0.0;
    for part in clock.split(':') {
        seconds = seconds * 60.0 + part.parse::<f64>().ok()?;
    }
    Some(HostUsage { cpu_seconds: days * 86_400.0 + seconds, rss_bytes: rss * 1024 })
}

fn host_usage(pid: u32) -> Option<HostUsage> {
    let out = std::process::Command::new("/bin/ps").args(["-o", "time=,rss=", "-p", &pid.to_string()]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_ps(&String::from_utf8_lossy(&out.stdout))
}

#[tauri::command]
pub async fn instance_usage(app: tauri::AppHandle, agents: tauri::State<'_, Agents>, pid: u32, instance: Option<String>) -> Result<Usage, String> {
    let at_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    let ps = tauri::async_runtime::spawn_blocking(move || host_usage(pid));
    let (guest, guest_error) = match instance {
        None => (None, None),
        Some(name) => match agents.fetch(&app, &name, "GET", "/stats", None, Duration::from_millis(1500)).await {
            Ok(r) if r.status == 200 => (Some(r.body), None),
            Ok(r) => (None, Some(format!("the agent answered {}", r.status))),
            Err(e) => (None, Some(e)),
        },
    };
    let host = ps.await.map_err(|e| e.to_string())?;
    Ok(Usage { at_ms, host, guest, guest_error })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ps_cpu_time_and_rss() {
        assert_eq!(parse_ps("  0:05.67  10240\n"), Some(HostUsage { cpu_seconds: 5.67, rss_bytes: 10_485_760 }));
        assert_eq!(parse_ps("125:01.50 4"), Some(HostUsage { cpu_seconds: 7501.5, rss_bytes: 4096 }));
        assert_eq!(parse_ps("1:02:03.00 1"), Some(HostUsage { cpu_seconds: 3723.0, rss_bytes: 1024 }));
        assert_eq!(parse_ps("2-01:00:00.00 1"), Some(HostUsage { cpu_seconds: 2.0 * 86_400.0 + 3600.0, rss_bytes: 1024 }));
        assert_eq!(parse_ps(""), None);
        assert_eq!(parse_ps("0:01.00"), None);
        assert_eq!(parse_ps("x:01 12"), None);
    }
}
