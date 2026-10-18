use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "deliveries")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub message_id: String,
    #[sea_orm(column_type = "Text")]
    pub actor_id: String,
    #[sea_orm(column_type = "Text")]
    pub session_id: String,
    #[sea_orm(column_type = "Text")]
    pub status: String,
    #[sea_orm(column_type = "Text")]
    pub native_request_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::messages::Entity",
        from = "Column::MessageId",
        to = "super::messages::Column::Id",
        fk_name = "deliveries_message_id_fkey"
    )]
    Message,
    #[sea_orm(
        belongs_to = "super::actors::Entity",
        from = "Column::ActorId",
        to = "super::actors::Column::Id",
        fk_name = "deliveries_actor_id_fkey"
    )]
    Actor,
    #[sea_orm(
        belongs_to = "super::sessions::Entity",
        from = "Column::SessionId",
        to = "super::sessions::Column::Id",
        fk_name = "deliveries_session_id_fkey"
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
        table.check(Expr::col(Column::Status).is_in(["stored", "uncertain", "notified", "read"]));
        table.index(
            Index::create()
                .name("deliveries_message_id_actor_id_key")
                .unique()
                .col(Column::MessageId)
                .col(Column::ActorId),
        );
        indexes.push(
            Index::create()
                .name("deliveries_session")
                .table(Entity)
                .col(Column::SessionId)
                .col(Column::Status)
                .col(Column::CreatedAt)
                .take(),
        );
    }
}
