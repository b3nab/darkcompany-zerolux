use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "chat_sessions")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    /// One row per native session of an agent: a relink replaces only its token.
    #[sea_orm(column_type = "Text", unique_key = "native_session")]
    pub actor_id: String,
    #[sea_orm(column_type = "Text", unique_key = "native_session")]
    pub harness: String,
    #[sea_orm(column_type = "Text", unique_key = "native_session")]
    pub native_session_id: String,
    #[sea_orm(column_type = "Text")]
    pub title: String,
    #[sea_orm(column_type = "Text")]
    pub workspace: String,
    #[sea_orm(column_type = "Text")]
    pub native_locator_json: String,
    #[sea_orm(column_type = "Text", unique)]
    pub token_hash: String,
    #[sea_orm(column_type = "Text")]
    pub status: String,
    #[sea_orm(column_type = "Text")]
    pub attention_reason: Option<String>,
    pub created_at: i64,
    pub stopped_at: Option<i64>,
    #[sea_orm(column_type = "Text")]
    pub activity: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub activity_conversation_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub host_id: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::actors::Entity",
        from = "Column::ActorId",
        to = "super::actors::Column::Id",
        fk_name = "chat_sessions_actor_id_fkey"
    )]
    Actor,
    #[sea_orm(
        belongs_to = "super::conversations::Entity",
        from = "Column::ActivityConversationId",
        to = "super::conversations::Column::Id",
        fk_name = "chat_sessions_activity_conversation_id_fkey"
    )]
    ActivityConversation,
}

impl ActiveModelBehavior for ActiveModel {}

impl super::schema::Definition for Entity {
    fn constraints(
        _: sea_orm::DatabaseBackend,
        table: &mut sea_orm::sea_query::TableCreateStatement,
        indexes: &mut Vec<sea_orm::sea_query::IndexCreateStatement>,
    ) {
        use sea_orm::sea_query::{ConditionalStatement, Expr, ExprTrait, Index};
        table.check(Expr::col(Column::Harness).is_in(["pi", "claude-code", "codex"]));
        table.check(Expr::col(Column::Status).is_in([
            "connecting",
            "connected",
            "attention",
            "stopped",
        ]));
        table.check(Expr::col(Column::Activity).is_in(["working", "idle"]));
        table.check(
            Expr::col(Column::Status)
                .eq("stopped")
                .eq(Expr::col(Column::StoppedAt).is_not_null()),
        );
        indexes.push(
            Index::create()
                .name("one_chat_session")
                .table(Entity)
                .col(Column::Harness)
                .col(Column::NativeSessionId)
                .unique()
                .and_where(Expr::col(Column::StoppedAt).is_null())
                .take(),
        );
    }
}
