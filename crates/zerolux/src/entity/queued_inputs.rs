use sea_orm::entity::prelude::*;

/// An input of a person's, waiting in ZeroLux for its session's turn: the next turn starts with
/// the first one.
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "queued_inputs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub workspace_id: String,
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub session_id: String,
    /// Its place in the queue: the lowest goes first.
    pub position: i64,
    #[sea_orm(column_type = "Text")]
    pub text: String,
    /// The images that go with it, kept in the workspace's attachments: `[{path, media_type}]`.
    #[sea_orm(column_type = "Text")]
    pub images_json: String,
    /// Who wrote it.
    #[sea_orm(column_type = "Text")]
    pub author_id: String,
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::workspace::Entity",
        from = "Column::WorkspaceId",
        to = "super::workspace::Column::Id",
        fk_name = "queued_inputs_workspace_id_fkey"
    )]
    Workspace,
    #[sea_orm(
        belongs_to = "super::sessions::Entity",
        from = "(Column::WorkspaceId, Column::SessionId)",
        to = "(super::sessions::Column::WorkspaceId, super::sessions::Column::Id)",
        fk_name = "queued_inputs_session_id_fkey",
        on_delete = "Cascade"
    )]
    Session,
}

impl ActiveModelBehavior for ActiveModel {}

impl super::schema::Definition for Entity {
    fn constraints(
        _: sea_orm::DatabaseBackend,
        _: &mut sea_orm::sea_query::TableCreateStatement,
        indexes: &mut Vec<sea_orm::sea_query::IndexCreateStatement>,
    ) {
        indexes.push(
            sea_orm::sea_query::Index::create()
                .name("queued_inputs_session_position")
                .table(Entity)
                .col(Column::WorkspaceId)
                .col(Column::SessionId)
                .col(Column::Position)
                .to_owned(),
        );
    }
}
