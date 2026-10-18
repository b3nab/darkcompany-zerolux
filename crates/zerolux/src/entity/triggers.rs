use sea_orm::entity::prelude::*;

/// Input a session receives when something it waits for happens.
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "triggers")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub session_id: String,
    /// What it waits for: `ci`, the end of the CI runs of the session's current commit.
    #[sea_orm(column_type = "Text")]
    pub event: String,
    /// Told only when something failed, rather than whenever the runs end.
    pub failures_only: bool,
    /// The words that come with what happened; may be empty.
    #[sea_orm(column_type = "Text")]
    pub prompt: String,
    pub enabled: bool,
    /// What was last told: the commit and the runs it ended with.
    #[sea_orm(column_type = "Text")]
    pub last_seen: Option<String>,
    pub last_run_at: Option<i64>,
    #[sea_orm(column_type = "Text")]
    pub last_error: Option<String>,
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::sessions::Entity",
        from = "Column::SessionId",
        to = "super::sessions::Column::Id",
        fk_name = "triggers_session_id_fkey"
    )]
    Session,
}

impl ActiveModelBehavior for ActiveModel {}

impl super::schema::Definition for Entity {
    fn constraints(
        _: sea_orm::DatabaseBackend,
        table: &mut sea_orm::sea_query::TableCreateStatement,
        _: &mut Vec<sea_orm::sea_query::IndexCreateStatement>,
    ) {
        use sea_orm::sea_query::{Expr, ExprTrait};
        table.check(Expr::col(Column::Event).is_in(["ci"]));
    }
}
