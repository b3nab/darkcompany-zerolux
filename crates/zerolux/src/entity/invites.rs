use sea_orm::entity::prelude::*;

/// An invitation to join the workspace as a person: used once, until it expires.
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "invites")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub workspace_id: String,
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub token_hash: String,
    #[sea_orm(column_type = "Text")]
    pub created_by: String,
    pub created_at: i64,
    pub expires_at: i64,
    /// The person who joined with it.
    #[sea_orm(column_type = "Text")]
    pub accepted_by: Option<String>,
    pub accepted_at: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::workspace::Entity",
        from = "Column::WorkspaceId",
        to = "super::workspace::Column::Id",
        fk_name = "invites_workspace_id_fkey"
    )]
    Workspace,
    #[sea_orm(
        belongs_to = "super::actors::Entity",
        from = "(Column::WorkspaceId, Column::CreatedBy)",
        to = "(super::actors::Column::WorkspaceId, super::actors::Column::Id)",
        fk_name = "invites_created_by_fkey"
    )]
    Creator,
    #[sea_orm(
        belongs_to = "super::actors::Entity",
        from = "(Column::WorkspaceId, Column::AcceptedBy)",
        to = "(super::actors::Column::WorkspaceId, super::actors::Column::Id)",
        fk_name = "invites_accepted_by_fkey"
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
        table.index(
            sea_orm::sea_query::Index::create()
                .name("invites_token_hash_key")
                .unique()
                .col(Column::WorkspaceId)
                .col(Column::TokenHash),
        );
    }
}
