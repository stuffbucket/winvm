//! The machines' in-guest agents, called by the app directly over HTTP: a few
//! milliseconds a call, where running the winvm CLI costs a process start
//! (~0.7 s). For anything that calls often: a live resize, the meters, the
//! Files window.
//!
//! The address and token come from `winvm agent -i NAME connect --json`, run
//! once per machine (it also installs or updates the agent if need be) and
//! kept. A call that cannot reach the agent, or is refused its token, forgets
//! them and asks again once: the machine restarted (a new forward), or the
//! agent was reinstalled. A connect that failed is not tried again for a few
//! seconds, so a machine still starting is not asked on every call.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::async_runtime::Mutex as AsyncMutex;
use tauri_plugin_shell::ShellExt;

/// After a failed connect, calls fail at once for this long.
const RETRY_AFTER: Duration = Duration::from_secs(10);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Where an agent is and its token, as `winvm agent connect --json` prints them.
#[derive(Clone, Deserialize)]
struct Link {
    url: String,
    token: String,
}

#[derive(Default)]
struct Cache {
    links: HashMap<String, Link>,
    failed: HashMap<String, (Instant, String)>,
}

/// One HTTP client for every agent (it keeps their connections open), and what each machine's connect said.
pub struct Agents {
    http: Result<reqwest::Client, String>,
    cache: Mutex<Cache>,
    /// One connect at a time, so calls arriving together run the CLI once.
    connecting: AsyncMutex<()>,
}

impl Default for Agents {
    fn default() -> Self {
        // reqwest here has rustls without a crypto provider (the updater's
        // choice of features), and panics building a client unless one is
        // set: the one the updater installs, before it would.
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        // Agents are on loopback: never through a system proxy.
        let http = reqwest::Client::builder().no_proxy().build().map_err(|e| e.to_string());
        Agents { http, cache: Mutex::default(), connecting: AsyncMutex::new(()) }
    }
}

/// What the agent answered: its HTTP status, and its body (JSON, or the text when it isn't).
#[derive(Debug, Serialize)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
}

/// An instance name as winvm makes them; anything else never reaches the CLI.
fn valid_instance(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.') && !name.starts_with(['.', '-'])
}

/// A path on the agent: absolute, no scheme or host smuggled in.
fn valid_path(path: &str) -> bool {
    path.starts_with('/') && !path.starts_with("//") && !path.contains("://") && !path.contains(char::is_whitespace)
}

/// Only the agent's loopback forward.
fn valid_url(url: &str) -> bool {
    url.strip_prefix("http://127.0.0.1:").is_some_and(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
}

/// `winvm agent connect --json`'s answer.
fn parse_link(stdout: &str) -> Result<Link, String> {
    let link: Link = serde_json::from_str(stdout.trim()).map_err(|e| format!("winvm agent connect said: {e}"))?;
    if !valid_url(&link.url) || link.token.is_empty() {
        return Err(format!("not an agent address: {}", link.url));
    }
    Ok(link)
}

enum Failure {
    /// Never reached the agent, or it refused the token: worth a fresh link.
    Unreachable(String),
    Other(String),
}

impl Agents {
    fn client(&self) -> Result<&reqwest::Client, String> {
        self.http.as_ref().map_err(|e| format!("no HTTP client: {e}"))
    }

    fn forget(&self, instance: &str) {
        if let Ok(mut c) = self.cache.lock() {
            c.links.remove(instance);
        }
    }

    fn cached(&self, instance: &str) -> Result<Option<Link>, String> {
        let c = self.cache.lock().map_err(|e| e.to_string())?;
        if let Some(link) = c.links.get(instance) {
            return Ok(Some(link.clone()));
        }
        match c.failed.get(instance) {
            Some((at, why)) if at.elapsed() < RETRY_AFTER => Err(why.clone()),
            _ => Ok(None),
        }
    }

    /// The machine's agent: as kept, or asked of the CLI.
    async fn link(&self, app: &tauri::AppHandle, instance: &str) -> Result<Link, String> {
        if let Some(link) = self.cached(instance)? {
            return Ok(link);
        }
        let _one = self.connecting.lock().await;
        if let Some(link) = self.cached(instance)? {
            return Ok(link);
        }
        let got = connect(app, instance).await;
        let mut c = self.cache.lock().map_err(|e| e.to_string())?;
        match got {
            Ok(link) => {
                c.failed.remove(instance);
                c.links.insert(instance.to_owned(), link.clone());
                Ok(link)
            }
            Err(why) => {
                c.failed.insert(instance.to_owned(), (Instant::now(), why.clone()));
                Err(why)
            }
        }
    }

    async fn send(&self, link: &Link, method: &reqwest::Method, path: &str, body: Option<&Value>, timeout: Duration) -> Result<Reply, Failure> {
        let mut req = self.client().map_err(Failure::Other)?.request(method.clone(), format!("{}{}", link.url, path)).bearer_auth(&link.token).timeout(timeout);
        if let Some(b) = body {
            req = req.json(b);
        }
        let res = req.send().await.map_err(|e| if e.is_timeout() { Failure::Other(e.to_string()) } else { Failure::Unreachable(e.to_string()) })?;
        let status = res.status().as_u16();
        if status == 401 {
            return Err(Failure::Unreachable("the agent refused the token".into()));
        }
        let text = res.text().await.map_err(|e| Failure::Other(e.to_string()))?;
        let body = serde_json::from_str(&text).unwrap_or(Value::String(text));
        Ok(Reply { status, body })
    }

    /// One call to a machine's agent, with a fresh link and a second try if the kept one no longer works.
    pub async fn fetch(&self, app: &tauri::AppHandle, instance: &str, method: &str, path: &str, body: Option<&Value>, timeout: Duration) -> Result<Reply, String> {
        if !valid_instance(instance) {
            return Err(format!("not a machine name: {instance}"));
        }
        if !valid_path(path) {
            return Err(format!("not an agent path: {path}"));
        }
        let method = match method {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            "PUT" => reqwest::Method::PUT,
            "DELETE" => reqwest::Method::DELETE,
            _ => return Err(format!("not a method the agent takes: {method}")),
        };
        let link = self.link(app, instance).await?;
        match self.send(&link, &method, path, body, timeout).await {
            Ok(reply) => Ok(reply),
            Err(Failure::Other(why)) => Err(why),
            Err(Failure::Unreachable(_)) => {
                self.forget(instance);
                let link = self.link(app, instance).await?;
                self.send(&link, &method, path, body, timeout).await.map_err(|f| {
                    self.forget(instance);
                    match f {
                        Failure::Unreachable(why) | Failure::Other(why) => why,
                    }
                })
            }
        }
    }
}

async fn connect(app: &tauri::AppHandle, instance: &str) -> Result<Link, String> {
    let out = app
        .shell()
        .sidecar("winvm")
        .map_err(|e| e.to_string())?
        .args(["agent", "-i", instance, "connect", "--json"])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let said = String::from_utf8_lossy(&out.stderr).trim().trim_start_matches("::error::").to_owned();
        return Err(if said.is_empty() { format!("winvm agent connect exited {:?}", out.status.code()) } else { said });
    }
    parse_link(&String::from_utf8_lossy(&out.stdout))
}

/// A request to a machine's agent (`GET /stats`, `POST /display`, …): its status and body.
/// Fails only when the agent can't be reached; an error status comes back as a reply.
#[tauri::command]
pub async fn agent_fetch(
    app: tauri::AppHandle,
    agents: tauri::State<'_, Agents>,
    instance: String,
    method: String,
    path: String,
    body: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Reply, String> {
    let timeout = timeout_ms.map(Duration::from_millis).unwrap_or(DEFAULT_TIMEOUT);
    agents.fetch(&app, &instance, &method, &path, body.as_ref(), timeout).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_only_the_loopback_forward_from_connect() {
        let link = parse_link("{\"url\":\"http://127.0.0.1:59949\",\"token\":\"abc\",\"version\":7}\n").unwrap();
        assert_eq!((link.url.as_str(), link.token.as_str()), ("http://127.0.0.1:59949", "abc"));
        assert!(parse_link("{\"url\":\"http://example.com:80\",\"token\":\"abc\"}").is_err());
        assert!(parse_link("{\"url\":\"http://127.0.0.1:80/x\",\"token\":\"abc\"}").is_err());
        assert!(parse_link("{\"url\":\"http://127.0.0.1:80\",\"token\":\"\"}").is_err());
        assert!(parse_link("::error::not running").is_err());
    }

    #[test]
    fn checks_names_and_paths_before_anything_runs() {
        assert!(valid_instance("polish-test") && valid_instance("demo_2") && valid_instance("a.b"));
        assert!(!valid_instance("") && !valid_instance("-i") && !valid_instance("a b") && !valid_instance("../x") && !valid_instance(".hidden"));
        assert!(valid_path("/display") && valid_path("/fs/list?path=C%3A%5C"));
        assert!(!valid_path("display") && !valid_path("//evil/x") && !valid_path("/x://y") && !valid_path("/a b"));
    }
}
