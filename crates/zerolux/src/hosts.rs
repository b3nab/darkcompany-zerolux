//! The computers that run the workspace's sessions. Each is a person's: on it, sessions and
//! their native history are that person's. Its person may open it to the others, who then
//! start their own sessions there with their own harness accounts.

use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use serde::{Deserialize, Serialize};

use crate::{
    entity::hosts,
    model::ChatIdentity,
    store::{Error, Result, Store, now_ms, random_token, text, token_hash},
};

/// How long a code to join a computer lasts.
const LINK_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Serialize)]
pub struct Host {
    pub id: String,
    pub name: String,
    pub person_id: String,
    pub open: bool,
    pub created_at: i64,
    pub seen_at: i64,
    /// The kernel that answers this request runs on it.
    pub here: bool,
    /// False while it waits for its computer to join with its code.
    pub joined: bool,
    /// Connected to this kernel now, for a computer joined to it.
    pub online: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostChange {
    pub name: Option<String>,
    pub open: Option<bool>,
}

/// How a person starts sessions on a host: as its person, with the computer's own harness
/// accounts, or as a guest, with their own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostUse {
    Own,
    Guest,
}

/// This computer's name, as the system gives it.
fn computer_name() -> String {
    std::process::Command::new("hostname")
        .arg("-s")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "This computer".into())
}

impl Store {
    fn host_of(&self, row: hosts::Model) -> Host {
        Host {
            here: self.host() == Some(row.id.as_str()),
            joined: row.link_hash.is_none(),
            online: false,
            id: row.id,
            name: row.name,
            person_id: row.person_id,
            open: row.open,
            created_at: row.created_at,
            seen_at: row.seen_at,
        }
    }

    /// This kernel's host, made the first time it starts: the workspace owner's computer
    /// unless a person already holds it.
    pub async fn register_host(&self) -> Result<()> {
        let Some(id) = self.host().map(str::to_owned) else {
            return Ok(());
        };
        let now = now_ms();
        let name = tokio::task::spawn_blocking(computer_name)
            .await
            .unwrap_or_else(|_| "This computer".into());
        let tx = self.write().await?;
        match hosts::Entity::find_by_id(self.key(&id)).one(&tx).await? {
            Some(_) => {
                hosts::ActiveModel {
                    workspace_id: Set(self.workspace.clone()),
                    id: Set(id),
                    seen_at: Set(now),
                    ..Default::default()
                }
                .update(&tx)
                .await?;
            }
            None => {
                let owner = self.owner().await?;
                hosts::ActiveModel {
                    workspace_id: Set(self.workspace.clone()),
                    id: Set(id),
                    name: Set(name),
                    person_id: Set(owner.id),
                    open: Set(false),
                    created_at: Set(now),
                    seen_at: Set(now),
                    secret_hash: Set(None),
                    link_hash: Set(None),
                    link_expires_at: Set(None),
                }
                .insert(&tx)
                .await?;
            }
        }
        tx.commit().await?;
        Ok(())
    }

    /// The workspace's hosts, for its people.
    pub async fn hosts(&self, who: &ChatIdentity) -> Result<Vec<Host>> {
        if !who.is_person() {
            return Err(Error::Forbidden);
        }
        Ok(hosts::Entity::find()
            .filter(hosts::Column::WorkspaceId.eq(&self.workspace))
            .order_by_asc(hosts::Column::CreatedAt)
            .all(self.db())
            .await?
            .into_iter()
            .map(|row| self.host_of(row))
            .collect())
    }

    /// Its person names a host, or opens it to the others or closes it.
    pub async fn change_host(
        &self,
        who: &ChatIdentity,
        id: &str,
        change: HostChange,
    ) -> Result<Host> {
        if change.name.is_none() && change.open.is_none() {
            return Err(Error::Invalid("Nothing to change".into()));
        }
        let row = hosts::Entity::find_by_id(self.key(id))
            .one(self.db())
            .await?
            .ok_or(Error::NotFound)?;
        if !who.is_person() || who.actor_id.as_ref() != Some(&row.person_id) {
            return Err(Error::Forbidden);
        }
        let mut update = hosts::ActiveModel {
            workspace_id: Set(row.workspace_id),
            id: Set(row.id),
            ..Default::default()
        };
        if let Some(name) = &change.name {
            let name = text(name, "Host name", 200, true)?;
            if name.chars().any(char::is_control) {
                return Err(Error::Invalid(
                    "Name the host without control characters".into(),
                ));
            }
            update.name = Set(name);
        }
        if let Some(open) = change.open {
            update.open = Set(open);
        }
        let row = update.update(self.db()).await?;
        Ok(self.host_of(row))
    }

    /// The harness folders `who` starts sessions with on this kernel's host: the computer's for
    /// its person, their own for a guest. Forbidden when the host is not open to them.
    pub async fn homes(&self, who: &ChatIdentity) -> Result<crate::homes::Homes> {
        match self.host_use(who).await? {
            Some(HostUse::Own) => Ok(crate::homes::Homes::own()),
            Some(HostUse::Guest) => {
                let people = self.people.as_ref().ok_or(Error::Forbidden)?;
                let homes = crate::homes::Homes::guest(people.join(who.actor()?));
                homes
                    .prepare()
                    .map_err(|error| Error::Invalid(format!("Your harness folders: {error}")))?;
                Ok(homes)
            }
            None => Err(Error::Forbidden),
        }
    }

    /// A new host for one of `who`'s computers, and the one-time code it joins with, valid for
    /// ten minutes.
    pub async fn link_host(
        &self,
        who: &ChatIdentity,
        name: Option<&str>,
    ) -> Result<(Host, String)> {
        if !who.is_person() {
            return Err(Error::Forbidden);
        }
        let name = match name {
            Some(name) => text(name, "Host name", 200, true)?,
            None => "New computer".into(),
        };
        let code = random_token();
        let now = now_ms();
        let row = hosts::ActiveModel {
            workspace_id: Set(self.workspace.clone()),
            id: Set(uuid::Uuid::new_v4().to_string()),
            name: Set(name),
            person_id: Set(who.actor()?.to_owned()),
            open: Set(false),
            created_at: Set(now),
            seen_at: Set(now),
            secret_hash: Set(None),
            link_hash: Set(Some(token_hash(&code))),
            link_expires_at: Set(Some(now + LINK_MS)),
        }
        .insert(self.db())
        .await?;
        Ok((self.host_of(row), code))
    }

    /// A computer joins with its code, once: its host and the secret it connects with from then
    /// on, given only here.
    pub async fn join_host(&self, code: &str, name: &str) -> Result<(String, String)> {
        let secret = format!("{}{}", crate::host_link::SECRET_PREFIX, random_token());
        let tx = self.write().await?;
        let row = hosts::Entity::find()
            .filter(hosts::Column::WorkspaceId.eq(&self.workspace))
            .filter(hosts::Column::LinkHash.eq(token_hash(code)))
            .filter(hosts::Column::LinkExpiresAt.gt(now_ms()))
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        let mut update = hosts::ActiveModel {
            workspace_id: Set(row.workspace_id.clone()),
            id: Set(row.id.clone()),
            secret_hash: Set(Some(token_hash(&secret))),
            link_hash: Set(None),
            link_expires_at: Set(None),
            seen_at: Set(now_ms()),
            ..Default::default()
        };
        let name = name.trim();
        if !name.is_empty() {
            update.name = Set(text(name, "Host name", 200, true)?);
        }
        update.update(&tx).await?;
        tx.commit().await?;
        Ok((row.id, secret))
    }

    /// The joined host a secret belongs to.
    pub async fn host_by_secret(&self, secret: &str) -> Result<Option<String>> {
        Ok(hosts::Entity::find()
            .filter(hosts::Column::WorkspaceId.eq(&self.workspace))
            .filter(hosts::Column::SecretHash.eq(token_hash(secret)))
            .one(self.db())
            .await?
            .map(|row| row.id))
    }

    /// A joined host connected again.
    pub async fn host_seen(&self, id: &str) -> Result<()> {
        hosts::ActiveModel {
            workspace_id: Set(self.workspace.clone()),
            id: Set(id.to_owned()),
            seen_at: Set(now_ms()),
            ..Default::default()
        }
        .update(self.db())
        .await?;
        Ok(())
    }

    /// Its person removes a joined computer; its secret stops working at once. A kernel serving
    /// the workspace's database is not removed this way.
    pub async fn remove_host(&self, who: &ChatIdentity, id: &str) -> Result<()> {
        let row = hosts::Entity::find_by_id(self.key(id))
            .one(self.db())
            .await?
            .ok_or(Error::NotFound)?;
        if !who.is_person() || who.actor_id.as_ref() != Some(&row.person_id) {
            return Err(Error::Forbidden);
        }
        if row.secret_hash.is_none() && row.link_hash.is_none() {
            return Err(Error::Invalid(
                "This computer runs a kernel of the workspace; stop that kernel instead".into(),
            ));
        }
        hosts::Entity::delete_by_id(self.key(id))
            .exec(self.db())
            .await?;
        Ok(())
    }

    /// The person whose computer a host is.
    pub async fn host_person(&self, id: &str) -> Result<Option<String>> {
        Ok(hosts::Entity::find_by_id(self.key(id))
            .one(self.db())
            .await?
            .map(|row| row.person_id))
    }

    /// How `who` may start sessions on this kernel's host, if at all.
    pub async fn host_use(&self, who: &ChatIdentity) -> Result<Option<HostUse>> {
        if !who.is_person() {
            return Ok(None);
        }
        let Some(id) = self.host() else {
            // A kernel without a host of its own is its owner's.
            return Ok(self.is_workspace_owner(who).await?.then_some(HostUse::Own));
        };
        let Some(row) = hosts::Entity::find_by_id(self.key(id))
            .one(self.db())
            .await?
        else {
            return Ok(None);
        };
        Ok(if who.actor_id.as_ref() == Some(&row.person_id) {
            Some(HostUse::Own)
        } else if row.open {
            Some(HostUse::Guest)
        } else {
            None
        })
    }
}
