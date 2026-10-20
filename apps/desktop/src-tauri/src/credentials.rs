//! A workspace's sign-in, kept across restarts in the system's credential store: Keychain on
//! macOS, Credential Manager on Windows, Secret Service on Linux. One entry per saved
//! connection, read and written only by that connection's packaged page, and given back only
//! for the workspace it was saved for. Where the store is missing or refuses, the page signs in
//! again, as with no saved sign-in.
use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

const SERVICE: &str = "os.darkcompany.zerolux";

/// Where sign-ins are kept: the system's credential store, or another in tests.
trait Vault {
    fn get(&self, account: &str) -> keyring::Result<String>;
    fn set(&self, account: &str, secret: &str) -> keyring::Result<()>;
    fn delete(&self, account: &str) -> keyring::Result<()>;
}

struct System;

impl Vault for System {
    fn get(&self, account: &str) -> keyring::Result<String> {
        keyring::Entry::new(SERVICE, account)?.get_password()
    }
    fn set(&self, account: &str, secret: &str) -> keyring::Result<()> {
        keyring::Entry::new(SERVICE, account)?.set_password(secret)
    }
    fn delete(&self, account: &str) -> keyring::Result<()> {
        keyring::Entry::new(SERVICE, account)?.delete_credential()
    }
}

#[derive(Serialize, Deserialize)]
struct Saved {
    workspace_id: String,
    token: String,
}

fn read(vault: &impl Vault, profile: &str, workspace_id: &str) -> Option<String> {
    match vault.get(profile) {
        Ok(secret) => serde_json::from_str::<Saved>(&secret)
            .ok()
            .filter(|saved| saved.workspace_id == workspace_id)
            .map(|saved| saved.token),
        Err(keyring::Error::NoEntry) => None,
        Err(error) => {
            eprintln!("The saved sign-in could not be read: {error}");
            None
        }
    }
}

fn write(vault: &impl Vault, profile: &str, workspace_id: &str, token: Option<&str>) {
    let result = match token {
        Some(token) => vault.set(
            profile,
            &serde_json::json!({ "workspace_id": workspace_id, "token": token }).to_string(),
        ),
        None => forget_in(vault, profile),
    };
    if let Err(error) = result {
        eprintln!("The sign-in could not be saved: {error}");
    }
}

fn forget_in(vault: &impl Vault, profile: &str) -> keyring::Result<()> {
    match vault.delete(profile) {
        Err(keyring::Error::NoEntry) => Ok(()),
        other => other,
    }
}

/// Forgets a removed connection's sign-in.
pub fn forget(profile: &str) {
    if let Err(error) = forget_in(&System, profile) {
        eprintln!("The saved sign-in could not be removed: {error}");
    }
}

fn caller(window: &WebviewWindow) -> Result<String, String> {
    window
        .url()
        .ok()
        .and_then(|url| crate::chrome::workspace_profile(window.label(), &url).map(str::to_owned))
        .ok_or_else(|| "A sign-in belongs to its packaged workspace view only".to_owned())
}

#[tauri::command]
pub async fn read_workspace_credential(
    window: WebviewWindow,
    workspace_id: String,
) -> Result<Option<String>, String> {
    let profile = caller(&window)?;
    Ok(read(&System, &profile, &workspace_id))
}

#[tauri::command]
pub async fn write_workspace_credential(
    window: WebviewWindow,
    workspace_id: String,
    token: Option<String>,
) -> Result<(), String> {
    let profile = caller(&window)?;
    write(&System, &profile, &workspace_id, token.as_deref());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::HashMap};

    #[derive(Default)]
    struct Memory {
        entries: RefCell<HashMap<String, String>>,
        refuses: bool,
    }

    impl Vault for Memory {
        fn get(&self, account: &str) -> keyring::Result<String> {
            if self.refuses {
                return Err(keyring::Error::NoDefaultStore);
            }
            self.entries
                .borrow()
                .get(account)
                .cloned()
                .ok_or(keyring::Error::NoEntry)
        }
        fn set(&self, account: &str, secret: &str) -> keyring::Result<()> {
            if self.refuses {
                return Err(keyring::Error::NoDefaultStore);
            }
            self.entries
                .borrow_mut()
                .insert(account.to_owned(), secret.to_owned());
            Ok(())
        }
        fn delete(&self, account: &str) -> keyring::Result<()> {
            self.entries
                .borrow_mut()
                .remove(account)
                .map(|_| ())
                .ok_or(keyring::Error::NoEntry)
        }
    }

    #[test]
    fn a_sign_in_is_kept_for_its_connection_and_workspace_only() {
        let vault = Memory::default();
        assert_eq!(read(&vault, "aspen", "workspace"), None);
        write(&vault, "aspen", "workspace", Some("token"));
        assert_eq!(read(&vault, "aspen", "workspace").as_deref(), Some("token"));
        assert_eq!(read(&vault, "aspen", "another"), None);
        assert_eq!(read(&vault, "birch", "workspace"), None);
        write(&vault, "aspen", "workspace", None);
        assert_eq!(read(&vault, "aspen", "workspace"), None);
        assert!(forget_in(&vault, "aspen").is_ok());
    }

    #[test]
    fn without_a_store_the_page_signs_in_again() {
        let vault = Memory {
            refuses: true,
            ..Default::default()
        };
        write(&vault, "aspen", "workspace", Some("token"));
        assert_eq!(read(&vault, "aspen", "workspace"), None);
    }
}
