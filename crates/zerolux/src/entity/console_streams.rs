use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "console_streams")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text", unique_key = "native_identity")]
    pub actor_id: String,
    #[sea_orm(column_type = "Text", unique_key = "native_identity")]
    pub harness: String,
    #[sea_orm(column_type = "Text", unique_key = "native_identity")]
    pub native_session_id: String,
    #[sea_orm(column_type = "Text", unique_key = "native_identity")]
    pub host_id: String,
    #[sea_orm(default_value = 1)]
    pub next_seq: i64,
    pub created_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::actors::Entity",
        from = "Column::ActorId",
        to = "super::actors::Column::Id"
    )]
    Actor,
}

impl ActiveModelBehavior for ActiveModel {}

impl super::schema::Definition for Entity {
    fn constraints(
        _: sea_orm::DatabaseBackend,
        table: &mut sea_orm::sea_query::TableCreateStatement,
        _: &mut Vec<sea_orm::sea_query::IndexCreateStatement>,
    ) {
        use sea_orm::sea_query::{Expr, ExprTrait};
        table.check(Expr::col(Column::NextSeq).gt(0));
    }
}
