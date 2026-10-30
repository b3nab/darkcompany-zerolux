use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "conversations")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub workspace_id: String,
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub kind: String,
    #[sea_orm(column_type = "Text")]
    pub title: String,
    #[sea_orm(default_value = false)]
    pub paused: bool,
    #[sea_orm(default_value = 1)]
    pub next_seq: i64,
    pub created_at: i64,
    #[sea_orm(column_type = "Text")]
    pub parent_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub root_message_id: Option<String>,
    pub closed_at: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::workspace::Entity",
        from = "Column::WorkspaceId",
        to = "super::workspace::Column::Id",
        fk_name = "conversations_workspace_id_fkey"
    )]
    Workspace,
    #[sea_orm(
        belongs_to = "Entity",
        from = "(Column::WorkspaceId, Column::ParentId)",
        to = "(Column::WorkspaceId, Column::Id)",
        fk_name = "conversations_parent_id_fkey"
    )]
    Parent,
    #[sea_orm(
        belongs_to = "super::messages::Entity",
        from = "(Column::WorkspaceId, Column::RootMessageId)",
        to = "(super::messages::Column::WorkspaceId, super::messages::Column::Id)",
        fk_name = "conversations_root_message_id_fkey"
    )]
    RootMessage,
}

impl ActiveModelBehavior for ActiveModel {}

impl super::schema::Definition for Entity {
    fn constraints(
        backend: sea_orm::DatabaseBackend,
        table: &mut sea_orm::sea_query::TableCreateStatement,
        indexes: &mut Vec<sea_orm::sea_query::IndexCreateStatement>,
    ) {
        use sea_orm::sea_query::{ConditionalStatement, Expr, ExprTrait, Index};
        table.check(Expr::col(Column::Kind).is_in(["dm", "group", "thread"]));
        table.check(
            Expr::col(Column::Kind)
                .eq("thread")
                .eq(Expr::col(Column::ParentId)
                    .is_not_null()
                    .and(Expr::col(Column::RootMessageId).is_not_null())),
        );
        if backend == sea_orm::DatabaseBackend::Sqlite {
            table.check(Expr::col(Column::Paused).is_in([0, 1]));
        }
        indexes.push(
            Index::create()
                .name("one_open_thread_per_root")
                .table(Entity)
                .col(Column::WorkspaceId)
                .col(Column::RootMessageId)
                .unique()
                .and_where(Expr::col(Column::ClosedAt).is_null())
                .take(),
        );
    }
}
