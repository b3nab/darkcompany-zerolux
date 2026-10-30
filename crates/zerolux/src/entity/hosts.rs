use sea_orm::entity::prelude::*;

/// A computer that runs sessions of the workspace: a kernel, and the person whose it is.
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "hosts")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub workspace_id: String,
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
    /// When its kernel last started, or last connected.
    pub seen_at: i64,
    /// What a joined computer proves it is with, hashed; none for a kernel serving the
    /// workspace's database itself.
    #[sea_orm(column_type = "Text")]
    pub secret_hash: Option<String>,
    /// The one-time code its person gave the computer to join with, hashed, while unused.
    #[sea_orm(column_type = "Text")]
    pub link_hash: Option<String>,
    pub link_expires_at: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::workspace::Entity",
        from = "Column::WorkspaceId",
        to = "super::workspace::Column::Id",
        fk_name = "hosts_workspace_id_fkey"
    )]
    Workspace,
    #[sea_orm(
        belongs_to = "super::actors::Entity",
        from = "(Column::WorkspaceId, Column::PersonId)",
        to = "(super::actors::Column::WorkspaceId, super::actors::Column::Id)",
        fk_name = "hosts_person_id_fkey"
    )]
    Person,
}

impl ActiveModelBehavior for ActiveModel {}

impl super::schema::Definition for Entity {
    fn constraints(
        _: sea_orm::DatabaseBackend,
        table: &mut sea_orm::sea_query::TableCreateStatement,
        _: &mut Vec<sea_orm::sea_query::IndexCreateStatement>,
    ) {
        use sea_orm::sea_query::Index;
        table.index(
            Index::create()
                .name("hosts_secret_hash_key")
                .unique()
                .col(Column::WorkspaceId)
                .col(Column::SecretHash),
        );
        table.index(
            Index::create()
                .name("hosts_link_hash_key")
                .unique()
                .col(Column::WorkspaceId)
                .col(Column::LinkHash),
        );
    }
}
