use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub struct KVItem {
    #[serde(default)]
    pub id: usize,
    pub key: String,
    pub val: String,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub struct ToolArg {
    #[serde(default)]
    pub id: usize,
    pub name: String,
    pub arg_type: String, 
    pub description: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ComponentType {
    Answer,
    Thinking,
    ToolCall,
    ToolResponse,
    SystemText,
    ToolSchema,
    Image,
    Audio,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum CompData {
    Text(String), 
    ToolCall { name: String, args: Vec<KVItem> },
    ToolResponse { name: String, args: Vec<KVItem> },
    ToolSchema { name: String, description: String, args: Vec<ToolArg> },
    Multimodal(String),
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub struct Component {
    #[serde(default)]
    pub id: usize,
    pub ctype: ComponentType,
    pub data: CompData,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum TurnRole {
    System,
    User,
    Model,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub struct Turn {
    #[serde(default)]
    pub id: usize,
    pub role: TurnRole,
    #[serde(default)]
    pub thinking_enabled: bool,
    pub components: Vec<Component>,
}

pub fn format_prompt(turns: &[Turn]) -> String {
    let mut out = String::new();
    let escape_str = |s: &str| s.replace("\"", "<|\"|>");

    for t in turns {
        match t.role {
            TurnRole::System => {
                out.push_str("<|turn>system\n");
                
                if t.thinking_enabled {
                    out.push_str("<|think|>");
                }
                
                for c in &t.components {
                    match &c.data {
                        CompData::Text(txt) => {
                            if !txt.is_empty() {
                                out.push_str(txt);
                            }
                        }
                        CompData::ToolSchema { name, description, args } => {
                            let mut args_out = String::new();
                            let mut required = Vec::new();
                            
                            let valid_args: Vec<_> = args.iter().filter(|a| !a.name.trim().is_empty()).collect();
                            for (i, arg) in valid_args.iter().enumerate() {
                                if i > 0 { args_out.push(','); }
                                args_out.push_str(arg.name.trim());
                                args_out.push_str(":{");
                                
                                let mut has_first = false;
                                if !arg.description.trim().is_empty() {
                                    args_out.push_str("description:<|\"|>");
                                    args_out.push_str(arg.description.trim());
                                    args_out.push_str("<|\"|>");
                                    has_first = true;
                                }
                                
                                if has_first { args_out.push(','); }
                                let t_str = if arg.arg_type.trim().is_empty() { "STRING" } else { arg.arg_type.trim() };
                                args_out.push_str("type:<|\"|>");
                                args_out.push_str(&t_str.to_uppercase());
                                args_out.push_str("<|\"|>");
                                args_out.push('}');
                                
                                required.push(format!("<|\"|>{}<|\"|>", arg.name.trim()));
                            }
                            
                            let mut out_str = format!("<|tool>declaration:{}{{", name.trim());
                            let mut has_part = false;
                            if !description.trim().is_empty() {
                                out_str.push_str("description:<|\"|>");
                                out_str.push_str(description.trim());
                                out_str.push_str("<|\"|>");
                                has_part = true;
                            }
                            
                            if !valid_args.is_empty() {
                                if has_part { out_str.push(','); }
                                out_str.push_str("parameters:{properties:{");
                                out_str.push_str(&args_out);
                                out_str.push_str(" },");
                                if !required.is_empty() {
                                    out_str.push_str("required:[");
                                    out_str.push_str(&required.join(","));
                                    out_str.push_str("],");
                                }
                                out_str.push_str("type:<|\"|>OBJECT<|\"|>} ");
                            }
                            out_str.push_str("}<tool|>");
                            out.push_str(&out_str);
                        }
                        _ => {}
                    }
                }
                out.push_str("<turn|>\n");
            }
            TurnRole::User => {
                out.push_str("<|turn>user\n");
                for c in &t.components {
                    match &c.data {
                        CompData::Text(txt) => out.push_str(txt),
                        CompData::Multimodal(tok) => out.push_str(tok),
                        _ => {}
                    }
                }
                out.push_str("<turn|>\n");
            }
            TurnRole::Model => {
                out.push_str("<|turn>model\n");
                for c in &t.components {
                    match &c.data {
                        CompData::Text(txt) => {
                            if c.ctype == ComponentType::Answer {
                                out.push_str(txt);
                            } else if c.ctype == ComponentType::Thinking {
                                out.push_str("<|channel>thought\n");
                                out.push_str(txt);
                                out.push_str("<channel|>");
                            }
                        }
                        CompData::ToolCall { name, args } | CompData::ToolResponse { name, args } => {
                            let mut args_chars = String::new();
                            let valid_args: Vec<_> = args.iter().filter(|kv| !kv.key.trim().is_empty()).collect();
                            for (i, kv) in valid_args.iter().enumerate() {
                                if i > 0 { args_chars.push(','); }
                                args_chars.push_str(kv.key.trim());
                                args_chars.push(':');
                                
                                let val_str = kv.val.trim();
                                if val_str == "true" || val_str == "false" || val_str.parse::<f64>().is_ok() {
                                    args_chars.push_str(val_str);
                                } else {
                                    args_chars.push_str("<|\"|>");
                                    args_chars.push_str(&escape_str(val_str));
                                    args_chars.push_str("<|\"|>");
                                }
                            }
                            
                            if c.ctype == ComponentType::ToolCall {
                                out.push_str(&format!("<|tool_call>call:{}{{{}}}<tool_call|>", name, args_chars));
                            } else {
                                out.push_str(&format!("<|tool_response>response:{}{{{}}}<tool_response|>", name, args_chars));
                            }
                        }
                        _ => {}
                    }
                }
                out.push_str("<turn|>\n");
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format() {
        let turns = vec![
            Turn {
                id: 0,
                role: TurnRole::User,
                thinking_enabled: false,
                components: vec![Component {
                    id: 0,
                    ctype: ComponentType::Answer,
                    data: CompData::Text("Hello".to_string()),
                }],
            }
        ];
        let result = format_prompt(&turns);
        assert_eq!(result, "<|turn>user\nHello<turn|>\n");
    }
}
