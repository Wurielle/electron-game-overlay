use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

use hudhook::inject::Process;

const DX11_PAYLOAD_NAME: &str = "hudhook_imgui_overlay_dx11.dll";
const DX12_PAYLOAD_NAME: &str = "hudhook_imgui_overlay_dx12.dll";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Backend {
    D3d11,
    D3d12,
}

impl Backend {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "d3d11" => Ok(Self::D3d11),
            "d3d12" => Ok(Self::D3d12),
            _ => Err(format!(
                "unsupported backend {value:?}; expected d3d11 or d3d12"
            )),
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::D3d11 => "Direct3D 11",
            Self::D3d12 => "Direct3D 12",
        }
    }

    const fn payload_name(self) -> &'static str {
        match self {
            Self::D3d11 => DX11_PAYLOAD_NAME,
            Self::D3d12 => DX12_PAYLOAD_NAME,
        }
    }
}

enum Selector {
    ProcessName(String),
    WindowTitle(String),
}

struct Arguments {
    selector: Selector,
    backend: Backend,
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
    println!("Backend: {}", arguments.backend.label());

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

    let backend = backend
        .as_deref()
        .ok_or_else(|| "--backend d3d11 or d3d12 is required".to_string())
        .and_then(Backend::parse)?;

    let payload_path = match payload_path {
        Some(path) => path,
        None => env::current_exe()
            .map_err(|error| format!("cannot resolve injector path: {error}"))?
            .parent()
            .ok_or_else(|| "injector path has no parent directory".to_string())?
            .join(backend.payload_name()),
    };

    Ok(Arguments {
        selector,
        backend,
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
         --backend <d3d11|d3d12> [--dll <payload.dll>]\n\n\
         Examples:\n  \
         hudhook_overlay_injector.exe --title \"Controlled D3D11 overlay test host\" \
         --backend d3d11\n  \
         hudhook_overlay_injector.exe --title \"Controlled D3D12 overlay test host\" \
         --backend d3d12\n  \
         hudhook_overlay_injector.exe --process game.exe --backend d3d12"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_contract_selects_matching_labels_and_payloads() {
        assert_eq!(Backend::parse("d3d11"), Ok(Backend::D3d11));
        assert_eq!(Backend::D3d11.label(), "Direct3D 11");
        assert_eq!(Backend::D3d11.payload_name(), DX11_PAYLOAD_NAME);

        assert_eq!(Backend::parse("d3d12"), Ok(Backend::D3d12));
        assert_eq!(Backend::D3d12.label(), "Direct3D 12");
        assert_eq!(Backend::D3d12.payload_name(), DX12_PAYLOAD_NAME);
    }

    #[test]
    fn d3d12_uses_the_matching_default_payload() {
        let arguments = parse_arguments(vec![
            "--title".into(),
            "Controlled D3D12 overlay test host".into(),
            "--backend".into(),
            "d3d12".into(),
        ])
        .expect("D3D12 arguments should parse");

        assert_eq!(arguments.backend, Backend::D3d12);
        assert_eq!(
            arguments
                .payload_path
                .file_name()
                .and_then(|name| name.to_str()),
            Some(DX12_PAYLOAD_NAME)
        );
    }

    #[test]
    fn explicit_payload_is_preserved_for_either_backend() {
        let arguments = parse_arguments(vec![
            "--process".into(),
            "game.exe".into(),
            "--backend".into(),
            "d3d12".into(),
            "--dll".into(),
            "custom.dll".into(),
        ])
        .expect("an explicit payload should parse");

        assert_eq!(arguments.payload_path, PathBuf::from("custom.dll"));
    }

    #[test]
    fn unsupported_backend_reports_both_supported_values() {
        let error = Backend::parse("vulkan").expect_err("Vulkan is not supported by this POC");
        assert!(error.contains("expected d3d11 or d3d12"));
    }
}
