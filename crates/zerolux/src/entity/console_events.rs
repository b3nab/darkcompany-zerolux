use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "console_events")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "Text",
        unique_key = "event_part"
    )]
    pub stream_id: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub seq: i64,
    #[sea_orm(column_type = "Text", unique_key = "event_part")]
    pub event_id: String,
    #[sea_orm(unique_key = "event_part", default_value = 0)]
    pub part: i64,
    #[sea_orm(default_value = 1)]
    pub parts: i64,
    #[sea_orm(column_type = "Text")]
    pub kind: String,
    pub native_at: Option<i64>,
    pub recorded_at: i64,
    #[sea_orm(column_type = "Text")]
    pub payload_json: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::console_streams::Entity",
        from = "Column::StreamId",
        to = "super::console_streams::Column::Id"
    )]
    Stream,
}

impl ActiveModelBehavior for ActiveModel {}

impl super::schema::Definition for Entity {
    fn constraints(
        _: sea_orm::DatabaseBackend,
        table: &mut sea_orm::sea_query::TableCreateStatement,
        _: &mut Vec<sea_orm::sea_query::IndexCreateStatement>,
    ) {
        use sea_orm::sea_query::{Expr, ExprTrait};
        table.check(Expr::col(Column::Seq).gt(0));
        table.check(Expr::col(Column::Part).gte(0));
        table.check(
            Expr::col(Column::Parts)
                .gt(0)
                .and(Expr::col(Column::Part).lt(Expr::col(Column::Parts))),
        );
    }
}
