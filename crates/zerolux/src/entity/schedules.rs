use sea_orm::entity::prelude::*;

/// Input the owner has a session receive on a schedule.
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "schedules")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub session_id: String,
    /// When, as a cron pattern in the kernel host's time.
    #[sea_orm(column_type = "Text")]
    pub cron: String,
    /// What the session receives, as the owner's input.
    #[sea_orm(column_type = "Text")]
    pub prompt: String,
    pub enabled: bool,
    pub next_run_at: Option<i64>,
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
        fk_name = "schedules_session_id_fkey"
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
        use sea_orm::sea_query::{ConditionalStatement, Expr, ExprTrait, Index};
        indexes.push(
            Index::create()
                .name("schedules_due")
                .table(Entity)
                .col(Column::NextRunAt)
                .and_where(Expr::col(Column::Enabled).eq(true))
                .take(),
        );
    }
}
