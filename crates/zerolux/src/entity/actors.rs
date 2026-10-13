use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "actors")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub name: String,
    pub kind: String,
    pub owner_id: Option<String>,
    pub harness: Option<String>,
    pub archived: bool,
    #[serde(skip_serializing, default)]
    pub name_confirmed: bool,
    pub created_at: i64,
    /// The subject of the human account bound to this actor, for the owner.
    #[serde(skip_serializing, default)]
    pub auth_subject: Option<String>,
    /// What an agent runs with: the model and effort of any harness, and its own harness's
    /// settings (Claude Code's permission mode; Codex's approval policy and sandbox).
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub approval_policy: Option<String>,
    pub sandbox: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
