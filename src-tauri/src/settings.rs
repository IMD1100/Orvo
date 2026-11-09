use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub device_id: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            base_url: "https://api.deepseek.com".into(),
            model: "deepseek-flash".into(),
            device_id: String::new(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDraft {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub key: String,
}

impl SettingsDraft {
    pub fn validate(&self) -> Result<Settings, String> {
        let url = url::Url::parse(self.base_url.trim()).map_err(|_| "API 地址无效")?;
        if !matches!(url.scheme(), "https" | "http")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("请填写有效的 HTTP 或 HTTPS API 地址".into());
        }
        if self.model.trim().is_empty()
            || self.model.len() > 200
            || self.key.chars().any(|c| c == '\r' || c == '\n')
        {
            return Err("模型或密钥格式无效".into());
        }
        Ok(Settings {
            base_url: self.base_url.trim().trim_end_matches('/').into(),
            model: self.model.trim().into(),
            device_id: self.device_id.clone(),
        })
    }
}

fn credential() -> Result<keyring::Entry, String> {
    keyring::Entry::new("Orvo", "model-api").map_err(|_| "无法访问系统凭据存储".into())
}

pub fn api_key() -> Result<String, String> {
    credential()?
        .get_password()
        .map_err(|_| "请在设置中填写 API Key".into())
}

pub fn save_key(key: &str) -> Result<(), String> {
    credential()?
        .set_password(key.trim())
        .map_err(|_| "无法保存 API Key 到系统凭据存储".into())
}

pub fn read(path: &Path) -> Result<Settings, String> {
    if !path.exists() {
        return Ok(Settings::default());
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "设置文件已损坏".into())
}
