use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;
use yew::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = ["window", "__TAURI__", "core"])]
    async fn invoke(cmd: &str, args: JsValue) -> JsValue;
}

#[derive(Serialize, Deserialize)]
struct StringArg {
    text: String,
}

#[derive(Clone, PartialEq, Debug)]
pub struct KVItem {
    pub id: usize,
    pub key: String,
    pub val: String,
}

#[derive(Clone, PartialEq, Debug)]
pub struct ToolArg {
    pub id: usize,
    pub name: String,
    pub arg_type: String, 
    pub description: String,
}

#[derive(Clone, PartialEq, Debug)]
pub enum ComponentType {
    Answer,
    Thinking,
    ToolCall,
    ToolResponse,
    SystemText,
    ToolSchema,
}

#[derive(Clone, PartialEq, Debug)]
pub enum CompData {
    Text(String), 
    ToolCall { name: String, args: Vec<KVItem> },
    ToolResponse { name: String, args: Vec<KVItem> },
    ToolSchema { name: String, description: String, args: Vec<ToolArg> },
}

#[derive(Clone, PartialEq, Debug)]
pub struct Component {
    pub id: usize,
    pub ctype: ComponentType,
    pub data: CompData,
}

#[derive(Clone, PartialEq, Debug)]
pub enum TurnRole {
    System,
    User,
    Model,
}

#[derive(Clone, PartialEq, Debug)]
pub struct Turn {
    pub id: usize,
    pub role: TurnRole,
    // System
    pub thinking_enabled: bool,
    // User
    pub content: String,
    // Model and System (for orderable subparts)
    pub components: Vec<Component>,
}

fn format_prompt(turns: &[Turn]) -> String {
    let mut out = String::new();
    let escape_str = |s: &str| s.replace("\"", "<|\"|>");

    for t in turns {
        match t.role {
            TurnRole::System => {
                out.push_str("<|turn>system\n");
                
                if t.thinking_enabled {
                    out.push_str("<|think|>\n");
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
                out.push_str(&t.content);
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

#[function_component(App)]
pub fn app() -> Html {
    let turns = use_state(|| vec![
        Turn {
            id: 0,
            role: TurnRole::System,
            content: String::new(),
            thinking_enabled: false,
            components: vec![Component {
                id: 0, ctype: ComponentType::SystemText, data: CompData::Text("You are a helpful AI.".to_string())
            }],
        }
    ]);
    
    let next_id = use_state(|| 1);
    let next_comp_id = use_state(|| 1);
    
    // Track outer turn drag
    let dragged_turn = use_state(|| None::<usize>);

    // Track inner turn component drag -> (turn_index, comp_index)
    let dragged_comp = use_state(|| None::<(usize, usize)>);

    let output = format_prompt(&turns);

    let add_turn = {
        let turns = turns.clone();
        let next_id = next_id.clone();
        Callback::from(move |role: TurnRole| {
            let mut new_turns = (*turns).clone();
            new_turns.push(Turn {
                id: *next_id,
                role,
                content: String::new(),
                thinking_enabled: false,
                components: vec![],
            });
            turns.set(new_turns);
            next_id.set(*next_id + 1);
        })
    };

    let update_turn = {
        let turns = turns.clone();
        Callback::from(move |(id, updated_turn): (usize, Turn)| {
            let mut new_turns = (*turns).clone();
            if let Some(t) = new_turns.iter_mut().find(|t| t.id == id) {
                *t = updated_turn;
            }
            turns.set(new_turns);
        })
    };

    let remove_turn = {
        let turns = turns.clone();
        Callback::from(move |id: usize| {
            let new_turns: Vec<_> = (*turns).iter().filter(|t| t.id != id).cloned().collect();
            turns.set(new_turns);
        })
    };

    let on_drop_turn = {
        let dragged_turn = dragged_turn.clone();
        let turns = turns.clone();
        Callback::from(move |target_index: usize| {
            if let Some(source_index) = *dragged_turn {
                if source_index != target_index {
                    let mut new_turns = (*turns).clone();
                    let item = new_turns.remove(source_index);
                    new_turns.insert(target_index, item);
                    turns.set(new_turns);
                }
            }
            dragged_turn.set(None);
        })
    };

    let on_drop_comp = {
        let dragged_comp = dragged_comp.clone();
        let turns = turns.clone();
        Callback::from(move |(target_t_idx, target_c_idx): (usize, usize)| {
            if let Some((src_t_idx, src_c_idx)) = *dragged_comp {
                let mut new_turns = (*turns).clone();
                if new_turns[src_t_idx].role == new_turns[target_t_idx].role {
                    if src_t_idx == target_t_idx {
                        if src_c_idx != target_c_idx && target_c_idx != usize::MAX {
                            let comp = new_turns[src_t_idx].components.remove(src_c_idx);
                            new_turns[target_t_idx].components.insert(target_c_idx, comp);
                        } else if target_c_idx == usize::MAX && src_c_idx != new_turns[target_t_idx].components.len() - 1 {
                            let comp = new_turns[src_t_idx].components.remove(src_c_idx);
                            new_turns[target_t_idx].components.push(comp);
                        }
                    } else {
                        let comp = new_turns[src_t_idx].components.remove(src_c_idx);
                        if target_c_idx == usize::MAX {
                            new_turns[target_t_idx].components.push(comp);
                        } else {
                            let len = new_turns[target_t_idx].components.len();
                            new_turns[target_t_idx].components.insert(target_c_idx.min(len), comp);
                        }
                    }
                    turns.set(new_turns);
                }
            }
            dragged_comp.set(None);
        })
    };

    let on_drag_over = Callback::from(|e: DragEvent| { 
        e.prevent_default(); 
        if let Some(dt) = e.data_transfer() {
            dt.set_drop_effect("move");
        }
    });
    let on_drag_enter = Callback::from(|e: DragEvent| { e.prevent_default(); });

    let next_cid = next_comp_id.clone();
    let add_component = {
        let update_turn = update_turn.clone();
        Callback::from(move |(mut turn, comp_type): (Turn, ComponentType)| {
            let comp_id = *next_cid;
            next_cid.set(comp_id + 1);
            
            let data = match comp_type {
                ComponentType::Answer | ComponentType::Thinking | ComponentType::SystemText => CompData::Text(String::new()),
                ComponentType::ToolCall => CompData::ToolCall { name: String::new(), args: vec![] },
                ComponentType::ToolResponse => CompData::ToolResponse { name: String::new(), args: vec![] },
                ComponentType::ToolSchema => CompData::ToolSchema { name: String::new(), description: String::new(), args: vec![] },
            };
            
            turn.components.push(Component { id: comp_id, ctype: comp_type, data });
            update_turn.emit((turn.id, turn));
        })
    };

    let copy_to_clipboard = {
        let text = output.clone();
        Callback::from(move |_| {
            let text = text.clone();
            spawn_local(async move {
                let args = serde_wasm_bindgen::to_value(&StringArg { text }).unwrap();
                let _ = invoke("copy_to_clipboard", args).await;
            });
        })
    };

    let save_to_file = {
        let text = output.clone();
        Callback::from(move |_| {
            let text = text.clone();
            spawn_local(async move {
                let args = serde_wasm_bindgen::to_value(&StringArg { text }).unwrap();
                let _ = invoke("save_to_file", args).await;
            });
        })
    };

    html! {
        <div class="app-container">
            <div class="sidebar">
                <h1>
                    // Custom SVG icon matching dark theme
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                        <polyline points="3.29 7 12 12 20.71 7"></polyline>
                        <line x1="12" y1="22" x2="12" y2="12"></line>
                    </svg>
                    {"Gemma 4 Builder"}
                </h1>
                <div class="tools-panel">
                    <h3>{"Add Block"}</h3>
                    <button onclick={add_turn.reform(|_| TurnRole::System)}>
                        <span style="color:#A78BFA;">{"⚙️"}</span> {"System"}
                    </button>
                    <button onclick={add_turn.reform(|_| TurnRole::User)}>
                        <span style="color:#60A5FA;">{"👤"}</span> {"User"}
                    </button>
                    <button onclick={add_turn.reform(|_| TurnRole::Model)}>
                        <span style="color:#34D399;">{"🤖"}</span> {"Model"}
                    </button>
                </div>
                <div class="actions">
                    <button onclick={copy_to_clipboard} class="primary">{"Copy Prompt"}</button>
                    <button onclick={save_to_file} class="secondary">{"Save Output"}</button>
                </div>
            </div>
            
            <div class="main-editor">
                <div class="blocks">
                    { for turns.iter().enumerate().map(|(t_idx, turn)| {
                        let id = turn.id;
                        let t = turn.clone();
                        let up = update_turn.clone();
                        
                        let dt = dragged_turn.clone();
                        let idx = t_idx;
                        let on_drag_turn_start = Callback::from(move |e: DragEvent| {
                            if let Some(dt_transfer) = e.data_transfer() { let _ = dt_transfer.set_data("text/plain", &idx.to_string()); }
                            e.stop_propagation();
                            dt.set(Some(idx));
                        });
                        
                        let ot = on_drop_turn.clone();
                        let odc = on_drop_comp.clone();
                        let on_drop_turn_cb = Callback::from(move |e: DragEvent| {
                            e.prevent_default();
                            e.stop_propagation();
                            ot.emit(idx);
                            odc.emit((idx, usize::MAX));
                        });
                        
                        let on_role_change = {
                            let ct = t.clone(); let ut = update_turn.clone();
                            Callback::from(move |e: Event| {
                                let target: web_sys::HtmlSelectElement = e.target_unchecked_into();
                                let mut new_t = ct.clone();
                                new_t.role = match target.value().as_str() {
                                    "System" => TurnRole::System, "User" => TurnRole::User, "Model" => TurnRole::Model, _ => TurnRole::User,
                                };
                                ut.emit((new_t.id, new_t));
                            })
                        };
                        
                        let on_del_turn = remove_turn.reform(move |_| id);
                        
                        html! {
                            <div class="turn-card" draggable="true" ondragstart={on_drag_turn_start} ondrop={on_drop_turn_cb} ondragover={on_drag_over.clone()} ondragenter={on_drag_enter.clone()}>
                                <div class="turn-header" style="cursor: grab;">
                                    <select class="role-select" onchange={on_role_change} onclick={|e:MouseEvent| e.stop_propagation()}>
                                        <option value="System" selected={t.role == TurnRole::System}>{"⚙️ System"}</option>
                                        <option value="User" selected={t.role == TurnRole::User}>{"👤 User"}</option>
                                        <option value="Model" selected={t.role == TurnRole::Model}>{"🤖 Model"}</option>
                                    </select>
                                    <button onclick={on_del_turn} class="delete-btn" title="Remove Turn">{"✕"}</button>
                                </div>
                                
                                <div class="turn-body">
                                    { if t.role == TurnRole::System {
                                        let ct1 = t.clone(); let up1 = up.clone();
                                        let toggle_think = Callback::from(move |_| {
                                            let mut new_t = ct1.clone();
                                            new_t.thinking_enabled = !new_t.thinking_enabled;
                                            up1.emit((id, new_t));
                                        });
                                        html! {
                                            <>
                                                <label class="toggle-switch" style="margin-bottom:0.5rem;">
                                                    <input type="checkbox" checked={t.thinking_enabled} onchange={toggle_think} />
                                                    <div class="toggle-slider"></div>
                                                    <span>{"Enable <|think|> switch"}</span>
                                                </label>
                                                { render_components(&t, t_idx, &dragged_comp, on_drop_comp.clone(), on_drop_turn.clone(), on_drag_over.clone(), on_drag_enter.clone(), up.clone()) }
                                                <div class="add-comp-row">
                                                    <button class="add-comp-btn" onclick={add_component.reform({ let t = t.clone(); move |_| (t.clone(), ComponentType::SystemText) })}>{"+ Text"}</button>
                                                    <button class="add-comp-btn" onclick={add_component.reform({ let t = t.clone(); move |_| (t.clone(), ComponentType::ToolSchema) })}>{"+ Schema"}</button>
                                                </div>
                                            </>
                                        }
                                    } else if t.role == TurnRole::User {
                                        let ct2 = t.clone(); let up2 = up.clone();
                                        let on_content = Callback::from(move |e: InputEvent| {
                                            let input: web_sys::HtmlTextAreaElement = e.target_unchecked_into();
                                            let mut new_t = ct2.clone();
                                            new_t.content = input.value();
                                            up2.emit((id, new_t));
                                        });
                                        html! { <textarea placeholder="User content..." value={t.content.clone()} oninput={on_content}></textarea> }
                                    } else {
                                        html! {
                                            <>
                                                { render_components(&t, t_idx, &dragged_comp, on_drop_comp.clone(), on_drop_turn.clone(), on_drag_over.clone(), on_drag_enter.clone(), up.clone()) }
                                                <div class="add-comp-row">
                                                    <button class="add-comp-btn" onclick={add_component.reform({ let t = t.clone(); move |_| (t.clone(), ComponentType::Answer) })}>{"+ Answer"}</button>
                                                    <button class="add-comp-btn" onclick={add_component.reform({ let t = t.clone(); move |_| (t.clone(), ComponentType::Thinking) })}>{"+ Thinking"}</button>
                                                    <button class="add-comp-btn" onclick={add_component.reform({ let t = t.clone(); move |_| (t.clone(), ComponentType::ToolCall) })}>{"+ Tool Call"}</button>
                                                    <button class="add-comp-btn" onclick={add_component.reform({ let t = t.clone(); move |_| (t.clone(), ComponentType::ToolResponse) })}>{"+ Tool Response"}</button>
                                                </div>
                                            </>
                                        }
                                    } }
                                </div>
                            </div>
                        }
                    }) }
                </div>
            </div>

            <div class="preview-panel">
                <div class="preview-header">{"Live Prompt Output"}</div>
                <div class="preview-content">{ output }</div>
            </div>
        </div>
    }
}

// Extracted inner component render to keep HTML tree clean
fn render_components(
    t: &Turn, t_idx: usize, 
    dragged_comp: &UseStateHandle<Option<(usize, usize)>>,
    on_drop_comp: Callback<(usize, usize)>,
    on_drop_turn: Callback<usize>,
    on_drag_over: Callback<DragEvent>,
    on_drag_enter: Callback<DragEvent>,
    update: Callback<(usize, Turn)>
) -> Html {
    let odp_list = on_drop_comp.clone();
    let ot_list = on_drop_turn.clone();
    let on_drop_list = Callback::from(move |e: DragEvent| {
        e.prevent_default();
        e.stop_propagation();
        odp_list.emit((t_idx, usize::MAX));
        ot_list.emit(t_idx);
    });

    html! {
        <div class="component-list" ondrop={on_drop_list} ondragover={on_drag_over.clone()} ondragenter={on_drag_enter.clone()} style="min-height: 20px;">
            { for t.components.iter().enumerate().map(|(c_idx, c)| {
                let c_id = c.id;
                let c_type = c.ctype.clone();
                let tid = t.id;
                
                let dc = dragged_comp.clone();
                let on_drag_start = Callback::from(move |e: DragEvent| {
                    if let Some(dt) = e.data_transfer() { let _ = dt.set_data("text/plain", &format!("{}-{}", t_idx, c_idx)); }
                    e.stop_propagation();
                    dc.set(Some((t_idx, c_idx)));
                });
                
                let odp = on_drop_comp.clone();
                let ot_child = on_drop_turn.clone();
                let on_drop = Callback::from(move |e: DragEvent| {
                    e.prevent_default();
                    e.stop_propagation();
                    odp.emit((t_idx, c_idx));
                    ot_child.emit(t_idx);
                });
                
                let t_del = t.clone(); let up_del = update.clone();
                let on_del = Callback::from(move |_| {
                    let mut new_t = t_del.clone();
                    new_t.components.retain(|x| x.id != c_id);
                    up_del.emit((tid, new_t));
                });
                
                html! {
                    <div class="comp-card" draggable="true" ondragstart={on_drag_start} ondrop={on_drop} ondragover={on_drag_over.clone()} ondragenter={on_drag_enter.clone()}>
                        <div class="comp-card-header" style="cursor: grab;">
                            <span class="comp-badge">{format!("{:?}", c_type)}</span>
                            <button onclick={on_del} class="delete-btn">{"✕"}</button>
                        </div>
                        
                        { match &c.data {
                            CompData::Text(txt) => {
                                let t_text = t.clone(); let up_text = update.clone();
                                let on_text = Callback::from(move |e: InputEvent| {
                                    let input: web_sys::HtmlTextAreaElement = e.target_unchecked_into();
                                    let mut new_t = t_text.clone();
                                    if let Some(comp) = new_t.components.iter_mut().find(|x| x.id == c_id) {
                                        comp.data = CompData::Text(input.value());
                                    }
                                    up_text.emit((tid, new_t));
                                });
                                let classes = if c_type == ComponentType::Thinking { "thought-input" } else { "" };
                                html! { <textarea class={classes} placeholder="Enter text..." value={txt.clone()} oninput={on_text}></textarea> }
                            },
                            CompData::ToolCall { name, args } | CompData::ToolResponse { name, args } => {
                                let _is_call = matches!(c.data, CompData::ToolCall { .. });
                                
                                let t_name = t.clone(); let up_name = update.clone();
                                let on_name = Callback::from(move |e: InputEvent| {
                                    let input: web_sys::HtmlInputElement = e.target_unchecked_into();
                                    let mut new_t = t_name.clone();
                                    if let Some(comp) = new_t.components.iter_mut().find(|x| x.id == c_id) {
                                        if let CompData::ToolCall { name: ref mut n, .. } | CompData::ToolResponse { name: ref mut n, .. } = comp.data {
                                            *n = input.value();
                                        }
                                    }
                                    up_name.emit((tid, new_t));
                                });
                                
                                let t_add = t.clone(); let up_add = update.clone();
                                let add_arg = Callback::from(move |_| {
                                    let mut new_t = t_add.clone();
                                    if let Some(comp) = new_t.components.iter_mut().find(|x| x.id == c_id) {
                                        if let CompData::ToolCall { ref mut args, .. } | CompData::ToolResponse { ref mut args, .. } = comp.data {
                                            let max_id = args.iter().map(|a| a.id).max().unwrap_or(0);
                                            args.push(KVItem { id: max_id + 1, key: String::new(), val: String::new() });
                                        }
                                    }
                                    up_add.emit((tid, new_t));
                                });

                                html! {
                                    <div style="display:flex; flex-direction:column; gap:0.5rem;">
                                        <input type="text" placeholder="Function Name" value={name.clone()} oninput={on_name} />
                                        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:0.25rem;">{"Arguments:"}</div>
                                        { for args.iter().map(|kv| {
                                            let kv_id = kv.id;
                                            
                                            let t_k = t.clone(); let up_k = update.clone();
                                            let on_key = Callback::from(move |e: InputEvent| {
                                                let input: web_sys::HtmlInputElement = e.target_unchecked_into();
                                                let mut new_t = t_k.clone();
                                                if let Some(comp) = new_t.components.iter_mut().find(|x| x.id == c_id) {
                                                    if let CompData::ToolCall { ref mut args, .. } | CompData::ToolResponse { ref mut args, .. } = comp.data {
                                                        if let Some(a) = args.iter_mut().find(|x| x.id == kv_id) { a.key = input.value(); }
                                                    }
                                                }
                                                up_k.emit((tid, new_t));
                                            });
                                            
                                            let t_v = t.clone(); let up_v = update.clone();
                                            let on_val = Callback::from(move |e: InputEvent| {
                                                let input: web_sys::HtmlInputElement = e.target_unchecked_into();
                                                let mut new_t = t_v.clone();
                                                if let Some(comp) = new_t.components.iter_mut().find(|x| x.id == c_id) {
                                                    if let CompData::ToolCall { ref mut args, .. } | CompData::ToolResponse { ref mut args, .. } = comp.data {
                                                        if let Some(a) = args.iter_mut().find(|x| x.id == kv_id) { a.val = input.value(); }
                                                    }
                                                }
                                                up_v.emit((tid, new_t));
                                            });
                                            
                                            let t_rm = t.clone(); let up_rm = update.clone();
                                            let rm_kv = Callback::from(move |_| {
                                                let mut new_t = t_rm.clone();
                                                if let Some(comp) = new_t.components.iter_mut().find(|x| x.id == c_id) {
                                                    if let CompData::ToolCall { ref mut args, .. } | CompData::ToolResponse { ref mut args, .. } = comp.data {
                                                        args.retain(|x| x.id != kv_id);
                                                    }
                                                }
                                                up_rm.emit((tid, new_t));
                                            });
                                            
                                            html! {
                                                <div class="tool-arg-row">
                                                    <input style="flex:1;" type="text" placeholder="Key" value={kv.key.clone()} oninput={on_key} />
                                                    <input style="flex:2;" type="text" placeholder="Value" value={kv.val.clone()} oninput={on_val} />
                                                    <button class="delete-btn" onclick={rm_kv}>{"✕"}</button>
                                                </div>
                                            }
                                        }) }
                                        <button class="add-comp-btn" style="align-self:flex-start;" onclick={add_arg}>{"+ Arg"}</button>
                                    </div>
                                }
                            },
                            CompData::ToolSchema { name, description, args } => {
                                let t_n = t.clone(); let up_n = update.clone();
                                let on_name = Callback::from(move |e: InputEvent| {
                                    let input: web_sys::HtmlInputElement = e.target_unchecked_into();
                                    let mut new_t = t_n.clone();
                                    if let Some(comp) = new_t.components.iter_mut().find(|x| x.id == c_id) {
                                        if let CompData::ToolSchema { name: ref mut n, .. } = comp.data { *n = input.value(); }
                                    }
                                    up_n.emit((tid, new_t));
                                });
                                
                                let t_d = t.clone(); let up_d = update.clone();
                                let on_desc = Callback::from(move |e: InputEvent| {
                                    let input: web_sys::HtmlInputElement = e.target_unchecked_into();
                                    let mut new_t = t_d.clone();
                                    if let Some(comp) = new_t.components.iter_mut().find(|x| x.id == c_id) {
                                        if let CompData::ToolSchema { description: ref mut d, .. } = comp.data { *d = input.value(); }
                                    }
                                    up_d.emit((tid, new_t));
                                });
                                
                                let t_add = t.clone(); let up_add = update.clone();
                                let add_arg = Callback::from(move |_| {
                                    let mut new_t = t_add.clone();
                                    if let Some(comp) = new_t.components.iter_mut().find(|x| x.id == c_id) {
                                        if let CompData::ToolSchema { ref mut args, .. } = comp.data {
                                            let max_id = args.iter().map(|a| a.id).max().unwrap_or(0);
                                            args.push(ToolArg { id: max_id + 1, name: String::new(), arg_type: "string".to_string(), description: String::new() });
                                        }
                                    }
                                    up_add.emit((tid, new_t));
                                });

                                html! {
                                    <div style="display:flex; flex-direction:column; gap:0.5rem;">
                                        <div style="display:flex; gap:0.5rem;">
                                            <input type="text" placeholder="Function" style="flex:1;" value={name.clone()} oninput={on_name} />
                                            <input type="text" placeholder="Description" style="flex:2;" value={description.clone()} oninput={on_desc} />
                                        </div>
                                        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:0.25rem;">{"Parameters:"}</div>
                                        { for args.iter().map(|arg| {
                                            let a_id = arg.id;
                                            
                                            let tk = t.clone(); let uk = update.clone();
                                            let on_k = Callback::from(move |e: InputEvent| {
                                                let input: web_sys::HtmlInputElement = e.target_unchecked_into();
                                                let mut new_t = tk.clone();
                                                if let Some(comp) = new_t.components.iter_mut().find(|x| x.id == c_id) {
                                                    if let CompData::ToolSchema { ref mut args, .. } = comp.data {
                                                        if let Some(a) = args.iter_mut().find(|x| x.id == a_id) { a.name = input.value(); }
                                                    }
                                                }
                                                uk.emit((tid, new_t));
                                            });
                                            
                                            let tt = t.clone(); let ut = update.clone();
                                            let on_t = Callback::from(move |e: Event| {
                                                let sel: web_sys::HtmlSelectElement = e.target_unchecked_into();
                                                let mut new_t = tt.clone();
                                                if let Some(comp) = new_t.components.iter_mut().find(|x| x.id == c_id) {
                                                    if let CompData::ToolSchema { ref mut args, .. } = comp.data {
                                                        if let Some(a) = args.iter_mut().find(|x| x.id == a_id) { a.arg_type = sel.value(); }
                                                    }
                                                }
                                                ut.emit((tid, new_t));
                                            });
                                            
                                            let td = t.clone(); let ud = update.clone();
                                            let on_d = Callback::from(move |e: InputEvent| {
                                                let input: web_sys::HtmlInputElement = e.target_unchecked_into();
                                                let mut new_t = td.clone();
                                                if let Some(comp) = new_t.components.iter_mut().find(|x| x.id == c_id) {
                                                    if let CompData::ToolSchema { ref mut args, .. } = comp.data {
                                                        if let Some(a) = args.iter_mut().find(|x| x.id == a_id) { a.description = input.value(); }
                                                    }
                                                }
                                                ud.emit((tid, new_t));
                                            });
                                            
                                            let tr = t.clone(); let ur = update.clone();
                                            let rm_a = Callback::from(move |_| {
                                                let mut new_t = tr.clone();
                                                if let Some(comp) = new_t.components.iter_mut().find(|x| x.id == c_id) {
                                                    if let CompData::ToolSchema { ref mut args, .. } = comp.data {
                                                        args.retain(|x| x.id != a_id);
                                                    }
                                                }
                                                ur.emit((tid, new_t));
                                            });

                                            html! {
                                                <div class="tool-arg-row">
                                                    <input style="width:120px;" type="text" placeholder="Name" value={arg.name.clone()} oninput={on_k} />
                                                    <select style="width:90px;" onchange={on_t}>
                                                        <option value="string" selected={arg.arg_type == "string"}>{"string"}</option>
                                                        <option value="number" selected={arg.arg_type == "number"}>{"number"}</option>
                                                        <option value="boolean" selected={arg.arg_type == "boolean"}>{"boolean"}</option>
                                                        <option value="object" selected={arg.arg_type == "object"}>{"object"}</option>
                                                    </select>
                                                    <input style="flex:1;" type="text" placeholder="Description" value={arg.description.clone()} oninput={on_d} />
                                                    <button class="delete-btn" onclick={rm_a}>{"✕"}</button>
                                                </div>
                                            }
                                        }) }
                                        <button class="add-comp-btn" style="align-self:flex-start;" onclick={add_arg}>{"+ Param"}</button>
                                    </div>
                                }
                            }
                        } }
                    </div>
                }
            }) }
        </div>
    }
}
