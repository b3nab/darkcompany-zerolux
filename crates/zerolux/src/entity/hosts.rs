use sea_orm::entity::prelude::*;

/// A computer that runs sessions of the workspace: a kernel, and the person whose it is.
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "hosts")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub name: String,
    /// The person whose computer it is: its sessions and native history are theirs.
    #[sea_orm(column_type = "Text")]
    pub person_id: String,
    /// Other people may start their own sessions here, with their own harness accounts.
    pub open: bool,
    pub created_at: i64,
    /// When its kernel last started.
    pub seen_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::actors::Entity",
        from = "Column::PersonId",
        to = "super::actors::Column::Id",
        fk_name = "hosts_person_id_fkey"
    )]
    Person,
}

impl ActiveModelBehavior for ActiveModel {}

impl super::schema::Definition for Entity {}
