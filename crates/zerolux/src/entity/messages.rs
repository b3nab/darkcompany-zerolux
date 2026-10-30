use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "messages")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub workspace_id: String,
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub conversation_id: String,
    pub seq: i64,
    #[sea_orm(column_type = "Text")]
    pub author_id: String,
    #[sea_orm(column_type = "Text")]
    pub text: String,
    #[sea_orm(column_type = "Text")]
    pub reply_to_delivery_id: Option<String>,
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::workspace::Entity",
        from = "Column::WorkspaceId",
        to = "super::workspace::Column::Id",
        fk_name = "messages_workspace_id_fkey"
    )]
    Workspace,
    #[sea_orm(
        belongs_to = "super::conversations::Entity",
        from = "(Column::WorkspaceId, Column::ConversationId)",
        to = "(super::conversations::Column::WorkspaceId, super::conversations::Column::Id)",
        fk_name = "messages_conversation_id_fkey"
    )]
    Conversation,
    #[sea_orm(
        belongs_to = "super::actors::Entity",
        from = "(Column::WorkspaceId, Column::AuthorId)",
        to = "(super::actors::Column::WorkspaceId, super::actors::Column::Id)",
        fk_name = "messages_author_id_fkey"
    )]
    Author,
    #[sea_orm(
        belongs_to = "super::deliveries::Entity",
        from = "(Column::WorkspaceId, Column::ReplyToDeliveryId)",
        to = "(super::deliveries::Column::WorkspaceId, super::deliveries::Column::Id)",
        fk_name = "messages_reply_to_delivery_id_fkey"
    )]
    ReplyToDelivery,
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
                .name("messages_conversation_id_seq_key")
                .unique()
                .col(Column::WorkspaceId)
                .col(Column::ConversationId)
                .col(Column::Seq),
        );
        table.index(
            sea_orm::sea_query::Index::create()
                .name("messages_reply_to_delivery_id_key")
                .unique()
                .col(Column::WorkspaceId)
                .col(Column::ReplyToDeliveryId),
        );
    }
}
