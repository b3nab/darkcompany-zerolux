//! The computers that run the workspace's sessions. Each is a person's: on it, sessions and
//! their native history are that person's. Its person may open it to the others, who then
//! start their own sessions there with their own harness accounts.

use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use serde::{Deserialize, Serialize};

use crate::{
    entity::{actors, hosts},
    model::ChatIdentity,
    store::{Error, Result, Store, now_ms, text},
};

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
        match hosts::Entity::find_by_id(&id).one(&tx).await? {
            Some(_) => {
                hosts::ActiveModel {
                    id: Set(id),
                    seen_at: Set(now),
                    ..Default::default()
                }
                .update(&tx)
                .await?;
            }
            None => {
                let owner = actors::Entity::find()
                    .filter(actors::Column::Kind.eq("human"))
                    .filter(actors::Column::InvitedBy.is_null())
                    .one(&tx)
                    .await?
                    .ok_or(Error::NotFound)?;
                hosts::ActiveModel {
                    id: Set(id),
                    name: Set(name),
                    person_id: Set(owner.id),
                    open: Set(false),
                    created_at: Set(now),
                    seen_at: Set(now),
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
        let row = hosts::Entity::find_by_id(id)
            .one(self.db())
            .await?
            .ok_or(Error::NotFound)?;
        if !who.is_person() || who.actor_id.as_ref() != Some(&row.person_id) {
            return Err(Error::Forbidden);
        }
        let mut update = hosts::ActiveModel {
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

    /// How `who` may start sessions on this kernel's host, if at all.
    pub async fn host_use(&self, who: &ChatIdentity) -> Result<Option<HostUse>> {
        if !who.is_person() {
            return Ok(None);
        }
        let Some(id) = self.host() else {
            // A kernel without a host of its own is its owner's.
            return Ok(self.is_workspace_owner(who).await?.then_some(HostUse::Own));
        };
        let Some(row) = hosts::Entity::find_by_id(id).one(self.db()).await? else {
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
