use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "workspace")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub name: String,
    pub created_at: i64,
    /// Where its files are (links, people, `host-id`, storage, extensions), on each kernel
    /// serving it: an absolute path, or one relative to the kernel's data directory.
    #[serde(skip_serializing, default)]
    #[sea_orm(column_type = "Text", unique)]
    pub folder: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

impl super::schema::Definition for Entity {}
