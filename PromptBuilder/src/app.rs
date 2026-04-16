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
pub enum ComponentType {
    Answer,
    Thinking,
    ToolCall,
    ToolResponse,
}

#[derive(Clone, PartialEq, Debug)]
pub struct ModelComponent {
    pub id: usize,
    pub comp_type: ComponentType,
    pub text1: String, // Answer/Thinking -> content, ToolCall/Response -> tool_name
    pub text2: String, // ToolCall/Response -> tool_args
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
    // For System/User
    pub content: String,
    // For Model
    pub components: Vec<ModelComponent>,
}

fn format_prompt(turns: &[Turn]) -> String {
    let mut out = String::new();
    let escape_str = |s: &str| s.replace("\"", "<|\"|>");

    for t in turns {
        match t.role {
            TurnRole::System => {
                out.push_str("<|turn>system\n");
                out.push_str(&t.content);
                if !t.content.ends_with('\n') && !t.content.is_empty() { out.push('\n'); }
                out.push_str("<turn|>\n");
            }
            TurnRole::User => {
                out.push_str("<|turn>user\n");
                out.push_str(&t.content);
                if !t.content.ends_with('\n') && !t.content.is_empty() { out.push('\n'); }
                out.push_str("<turn|>\n");
            }
            TurnRole::Model => {
                out.push_str("<|turn>model\n");
                for c in &t.components {
                    match c.comp_type {
                        ComponentType::Answer => {
                            out.push_str(&c.text1);
                            if !c.text1.ends_with('\n') && !c.text1.is_empty() { out.push('\n'); }
                        }
                        ComponentType::Thinking => {
                            out.push_str("<|channel>thought\n");
                            out.push_str(&c.text1);
                            if !c.text1.ends_with('\n') && !c.text1.is_empty() { out.push('\n'); }
                            out.push_str("<channel|>\n");
                        }
                        ComponentType::ToolCall => {
                            let args = escape_str(&c.text2);
                            out.push_str(&format!("<|tool_call>call:{}{{{}}}<tool_call|>\n", c.text1, args));
                        }
                        ComponentType::ToolResponse => {
                            let args = escape_str(&c.text2);
                            out.push_str(&format!("<|tool_response>response:{}{{{}}}<tool_response|>\n", c.text1, args));
                        }
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
            content: "You are a helpful AI.".to_string(),
            components: vec![],
        }
    ]);
    
    let next_id = use_state(|| 1);
    let next_comp_id = use_state(|| 1);
    let dragged_index = use_state(|| None::<usize>);

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

    let move_turn = {
        let turns = turns.clone();
        Callback::from(move |(index, direction): (usize, isize)| {
            let mut new_turns = (*turns).clone();
            let new_index = (index as isize + direction) as usize;
            if new_index < new_turns.len() {
                new_turns.swap(index, new_index);
                turns.set(new_turns);
            }
        })
    };

    let on_drag_start = {
        let dragged_index = dragged_index.clone();
        Callback::from(move |index: usize| {
            dragged_index.set(Some(index));
        })
    };

    let on_drop = {
        let dragged_index = dragged_index.clone();
        let turns = turns.clone();
        Callback::from(move |target_index: usize| {
            if let Some(source_index) = *dragged_index {
                if source_index != target_index {
                    let mut new_turns = (*turns).clone();
                    let item = new_turns.remove(source_index);
                    new_turns.insert(target_index, item);
                    turns.set(new_turns);
                }
            }
            dragged_index.set(None);
        })
    };

    let on_drag_over = Callback::from(|e: DragEvent| {
        e.prevent_default();
    });

    let change_role = {
        let turns = turns.clone();
        Callback::from(move |(id, new_role): (usize, TurnRole)| {
            let mut new_turns = (*turns).clone();
            if let Some(t) = new_turns.iter_mut().find(|t| t.id == id) {
                t.role = new_role;
                if t.role != TurnRole::Model {
                    t.components.clear();
                }
            }
            turns.set(new_turns);
        })
    };

    let next_comp_id_clone = next_comp_id.clone();
    let add_component = {
        let update_turn = update_turn.clone();
        Callback::from(move |(mut turn, comp_type): (Turn, ComponentType)| {
            let comp_id = *next_comp_id_clone;
            next_comp_id_clone.set(comp_id + 1);
            turn.components.push(ModelComponent {
                id: comp_id,
                comp_type,
                text1: String::new(),
                text2: String::new(),
            });
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
                <h1>{"✨ Gemma 4 Builder"}</h1>
                <div class="tools-panel">
                    <h3>{"Add Block"}</h3>
                    <button onclick={add_turn.reform(|_| TurnRole::System)}>{"System"}</button>
                    <button onclick={add_turn.reform(|_| TurnRole::User)}>{"User"}</button>
                    <button onclick={add_turn.reform(|_| TurnRole::Model)}>{"Model"}</button>
                </div>
                <div class="actions">
                    <button onclick={copy_to_clipboard} class="primary">{"Copy Output"}</button>
                    <button onclick={save_to_file} class="secondary">{"Save text"}</button>
                </div>
            </div>
            
            <div class="main-editor">
                <div class="blocks">
                    { for turns.iter().enumerate().map(|(index, turn)| {
                        let id = turn.id;
                        let t = turn.clone();
                        let on_delete = remove_turn.reform(move |_| id);
                        let update = update_turn.clone();
                        let move_up = move_turn.reform(move |_| (index, -1));
                        let move_down = move_turn.reform(move |_| (index, 1));
                        
                        let idx = index;
                        let on_drag_start_cb = {
                            let f = on_drag_start.clone();
                            Callback::from(move |e: DragEvent| {
                                if let Some(data_transfer) = e.data_transfer() {
                                    let _ = data_transfer.set_data("text/plain", &idx.to_string());
                                }
                                f.emit(idx);
                            })
                        };
                        let on_drop_cb = {
                            let f = on_drop.clone();
                            Callback::from(move |e: DragEvent| {
                                e.prevent_default();
                                f.emit(idx);
                            })
                        };
                        let on_drag_over_cb = on_drag_over.clone();

                        let on_role_change = {
                            let change_role = change_role.clone();
                            Callback::from(move |e: Event| {
                                let target: web_sys::HtmlSelectElement = e.target_unchecked_into();
                                let role = match target.value().as_str() {
                                    "System" => TurnRole::System,
                                    "User" => TurnRole::User,
                                    "Model" => TurnRole::Model,
                                    _ => TurnRole::User,
                                };
                                change_role.emit((id, role));
                            })
                        };
                        let on_content = {
                            let ct = t.clone();
                            let up = update.clone();
                            Callback::from(move |e: InputEvent| {
                                let input: web_sys::HtmlTextAreaElement = e.target_unchecked_into();
                                let mut new_t = ct.clone();
                                new_t.content = input.value();
                                up.emit((id, new_t));
                            })
                        };
                        
                        html! {
                            <div class="turn-card" draggable="true" ondragstart={on_drag_start_cb} ondrop={on_drop_cb} ondragover={on_drag_over_cb}>
                                <div class="turn-header" style="display: flex; gap: 0.5rem; align-items: center; cursor: grab;">
                                    <select class="role-select" onchange={on_role_change}>
                                        <option value="System" selected={t.role == TurnRole::System}>{"⚙️ System"}</option>
                                        <option value="User" selected={t.role == TurnRole::User}>{"👤 User"}</option>
                                        <option value="Model" selected={t.role == TurnRole::Model}>{"🤖 Model"}</option>
                                    </select>
                                    <div style="margin-left: auto; display: flex; gap: 0.25rem;">
                                        { if index > 0 {
                                            html! { <button onclick={move_up} class="control-btn" title="Move Up">{"↑"}</button> }
                                        } else { html! {} } }
                                        { if index + 1 < turns.len() {
                                            html! { <button onclick={move_down} class="control-btn" title="Move Down">{"↓"}</button> }
                                        } else { html! {} } }
                                        <button onclick={on_delete} class="delete-btn" title="Remove">{"✕"}</button>
                                    </div>
                                </div>
                                <div class="turn-body">
                                    { if t.role == TurnRole::System || t.role == TurnRole::User {
                                        html! {
                                            <textarea placeholder="Content..." class="content-input" value={t.content} oninput={on_content}></textarea>
                                        }
                                    } else {
                                        let t_clone = t.clone();
                                        let t_ans = t_clone.clone();
                                        let t_thk = t_clone.clone();
                                        let t_tc = t_clone.clone();
                                        let t_tr = t_clone.clone();
                                        html! {
                                            <div class="model-components">
                                                <div class="component-list" style="display:flex; flex-direction:column; gap:0.5rem;">
                                                    { for t.components.iter().enumerate().map(|(c_idx, c)| {
                                                        let c_id = c.id;
                                                        let t_up1 = t.clone();
                                                        let up1 = update.clone();
                                                        let on_text1 = Callback::from(move |e: InputEvent| {
                                                            let input: web_sys::HtmlTextAreaElement = e.target_unchecked_into();
                                                            let mut new_t = t_up1.clone();
                                                            if let Some(comp) = new_t.components.iter_mut().find(|x| x.id == c_id) {
                                                                comp.text1 = input.value();
                                                            }
                                                            up1.emit((new_t.id, new_t));
                                                        });

                                                        let t_up2 = t.clone();
                                                        let up2 = update.clone();
                                                        let on_text2 = Callback::from(move |e: InputEvent| {
                                                            let input: web_sys::HtmlTextAreaElement = e.target_unchecked_into();
                                                            let mut new_t = t_up2.clone();
                                                            if let Some(comp) = new_t.components.iter_mut().find(|x| x.id == c_id) {
                                                                comp.text2 = input.value();
                                                            }
                                                            up2.emit((new_t.id, new_t));
                                                        });

                                                        let t_del = t.clone();
                                                        let up_del = update.clone();
                                                        let on_del_comp = Callback::from(move |_| {
                                                            let mut new_t = t_del.clone();
                                                            new_t.components.retain(|x| x.id != c_id);
                                                            up_del.emit((new_t.id, new_t));
                                                        });

                                                        let t_up = t.clone();
                                                        let up_up = update.clone();
                                                        let on_move_up = Callback::from(move |_| {
                                                            let mut new_t = t_up.clone();
                                                            if c_idx > 0 {
                                                                new_t.components.swap(c_idx, c_idx - 1);
                                                                up_up.emit((new_t.id, new_t));
                                                            }
                                                        });

                                                        let t_down = t.clone();
                                                        let up_down = update.clone();
                                                        let on_move_down = Callback::from(move |_| {
                                                            let mut new_t = t_down.clone();
                                                            if c_idx + 1 < new_t.components.len() {
                                                                new_t.components.swap(c_idx, c_idx + 1);
                                                                up_down.emit((new_t.id, new_t));
                                                            }
                                                        });

                                                        html! {
                                                            <div class="comp-card" style="border:1px solid var(--border-color); border-radius:6px; padding:0.5rem; background:rgba(255,255,255,0.02);">
                                                                <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem; align-items:center;">
                                                                    <span style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase;">{format!("{:?}", c.comp_type)}</span>
                                                                    <div style="display:flex; gap:0.25rem;">
                                                                        { if c_idx > 0 { html!{ <button onclick={on_move_up} class="control-btn" style="padding:0 4px;font-size:0.8rem;">{"↑"}</button> } } else { html!{} } }
                                                                        { if c_idx + 1 < t.components.len() { html!{ <button onclick={on_move_down} class="control-btn" style="padding:0 4px;font-size:0.8rem;">{"↓"}</button> } } else { html!{} } }
                                                                        <button onclick={on_del_comp} class="delete-btn" style="padding:0; font-size:0.8rem; margin-left:0.5rem;">{"✕"}</button>
                                                                    </div>
                                                                </div>
                                                                { match c.comp_type {
                                                                    ComponentType::Answer => html!{ <textarea placeholder="Answer content..." value={c.text1.clone()} oninput={on_text1} /> },
                                                                    ComponentType::Thinking => html!{ <textarea placeholder="Thinking process..." class="thought-input" value={c.text1.clone()} oninput={on_text1} /> },
                                                                    ComponentType::ToolCall => html!{ 
                                                                        <div class="tool-inputs">
                                                                            <textarea placeholder="Tool Name (e.g. get_weather)" rows="1" value={c.text1.clone()} oninput={on_text1} />
                                                                            <textarea placeholder="Arguments JSON..." value={c.text2.clone()} oninput={on_text2} />
                                                                        </div>
                                                                    },
                                                                    ComponentType::ToolResponse => html!{ 
                                                                        <div class="tool-inputs">
                                                                            <textarea placeholder="Tool Name" rows="1" value={c.text1.clone()} oninput={on_text1} />
                                                                            <textarea placeholder="Response JSON..." value={c.text2.clone()} oninput={on_text2} />
                                                                        </div>
                                                                    },
                                                                } }
                                                            </div>
                                                        }
                                                    }) }
                                                </div>
                                                <div style="display:flex; gap:0.5rem; margin-top:1rem; flex-wrap:wrap;">
                                                    <button onclick={add_component.reform(move |_| (t_ans.clone(), ComponentType::Answer))} style="font-size:0.75rem; padding:0.25rem 0.5rem; border:1px solid rgba(255,255,255,0.2); border-radius:4px; background:rgba(255,255,255,0.05); color:var(--text-main); cursor:pointer;">{"+ Answer"}</button>
                                                    <button onclick={add_component.reform(move |_| (t_thk.clone(), ComponentType::Thinking))} style="font-size:0.75rem; padding:0.25rem 0.5rem; border:1px solid rgba(255,255,255,0.2); border-radius:4px; background:rgba(255,255,255,0.05); color:var(--text-main); cursor:pointer;">{"+ Thinking"}</button>
                                                    <button onclick={add_component.reform(move |_| (t_tc.clone(), ComponentType::ToolCall))} style="font-size:0.75rem; padding:0.25rem 0.5rem; border:1px solid rgba(255,255,255,0.2); border-radius:4px; background:rgba(255,255,255,0.05); color:var(--text-main); cursor:pointer;">{"+ Tool Call"}</button>
                                                    <button onclick={add_component.reform(move |_| (t_tr.clone(), ComponentType::ToolResponse))} style="font-size:0.75rem; padding:0.25rem 0.5rem; border:1px solid rgba(255,255,255,0.2); border-radius:4px; background:rgba(255,255,255,0.05); color:var(--text-main); cursor:pointer;">{"+ Tool Response"}</button>
                                                </div>
                                            </div>
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
                <pre class="preview-content">{ output }</pre>
            </div>
        </div>
    }
}
