//! The workspace's people: its owner, who set it up, and its members, who join by invitation
//! with the account they already have. Each brings their own agents and sessions; chats and
//! meetings are shared.

use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set, prelude::Expr,
};
use serde::Serialize;
use uuid::Uuid;

use crate::{
    entity::{actors, invites},
    model::{Actor, ChatIdentity},
    store::{
        Error, MEMBER, OWNER, Result, Store, now_ms, owner_name, random_token, scalar, sql,
        token_hash,
    },
};

/// How long an invitation can be used.
pub const INVITE_DAYS: i64 = 7;

#[derive(Debug, Clone, Serialize)]
pub struct Invite {
    pub id: String,
    pub created_by: String,
    pub created_at: i64,
    pub expires_at: i64,
}

impl From<invites::Model> for Invite {
    fn from(row: invites::Model) -> Self {
        Self {
            id: row.id,
            created_by: row.created_by,
            created_at: row.created_at,
            expires_at: row.expires_at,
        }
    }
}

/// What an invitation shows before one signs up with it.
#[derive(Debug, Clone, Serialize)]
pub struct Invitation {
    pub workspace: String,
    pub invited_by: String,
    pub expires_at: i64,
}

impl Store {
    /// Whether `who` is the workspace's owner.
    pub async fn is_workspace_owner(&self, who: &ChatIdentity) -> Result<bool> {
        if !who.is_person() {
            return Ok(false);
        }
        Ok(actors::Entity::find_by_id(self.key(who.actor()?))
            .filter(actors::Column::Role.eq(OWNER))
            .one(&self.db)
            .await?
            .is_some())
    }

    async fn workspace_owner_only(&self, who: &ChatIdentity) -> Result<()> {
        if self.is_workspace_owner(who).await? {
            Ok(())
        } else {
            Err(Error::Forbidden)
        }
    }

    /// A new invitation from the workspace's owner. Its token is given once, here.
    pub async fn create_invite(&self, who: &ChatIdentity) -> Result<(Invite, String)> {
        self.workspace_owner_only(who).await?;
        let token = random_token();
        let now = now_ms();
        let tx = self.write().await?;
        let row = invites::ActiveModel {
            workspace_id: Set(self.workspace.clone()),
            id: Set(Uuid::new_v4().to_string()),
            token_hash: Set(token_hash(&token)),
            created_by: Set(who.actor()?.to_owned()),
            created_at: Set(now),
            expires_at: Set(now + INVITE_DAYS * 24 * 60 * 60 * 1000),
            accepted_by: Set(None),
            accepted_at: Set(None),
        }
        .insert(&tx)
        .await?;
        tx.commit().await?;
        Ok((row.into(), token))
    }

    /// The invitations nobody has used yet and that have not expired.
    pub async fn invites(&self, who: &ChatIdentity) -> Result<Vec<Invite>> {
        self.workspace_owner_only(who).await?;
        Ok(invites::Entity::find()
            .filter(invites::Column::WorkspaceId.eq(&self.workspace))
            .filter(invites::Column::AcceptedBy.is_null())
            .filter(invites::Column::ExpiresAt.gt(now_ms()))
            .order_by_asc(invites::Column::CreatedAt)
            .all(&self.db)
            .await?
            .into_iter()
            .map(Invite::from)
            .collect())
    }

    /// Withdraws an invitation nobody has used yet.
    pub async fn revoke_invite(&self, who: &ChatIdentity, id: &str) -> Result<()> {
        self.workspace_owner_only(who).await?;
        let tx = self.write().await?;
        let removed = invites::Entity::delete_many()
            .filter(invites::Column::WorkspaceId.eq(&self.workspace))
            .filter(invites::Column::Id.eq(id))
            .filter(invites::Column::AcceptedBy.is_null())
            .exec(&tx)
            .await?
            .rows_affected;
        tx.commit().await?;
        if removed == 1 {
            Ok(())
        } else {
            Err(Error::NotFound)
        }
    }

    async fn usable_invite<C: sea_orm::ConnectionTrait>(
        &self,
        db: &C,
        token: &str,
    ) -> Result<invites::Model> {
        invites::Entity::find()
            .filter(invites::Column::WorkspaceId.eq(&self.workspace))
            .filter(invites::Column::TokenHash.eq(token_hash(token)))
            .filter(invites::Column::AcceptedBy.is_null())
            .filter(invites::Column::ExpiresAt.gt(now_ms()))
            .one(db)
            .await?
            .ok_or(Error::NotFound)
    }

    /// The invitation behind `token`, while it can still be used.
    pub async fn invitation(&self, token: &str) -> Result<Invitation> {
        let invite = self.usable_invite(&self.db, token).await?;
        let workspace = self.workspace_info().await?;
        let by = actors::Entity::find_by_id(self.key(&invite.created_by))
            .one(&self.db)
            .await?
            .ok_or(Error::NotFound)?;
        Ok(Invitation {
            workspace: workspace.name,
            invited_by: by.name,
            expires_at: invite.expires_at,
        })
    }

    /// A person's name: their own, and nobody else's in the workspace.
    pub(crate) async fn person_name(&self, value: &str) -> Result<String> {
        let name = owner_name(value)?;
        let taken: bool = scalar(
            &self.db,
            sql(
                &self.db,
                "SELECT EXISTS(SELECT 1 FROM actors
                WHERE workspace_id=$1 AND archived=FALSE AND lower(name)=lower($2))",
                [(&self.workspace).into(), name.clone().into()],
            ),
        )
        .await?;
        if taken {
            return Err(Error::Invalid(
                "Another member already has this name".into(),
            ));
        }
        Ok(name)
    }

    /// The signed-in account joins the workspace as a new member, under its account's name,
    /// with an invitation that is then used up.
    pub async fn join(&self, token: &str, subject: &str, account_name: &str) -> Result<Actor> {
        let name = self.person_name(account_name).await?;
        let tx = self.write().await?;
        let invite = self.usable_invite(&tx, token).await?;
        if actors::Entity::find()
            .filter(actors::Column::WorkspaceId.eq(&self.workspace))
            .filter(actors::Column::AuthSubject.eq(subject))
            .one(&tx)
            .await?
            .is_some()
        {
            return Err(Error::Conflict);
        }
        let now = now_ms();
        let person = actors::ActiveModel {
            workspace_id: Set(self.workspace.clone()),
            id: Set(Uuid::new_v4().to_string()),
            name: Set(name),
            kind: Set("human".into()),
            owner_id: Set(None),
            harness: Set(None),
            archived: Set(false),
            name_confirmed: Set(true),
            created_at: Set(now),
            auth_subject: Set(Some(subject.to_owned())),
            model: Set(None),
            effort: Set(None),
            permission_mode: Set(None),
            approval_policy: Set(None),
            sandbox: Set(None),
            invited_by: Set(Some(invite.created_by.clone())),
            role: Set(Some(MEMBER.into())),
        }
        .insert(&tx)
        .await?;
        let used = invites::Entity::update_many()
            .col_expr(
                invites::Column::AcceptedBy,
                Expr::value(Some(person.id.clone())),
            )
            .col_expr(invites::Column::AcceptedAt, Expr::value(Some(now)))
            .filter(invites::Column::WorkspaceId.eq(&self.workspace))
            .filter(invites::Column::Id.eq(&invite.id))
            .filter(invites::Column::AcceptedBy.is_null())
            .exec(&tx)
            .await?
            .rows_affected;
        if used != 1 {
            return Err(Error::Conflict);
        }
        tx.commit().await?;
        Ok(person)
    }
}
