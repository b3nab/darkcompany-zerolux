use sea_orm::entity::prelude::*;

/// The instance this database is: its one row, made when it is first opened.
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "instance")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    /// Better Auth's signing secret, shared by the kernels serving this instance.
    #[sea_orm(column_type = "Text")]
    pub auth_secret: String,
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

impl super::schema::Definition for Entity {}
