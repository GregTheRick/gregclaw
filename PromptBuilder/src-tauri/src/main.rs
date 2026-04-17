use clap::Parser;
use gemma4_prompt_builder_core::{Turn, format_prompt};

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// JSON string representing the prompt structure
    #[arg(short, long)]
    json: Option<String>,

    /// Path to a JSON file representing the prompt structure
    #[arg(short, long)]
    file: Option<String>,
}

fn main() {
    // If we're running in CLI mode, don't initialize the GUI subsystem.
    // This makes it safe for headless/server environments.
    let args = Args::parse();

    if let Some(json_str) = args.json {
        match serde_json::from_str::<Vec<Turn>>(&json_str) {
            Ok(turns) => {
                print!("{}", format_prompt(&turns));
                return;
            }
            Err(e) => {
                eprintln!("Error parsing JSON: {}", e);
                std::process::exit(1);
            }
        }
    }

    if let Some(file_path) = args.file {
        match std::fs::read_to_string(file_path) {
            Ok(content) => {
                match serde_json::from_str::<Vec<Turn>>(&content) {
                    Ok(turns) => {
                        print!("{}", format_prompt(&turns));
                        return;
                    }
                    Err(e) => {
                        eprintln!("Error parsing JSON from file: {}", e);
                        std::process::exit(1);
                    }
                }
            }
            Err(e) => {
                eprintln!("Error reading file: {}", e);
                std::process::exit(1);
            }
        }
    }

    tauri_app_lib::run()
}
