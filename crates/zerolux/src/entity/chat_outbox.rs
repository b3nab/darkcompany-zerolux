use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "chat_outbox")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub event_id: String,
    pub payload_json: String,
    pub recipient_actor_ids_json: String,
    pub created_at: i64,
    pub published_at: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
