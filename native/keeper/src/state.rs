use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const SPEC: &str = "spec.json";
pub const STATE: &str = "state.json";
pub const SOCKET: &str = "keeper.sock";
pub const LOCK: &str = "keeper.pid";

const fn shielded() -> bool {
    true
}

fn child_name() -> String {
    "child".to_owned()
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandSpec {
    pub argv: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub log: Option<PathBuf>,
    #[serde(default = "shielded")]
    pub shield: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildSpec {
    #[serde(default = "child_name")]
    pub name: String,
    pub argv: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub log: Option<PathBuf>,
    #[serde(default = "shielded")]
    pub shield: bool,
    pub pidfile: Option<PathBuf>,
}

impl ChildSpec {
    pub fn command(&self) -> CommandSpec {
        CommandSpec {
            argv: self.argv.clone(),
            env: self.env.clone(),
            log: self.log.clone(),
            shield: self.shield,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spec {
    pub session: Option<String>,
    pub instance: Option<String>,
    pub record: Option<PathBuf>,
    pub linger_ms: Option<u64>,
    pub child: Option<ChildSpec>,
    pub stop: Option<CommandSpec>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Kept {
    pub name: String,
    pub pid: i32,
    pub start_us: u64,
    pub pidfile: Option<PathBuf>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct State {
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub boot_us: u64,
    #[serde(default)]
    pub instance: Option<String>,
    #[serde(default)]
    pub record: Option<PathBuf>,
    #[serde(default)]
    pub stop: Option<CommandSpec>,
    pub child: Option<Kept>,
}

pub fn read_spec(dir: &Path) -> Result<Spec, String> {
    match fs::read_to_string(dir.join(SPEC)) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{SPEC}: {e}")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Spec::default()),
        Err(e) => Err(format!("{SPEC}: {e}")),
    }
}

pub fn read_state(dir: &Path) -> Result<Option<State>, String> {
    match fs::read_to_string(dir.join(STATE)) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("{STATE}: {e}")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{STATE}: {e}")),
    }
}

pub fn write_state(dir: &Path, state: &State) -> io::Result<()> {
    let text = serde_json::to_string(state).map_err(io::Error::other)?;
    let scratch = dir.join(format!("{STATE}.{}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&scratch)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    fs::rename(&scratch, dir.join(STATE))
}

pub fn remove_state(dir: &Path) {
    let _ = fs::remove_file(dir.join(STATE));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_spec_takes_defaults_for_what_it_leaves_out() {
        let spec: Spec = serde_json::from_str(
            r#"{"child":{"argv":["/bin/sleep","9"]},"stop":{"argv":["x"],"shield":false}}"#,
        )
        .expect("a spec");
        let child = spec.child.expect("a child");
        assert_eq!(child.name, "child");
        assert!(child.shield);
        assert!(child.env.is_empty());
        assert_eq!(child.pidfile, None);
        assert!(!spec.stop.expect("a stop action").shield);
        assert_eq!(spec.linger_ms, None);
    }

    #[test]
    fn a_spec_with_an_unknown_field_is_refused() {
        let refused = serde_json::from_str::<Spec>(r#"{"lingerMS":5}"#).map(|_| ());
        assert!(refused.is_err_and(|e| e.to_string().contains("lingerMS")));
        let child =
            serde_json::from_str::<Spec>(r#"{"child":{"argv":["x"],"pidFile":"/p"}}"#).map(|_| ());
        assert!(child.is_err_and(|e| e.to_string().contains("pidFile")));
    }

    #[test]
    fn a_state_from_an_older_keeper_reads_with_defaults() {
        let state: State = serde_json::from_str(r#"{"child":null}"#).expect("a state");
        assert_eq!(state, State::default());
    }

    #[test]
    fn state_round_trips_through_its_file() {
        let dir = std::env::temp_dir().join(format!("wks-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("dir");
        assert_eq!(read_state(&dir), Ok(None));
        let state = State {
            session: Some("s".to_owned()),
            boot_us: 9,
            child: Some(Kept {
                name: "qemu".to_owned(),
                pid: 42,
                start_us: 7,
                pidfile: Some(PathBuf::from("/x/qemu.pid")),
            }),
            ..State::default()
        };
        write_state(&dir, &state).expect("write");
        assert_eq!(read_state(&dir), Ok(Some(state)));
        assert!(fs::read_to_string(dir.join(STATE))
            .expect("text")
            .contains(r#""startUs":7"#));
        remove_state(&dir);
        assert_eq!(read_state(&dir), Ok(None));
        fs::remove_dir_all(&dir).expect("cleanup");
    }
}
