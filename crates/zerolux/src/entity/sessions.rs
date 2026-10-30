use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "sessions")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub workspace_id: String,
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    /// The agent the session works for; none for the owner's own.
    #[sea_orm(column_type = "Text")]
    pub actor_id: Option<String>,
    /// One row per native session: a relink replaces only its token.
    #[sea_orm(column_type = "Text")]
    pub harness: String,
    #[sea_orm(column_type = "Text")]
    pub native_session_id: String,
    #[sea_orm(column_type = "Text")]
    pub title: String,
    #[sea_orm(column_type = "Text")]
    pub workspace: String,
    #[sea_orm(column_type = "Text")]
    pub native_locator_json: String,
    #[sea_orm(column_type = "Text")]
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
    pub pinned_at: Option<i64>,
    pub archived_at: Option<i64>,
    /// What the session may cost, in cents: at the limit its work stops for the owner.
    pub budget_cents: Option<i64>,
    /// The session that started this one to delegate work to it, which may follow and steer it.
    #[sea_orm(column_type = "Text")]
    pub parent_session_id: Option<String>,
    /// The person whose session it is.
    #[sea_orm(column_type = "Text")]
    pub owner_id: String,
    /// Private when none; otherwise the workspace's people may `read` it, or `write` to it too.
    #[sea_orm(column_type = "Text")]
    pub shared: Option<String>,
    /// ZeroLux started its native session, rather than finding one started elsewhere.
    #[sea_orm(default_value = false)]
    pub created: bool,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::workspace::Entity",
        from = "Column::WorkspaceId",
        to = "super::workspace::Column::Id",
        fk_name = "sessions_workspace_id_fkey"
    )]
    Workspace,
    #[sea_orm(
        belongs_to = "super::actors::Entity",
        from = "(Column::WorkspaceId, Column::ActorId)",
        to = "(super::actors::Column::WorkspaceId, super::actors::Column::Id)",
        fk_name = "sessions_actor_id_fkey"
    )]
    Actor,
    #[sea_orm(
        belongs_to = "super::conversations::Entity",
        from = "(Column::WorkspaceId, Column::ActivityConversationId)",
        to = "(super::conversations::Column::WorkspaceId, super::conversations::Column::Id)",
        fk_name = "sessions_activity_conversation_id_fkey"
    )]
    ActivityConversation,
    #[sea_orm(
        belongs_to = "super::actors::Entity",
        from = "(Column::WorkspaceId, Column::OwnerId)",
        to = "(super::actors::Column::WorkspaceId, super::actors::Column::Id)",
        fk_name = "sessions_owner_id_fkey"
    )]
    Owner,
}

impl ActiveModelBehavior for ActiveModel {}

impl super::schema::Definition for Entity {
    fn constraints(
        _: sea_orm::DatabaseBackend,
        table: &mut sea_orm::sea_query::TableCreateStatement,
        indexes: &mut Vec<sea_orm::sea_query::IndexCreateStatement>,
    ) {
        use sea_orm::sea_query::{Expr, ExprTrait, Index};
        table.check(Expr::col(Column::Harness).is_in(["pi", "claude-code", "codex"]));
        table.check(Expr::col(Column::Status).is_in([
            "connecting",
            "connected",
            "attention",
            "stopped",
        ]));
        table.check(Expr::col(Column::Activity).is_in(["working", "idle"]));
        table.check(Expr::col(Column::Shared).is_in(["read", "write"]));
        table.check(
            Expr::col(Column::Status)
                .eq("stopped")
                .eq(Expr::col(Column::StoppedAt).is_not_null()),
        );
        indexes.push(
            Index::create()
                .name("sessions_native_session")
                .table(Entity)
                .col(Column::WorkspaceId)
                .col(Column::Harness)
                .col(Column::NativeSessionId)
                .unique()
                .take(),
        );
        indexes.push(
            Index::create()
                .name("sessions_token_hash")
                .table(Entity)
                .col(Column::WorkspaceId)
                .col(Column::TokenHash)
                .unique()
                .take(),
        );
    }
}
