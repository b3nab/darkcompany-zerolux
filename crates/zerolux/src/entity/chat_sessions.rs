use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "chat_sessions")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub actor_id: String,
    pub harness: String,
    pub native_session_id: String,
    pub title: String,
    pub workspace: String,
    pub native_locator_json: String,
    pub token_hash: String,
    pub status: String,
    pub attention_reason: Option<String>,
    pub created_at: i64,
    pub stopped_at: Option<i64>,
    pub activity: Option<String>,
    pub activity_conversation_id: Option<String>,
    /// The kernel host whose native process this session is: only it links and relinks it.
    pub host_id: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
