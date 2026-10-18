use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "actors")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub name: String,
    #[sea_orm(column_type = "Text")]
    pub kind: String,
    #[sea_orm(column_type = "Text")]
    pub owner_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub harness: Option<String>,
    #[sea_orm(default_value = false)]
    pub archived: bool,
    #[serde(skip_serializing, default)]
    #[sea_orm(default_value = false)]
    pub name_confirmed: bool,
    pub created_at: i64,
    /// The subject of the human account bound to this actor, for the owner.
    #[serde(skip_serializing, default)]
    #[sea_orm(column_type = "Text")]
    pub auth_subject: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub model: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub effort: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub permission_mode: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub approval_policy: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub sandbox: Option<String>,
    /// For a person who joined by invitation, who invited them; none for the workspace's owner.
    #[sea_orm(column_type = "Text")]
    pub invited_by: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "Entity",
        from = "Column::OwnerId",
        to = "Column::Id",
        fk_name = "actors_owner_id_fkey"
    )]
    Owner,
}

impl ActiveModelBehavior for ActiveModel {}

impl super::schema::Definition for Entity {
    fn constraints(
        backend: sea_orm::DatabaseBackend,
        table: &mut sea_orm::sea_query::TableCreateStatement,
        indexes: &mut Vec<sea_orm::sea_query::IndexCreateStatement>,
    ) {
        use sea_orm::sea_query::{ConditionalStatement, Expr, ExprTrait, Index};
        table.check(Expr::col(Column::Kind).is_in(["human", "agent"]));
        table.check(Expr::col(Column::Harness).is_in(["pi", "claude-code", "codex"]));
        table.check(
            Expr::col(Column::Kind)
                .eq("human")
                .and(Expr::col(Column::OwnerId).is_null())
                .or(Expr::col(Column::Kind)
                    .eq("agent")
                    .and(Expr::col(Column::OwnerId).is_not_null())),
        );
        if backend == sea_orm::DatabaseBackend::Sqlite {
            table.check(Expr::col(Column::Archived).is_in([0, 1]));
            table.check(Expr::col(Column::NameConfirmed).is_in([0, 1]));
        }
        indexes.push(
            Index::create()
                .name("one_workspace_owner")
                .table(Entity)
                .col(Column::Kind)
                .unique()
                .and_where(Expr::col(Column::Kind).eq("human"))
                .and_where(Expr::col(Column::InvitedBy).is_null())
                .take(),
        );
        indexes.push(
            Index::create()
                .name("one_actor_per_subject")
                .table(Entity)
                .col(Column::AuthSubject)
                .unique()
                .and_where(Expr::col(Column::AuthSubject).is_not_null())
                .take(),
        );
    }
}
