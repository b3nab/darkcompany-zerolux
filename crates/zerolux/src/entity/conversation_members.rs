use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "conversation_members")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub conversation_id: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub actor_id: String,
    pub session_id: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
