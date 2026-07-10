use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

use hudhook::inject::Process;

const DX11_PAYLOAD_NAME: &str = "hudhook_imgui_overlay_dx11.dll";

enum Selector {
    ProcessName(String),
    WindowTitle(String),
}

struct Arguments {
    selector: Selector,
    payload_path: PathBuf,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            eprintln!();
            print_usage();
            ExitCode::from(1)
        }
    }
}

fn run() -> Result<(), String> {
    let raw_arguments: Vec<String> = env::args().skip(1).collect();
    if raw_arguments
        .iter()
        .any(|argument| argument == "--help" || argument == "-h")
    {
        print_usage();
        return Ok(());
    }

    let arguments = parse_arguments(raw_arguments)?;
    let payload_path = arguments
        .payload_path
        .canonicalize()
        .map_err(|error| format!("cannot resolve payload DLL: {error}"))?;

    if !payload_path.is_file() {
        return Err(format!("payload is not a file: {}", payload_path.display()));
    }

    let process = match &arguments.selector {
        Selector::ProcessName(name) => {
            println!("Target process: {name}");
            Process::by_name(name)
                .map_err(|error| format!("cannot open process named {name:?}: {error:?}"))?
        }
        Selector::WindowTitle(title) => {
            println!("Target window: {title}");
            Process::by_title(title)
                .map_err(|error| format!("cannot open window titled {title:?}: {error:?}"))?
        }
    };

    println!("Payload DLL: {}", payload_path.display());
    println!("Backend: Direct3D 11");

    process
        .inject(payload_path.clone())
        .map_err(|error| format!("hudhook injection request failed: {error:?}"))?;

    println!("Injection request completed.");
    println!(
        "Confirm success from the visible overlay and its PID-suffixed log beside {} (or under %TEMP%\\electron-game-overlay if that directory is not writable).",
        payload_path.display()
    );

    Ok(())
}

fn parse_arguments(raw_arguments: Vec<String>) -> Result<Arguments, String> {
    let mut process_name = None;
    let mut window_title = None;
    let mut backend = None;
    let mut payload_path = None;
    let mut index = 0;

    while index < raw_arguments.len() {
        let flag = &raw_arguments[index];
        index += 1;

        let value = raw_arguments
            .get(index)
            .ok_or_else(|| format!("missing value for {flag}"))?
            .clone();
        index += 1;

        match flag.as_str() {
            "--process" => set_once(&mut process_name, value, "--process")?,
            "--title" => set_once(&mut window_title, value, "--title")?,
            "--backend" => set_once(&mut backend, value, "--backend")?,
            "--dll" => set_once(&mut payload_path, PathBuf::from(value), "--dll")?,
            _ => return Err(format!("unknown argument: {flag}")),
        }
    }

    let selector = match (process_name, window_title) {
        (Some(name), None) => Selector::ProcessName(name),
        (None, Some(title)) => Selector::WindowTitle(title),
        (Some(_), Some(_)) => return Err("use exactly one of --process or --title".into()),
        (None, None) => return Err("one of --process or --title is required".into()),
    };

    match backend.as_deref() {
        Some("d3d11") => {}
        Some(value) => return Err(format!("unsupported backend {value:?}; expected d3d11")),
        None => return Err("--backend d3d11 is required".into()),
    }

    let payload_path = match payload_path {
        Some(path) => path,
        None => env::current_exe()
            .map_err(|error| format!("cannot resolve injector path: {error}"))?
            .parent()
            .ok_or_else(|| "injector path has no parent directory".to_string())?
            .join(DX11_PAYLOAD_NAME),
    };

    Ok(Arguments {
        selector,
        payload_path,
    })
}

fn set_once<T>(slot: &mut Option<T>, value: T, flag: &str) -> Result<(), String> {
    if slot.replace(value).is_some() {
        Err(format!("{flag} was provided more than once"))
    } else {
        Ok(())
    }
}

fn print_usage() {
    eprintln!(
        "Usage:\n  \
         hudhook_overlay_injector.exe (--process <exe> | --title <window>) \
         --backend d3d11 [--dll <payload.dll>]\n\n\
         Examples:\n  \
         hudhook_overlay_injector.exe --title \"Controlled D3D11 overlay test host\" \
         --backend d3d11\n  \
         hudhook_overlay_injector.exe --process game.exe --backend d3d11"
    );
}
