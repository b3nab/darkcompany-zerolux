use sea_orm::entity::prelude::*;

/// A command a session runs in the background, in its folder: the session goes on, and is
/// told how it ended.
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "background_commands")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub session_id: String,
    #[sea_orm(column_type = "Text")]
    pub command: String,
    #[sea_orm(column_type = "Text")]
    pub folder: String,
    /// `running`, `exited`, `stopped` or `lost` (its end was not seen).
    #[sea_orm(column_type = "Text")]
    pub status: String,
    pub pid: Option<i64>,
    pub exit_code: Option<i32>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    /// When the session was told how it ended.
    pub told_at: Option<i64>,
    #[sea_orm(column_type = "Text")]
    pub error: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::sessions::Entity",
        from = "Column::SessionId",
        to = "super::sessions::Column::Id",
        on_delete = "Cascade",
        fk_name = "background_commands_session_id_fkey"
    )]
    Session,
}

impl ActiveModelBehavior for ActiveModel {}

impl super::schema::Definition for Entity {
    fn constraints(
        _: sea_orm::DatabaseBackend,
        table: &mut sea_orm::sea_query::TableCreateStatement,
        indexes: &mut Vec<sea_orm::sea_query::IndexCreateStatement>,
    ) {
        use sea_orm::sea_query::{Expr, ExprTrait, Index};
        table.check(Expr::col(Column::Status).is_in(["running", "exited", "stopped", "lost"]));
        indexes.push(
            Index::create()
                .name("background_commands_by_session")
                .table(Entity)
                .col(Column::SessionId)
                .col(Column::StartedAt)
                .to_owned(),
        );
    }
}
