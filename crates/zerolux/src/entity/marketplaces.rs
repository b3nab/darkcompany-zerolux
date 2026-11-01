use sea_orm::entity::prelude::*;

/// A marketplace the instance reads, for all its workspaces: the address of its index.
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "marketplaces")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub url: String,
    /// The name its index gives itself.
    #[sea_orm(column_type = "Text")]
    pub name: String,
    pub added_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

impl super::schema::Definition for Entity {}
