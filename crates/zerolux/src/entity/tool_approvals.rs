use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "tool_approvals")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub session_id: String,
    /// The chat delivery whose turn asked, if a chat message started it.
    #[sea_orm(column_type = "Text")]
    pub delivery_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub native_request_id: String,
    /// What the session asks: "permission" (allow or deny), "question" or "form".
    #[sea_orm(column_type = "Text", default_value = "permission")]
    pub kind: String,
    #[sea_orm(column_type = "Text")]
    pub summary: String,
    /// The native request; for a question or a form, its questions or fields.
    #[sea_orm(column_type = "Text")]
    pub details_json: String,
    #[sea_orm(column_type = "Text")]
    pub status: String,
    /// A permission's decision.
    #[sea_orm(column_type = "Text")]
    pub decision: Option<String>,
    /// The owner's answer to a question or a form.
    #[sea_orm(column_type = "Text")]
    pub answer_json: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub decision_delivered_at: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::chat_sessions::Entity",
        from = "Column::SessionId",
        to = "super::chat_sessions::Column::Id",
        fk_name = "tool_approvals_session_id_fkey"
    )]
    Session,
    #[sea_orm(
        belongs_to = "super::deliveries::Entity",
        from = "Column::DeliveryId",
        to = "super::deliveries::Column::Id",
        fk_name = "tool_approvals_delivery_id_fkey"
    )]
    Delivery,
}

impl ActiveModelBehavior for ActiveModel {}

impl super::schema::Definition for Entity {
    fn constraints(
        _: sea_orm::DatabaseBackend,
        table: &mut sea_orm::sea_query::TableCreateStatement,
        _: &mut Vec<sea_orm::sea_query::IndexCreateStatement>,
    ) {
        use sea_orm::sea_query::{Expr, ExprTrait, Index};
        table.index(
            Index::create()
                .name("tool_approvals_session_id_native_request_id_key")
                .unique()
                .col(Column::SessionId)
                .col(Column::NativeRequestId),
        );
        table.check(Expr::col(Column::Status).is_in([
            "pending",
            "decided",
            "uncertain",
            "delivered",
            "resolved",
        ]));
        table.check(Expr::col(Column::Kind).is_in(["permission", "question", "form"]));
        table.check(Expr::col(Column::Decision).is_in(["allow", "deny"]));
        // A permission is decided; a question or a form is answered.
        table.check(
            Expr::col(Column::Kind)
                .eq("permission")
                .and(Expr::col(Column::AnswerJson).is_null())
                .or(Expr::col(Column::Kind)
                    .ne("permission")
                    .and(Expr::col(Column::Decision).is_null())),
        );
        table.check(
            Expr::col(Column::Status)
                .is_not_in(["decided", "uncertain", "delivered"])
                .or(Expr::col(Column::Decision).is_not_null())
                .or(Expr::col(Column::AnswerJson).is_not_null()),
        );
    }
}
