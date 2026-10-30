use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "conversation_members")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub workspace_id: String,
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub conversation_id: String,
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub actor_id: String,
    #[sea_orm(column_type = "Text")]
    pub session_id: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::workspace::Entity",
        from = "Column::WorkspaceId",
        to = "super::workspace::Column::Id",
        fk_name = "conversation_members_workspace_id_fkey"
    )]
    Workspace,
    #[sea_orm(
        belongs_to = "super::conversations::Entity",
        from = "(Column::WorkspaceId, Column::ConversationId)",
        to = "(super::conversations::Column::WorkspaceId, super::conversations::Column::Id)",
        fk_name = "conversation_members_conversation_id_fkey"
    )]
    Conversation,
    #[sea_orm(
        belongs_to = "super::actors::Entity",
        from = "(Column::WorkspaceId, Column::ActorId)",
        to = "(super::actors::Column::WorkspaceId, super::actors::Column::Id)",
        fk_name = "conversation_members_actor_id_fkey"
    )]
    Actor,
    #[sea_orm(
        belongs_to = "super::sessions::Entity",
        from = "(Column::WorkspaceId, Column::SessionId)",
        to = "(super::sessions::Column::WorkspaceId, super::sessions::Column::Id)",
        fk_name = "conversation_members_session_id_fkey"
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
                .name("conversation_members_session")
                .table(Entity)
                .col(Column::WorkspaceId)
                .col(Column::SessionId)
                .take(),
        );
    }
}
