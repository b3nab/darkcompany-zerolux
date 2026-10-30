use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "chat_outbox")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub workspace_id: String,
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub event_id: String,
    #[sea_orm(column_type = "Text")]
    pub payload_json: String,
    #[sea_orm(column_type = "Text")]
    pub recipient_actor_ids_json: String,
    pub created_at: i64,
    pub published_at: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::workspace::Entity",
        from = "Column::WorkspaceId",
        to = "super::workspace::Column::Id",
        fk_name = "chat_outbox_workspace_id_fkey"
    )]
    Workspace,
}

impl ActiveModelBehavior for ActiveModel {}

impl super::schema::Definition for Entity {
    fn constraints(
        _: sea_orm::DatabaseBackend,
        _: &mut sea_orm::sea_query::TableCreateStatement,
        indexes: &mut Vec<sea_orm::sea_query::IndexCreateStatement>,
    ) {
        use sea_orm::sea_query::{ConditionalStatement, Expr, ExprTrait, Index};
        indexes.push(
            Index::create()
                .name("chat_outbox_pending")
                .table(Entity)
                .col(Column::WorkspaceId)
                .col(Column::CreatedAt)
                .and_where(Expr::col(Column::PublishedAt).is_null())
                .take(),
        );
    }
}
