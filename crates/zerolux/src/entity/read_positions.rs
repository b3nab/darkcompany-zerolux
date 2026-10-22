use sea_orm::entity::prelude::*;

/// How far a person has read, the same on all their devices: a chat up to a message's seq, a
/// session's work up to a moment of its output.
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "read_positions")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub actor_id: String,
    /// `conversation` or `session`.
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub kind: String,
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub subject_id: String,
    /// A chat's seq, or a session's time in ms.
    pub position: i64,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::actors::Entity",
        from = "Column::ActorId",
        to = "super::actors::Column::Id",
        fk_name = "read_positions_actor_id_fkey"
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
        table.check(Expr::col(Column::Kind).is_in(["conversation", "session"]));
        table.check(Expr::col(Column::Position).gte(0));
    }
}
