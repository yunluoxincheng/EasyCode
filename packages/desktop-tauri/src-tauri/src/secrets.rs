//! OS 凭据存取能力。服务名按应用 identifier 隔离，不接受任意路径或服务名。
use serde::Serialize;
use tauri::AppHandle;

fn entry(app: &AppHandle, id: &str) -> Result<keyring::Entry, String> {
    if id.len() != 36 || !id.bytes().enumerate().all(|(i, c)| {
        if [8, 13, 18, 23].contains(&i) { c == b'-' }
        else { c.is_ascii_digit() || (b'a'..=b'f').contains(&c) }
    }) {
        return Err("无效的凭据引用".into());
    }
    keyring::Entry::new(&format!("{}.credentials", app.config().identifier), id)
        .map_err(|_| "无法访问系统凭据存储".into())
}

#[derive(Serialize)]
pub struct SecretStatus {
    available: bool,
    backend: &'static str,
}

#[tauri::command]
pub async fn secret_status(app: AppHandle) -> Result<SecretStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let probe = entry(&app, "00000000-0000-0000-0000-000000000000")?;
        let available = matches!(probe.get_password(), Ok(_) | Err(keyring::Error::NoEntry));
        Ok(SecretStatus { available, backend: "系统凭据存储" })
    }).await.map_err(|_| "系统凭据存储状态检查失败".to_string())?
}

#[tauri::command]
pub async fn secret_get(app: AppHandle, id: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match entry(&app, &id)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("读取凭据失败，请解锁系统凭据存储".into()),
        }
    }).await.map_err(|_| "读取系统凭据失败".to_string())?
}

#[tauri::command]
pub async fn secret_set(app: AppHandle, id: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        entry(&app, &id)?.set_password(&value).map_err(|_| "保存系统凭据失败".into())
    }).await.map_err(|_| "保存系统凭据失败".to_string())?
}

#[tauri::command]
pub async fn secret_delete(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        match entry(&app, &id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("清理系统凭据失败".into()),
        }
    }).await.map_err(|_| "清理系统凭据失败".to_string())?
}
