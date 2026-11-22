mod adopt;
mod control;
mod keeper;
mod kq;
mod qmp;
mod record;
mod sock;
mod spawn;
mod state;

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

pub const PROTOCOL: u32 = 3;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

const USAGE: &str = "usage: winvm-keeper run --dir DIR [--exit-timeout SECONDS] [--budget-ms MS]
       winvm-keeper ctl --dir DIR JSON
       winvm-keeper version";

const DEFAULT_EXIT_TIMEOUT_SECS: u64 = 60;
const LAUNCHD_MARGIN: Duration = Duration::from_secs(5);

fn usage(problem: &str) -> ExitCode {
    eprintln!("winvm-keeper: {problem}\n{USAGE}");
    ExitCode::from(2)
}

struct Flags {
    dir: Option<PathBuf>,
    exit_timeout: Duration,
    budget: Option<Duration>,
    rest: Vec<String>,
}

fn number(flag: &str, value: Option<&String>) -> Result<u64, String> {
    value
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| format!("{flag} needs a whole number"))
}

fn flags(args: &[String]) -> Result<Flags, String> {
    let mut parsed = Flags {
        dir: None,
        exit_timeout: Duration::from_secs(DEFAULT_EXIT_TIMEOUT_SECS),
        budget: None,
        rest: Vec::new(),
    };
    let mut items = args.iter();
    while let Some(arg) = items.next() {
        match arg.as_str() {
            "--dir" => parsed.dir = Some(items.next().ok_or("--dir needs a directory")?.into()),
            "--exit-timeout" => {
                parsed.exit_timeout = Duration::from_secs(number(arg, items.next())?);
            }
            "--budget-ms" => {
                parsed.budget = Some(Duration::from_millis(number(arg, items.next())?));
            }
            _ => parsed.rest.push(arg.clone()),
        }
    }
    Ok(parsed)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((command, rest)) = args.split_first() else {
        return usage("no command");
    };
    if command == "version" || command == "--version" {
        println!("winvm-keeper {VERSION} protocol {PROTOCOL}");
        return ExitCode::SUCCESS;
    }
    let parsed = match flags(rest) {
        Ok(parsed) => parsed,
        Err(problem) => return usage(&problem),
    };
    let Some(dir) = parsed.dir else {
        return usage("--dir is required");
    };
    match command.as_str() {
        "run" if parsed.rest.is_empty() => keeper::run(keeper::Settings {
            dir,
            budget: parsed
                .budget
                .unwrap_or_else(|| parsed.exit_timeout.saturating_sub(LAUNCHD_MARGIN)),
        }),
        "ctl" if parsed.rest.len() == 1 => match sock::ctl(&dir, &parsed.rest[0]) {
            Ok(answer) => {
                println!("{answer}");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("winvm-keeper: {}: {error}", dir.display());
                ExitCode::FAILURE
            }
        },
        _ => usage(&format!("cannot {command} {}", parsed.rest.join(" "))),
    }
}
