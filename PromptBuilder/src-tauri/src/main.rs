use clap::{Parser, Subcommand};
use gemma4_prompt_builder_core::{Turn, format_prompt};

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
pub struct Args {
    #[command(subcommand)]
    pub command: Option<Commands>,

    /// JSON string representing the prompt structure
    #[arg(short, long)]
    pub json: Option<String>,

    /// Path to a JSON file representing the prompt structure
    #[arg(short, long)]
    pub file: Option<String>,
}

#[derive(Subcommand, Debug, Clone)]
pub enum Commands {
    /// Run as an MCP (Model Context Protocol) server over stdio
    Mcp,
}

fn main() {
    // If we're running in CLI mode, don't initialize the GUI subsystem.
    // This makes it safe for headless/server environments.
    let args = Args::parse();

    if let Some(Commands::Mcp) = &args.command {
        run_mcp_server();
        return;
    }

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

fn run_mcp_server() {
    use std::io::{self, BufRead};

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };

        let request: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let method = request.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let id = request.get("id");

        match method {
            "initialize" => {
                let response = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {
                            "tools": {}
                        },
                        "serverInfo": {
                            "name": "gemma4-prompter",
                            "version": "0.1.0"
                        }
                    }
                });
                println!("{}", response);
            }
            "tools/list" => {
                let response = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "tools": [
                            {
                                "name": "format_gemma4_prompt",
                                "description": "Converts a structured JSON list of turns into a perfectly formatted Gemma 4 raw prompt. \
                                                RULES: \
                                                - system: UNIQUE turn and MUST be the first turn. Uses 'systemtext' (instructions) and 'toolschema' (declarations). Set 'thinking_enabled: true' to enable global thoughts. \
                                                - user: uses 'answer' (text) and 'image'/'audio' (multimodal). \
                                                - model: supports ANY amount and ANY order of 'thinking', 'answer', 'toolcall', and 'toolcall'. Interleaving is allowed.",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "turns": {
                                            "type": "array",
                                            "description": "Sequence of turns (system, user, model).",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "role": { "type": "string", "enum": ["system", "user", "model"] },
                                                    "thinking_enabled": { "type": "boolean", "description": "Used only in 'system' role for global thinking toggle." },
                                                    "components": {
                                                        "type": "array",
                                                        "description": "Block components within the turn.",
                                                        "items": {
                                                            "type": "object",
                                                            "properties": {
                                                                "ctype": { "type": "string", "enum": ["answer", "thinking", "toolcall", "toolresponse", "systemtext", "toolschema", "image", "audio"] },
                                                                "data": {
                                                                    "type": "object",
                                                                    "description": "Component payload. 'text' field for text types. 'name'/'args' for tools."
                                                                }
                                                            },
                                                            "required": ["ctype", "data"]
                                                        }
                                                    }
                                                },
                                                "required": ["role", "components"]
                                            }
                                        }
                                    },
                                    "required": ["turns"]
                                }
                            }
                        ]
                    }
                });
                println!("{}", response);
            }
            "tools/call" => {
                let params = request.get("params");
                let name = params.and_then(|p| p.get("name")).and_then(|v| v.as_str()).unwrap_or("");
                
                if name == "format_gemma4_prompt" {
                    let arguments = params.and_then(|p| p.get("arguments"));
                    let turns_val = arguments.and_then(|a| a.get("turns"));
                    
                    if let Some(turns_val) = turns_val {
                        match serde_json::from_value::<Vec<Turn>>(turns_val.clone()) {
                            Ok(turns) => {
                                let output = format_prompt(&turns);
                                let response = serde_json::json!({
                                    "jsonrpc": "2.0",
                                    "id": id,
                                    "result": {
                                        "content": [
                                            {
                                                "type": "text",
                                                "text": output
                                            }
                                        ]
                                    }
                                });
                                println!("{}", response);
                            }
                            Err(e) => {
                                let error_resp = serde_json::json!({
                                    "jsonrpc": "2.0",
                                    "id": id,
                                    "error": { "code": -32602, "message": format!("Invalid turns structure: {}", e) }
                                });
                                println!("{}", error_resp);
                            }
                        }
                    }
                }
            }
            "notifications/initialized" => {
                // Ignore
            }
            _ => {
                if let Some(id) = id {
                    let response = serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32601, "message": "Method not found" }
                    });
                    println!("{}", response);
                }
            }
        }
    }
}
