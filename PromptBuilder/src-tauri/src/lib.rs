use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
fn copy_to_clipboard(app: tauri::AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_to_file(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let file_path = app.dialog().file().add_filter("Text", &["txt"]).blocking_save_file();
    if let Some(path) = file_path {
        if let Ok(p) = path.into_path() {
            std::fs::write(p, text).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![copy_to_clipboard, save_to_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
