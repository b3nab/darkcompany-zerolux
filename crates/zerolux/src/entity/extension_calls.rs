use sea_orm::entity::prelude::*;

/// An extension's action, run by a person, an agent's session or another extension.
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "extension_calls")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub workspace_id: String,
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub extension_id: String,
    #[sea_orm(column_type = "Text")]
    pub action: String,
    /// The person or agent who ran it; none when an extension or a trigger did.
    #[sea_orm(column_type = "Text")]
    pub actor_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub session_id: Option<String>,
    /// The extension or trigger that ran it.
    #[sea_orm(column_type = "Text")]
    pub by: Option<String>,
    pub at: i64,
    pub duration_ms: i64,
    pub ok: bool,
    #[sea_orm(column_type = "Text")]
    pub error: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::workspace::Entity",
        from = "Column::WorkspaceId",
        to = "super::workspace::Column::Id",
        fk_name = "extension_calls_workspace_id_fkey"
    )]
    Workspace,
}

impl ActiveModelBehavior for ActiveModel {}

impl super::schema::Definition for Entity {
    fn constraints(
        _: sea_orm::DatabaseBackend,
        _: &mut sea_orm::sea_query::TableCreateStatement,
        indexes: &mut Vec<sea_orm::sea_query::IndexCreateStatement>,
    ) {
        use sea_orm::sea_query::Index;
        indexes.push(
            Index::create()
                .name("extension_calls_by_extension")
                .table(Entity)
                .col(Column::WorkspaceId)
                .col(Column::ExtensionId)
                .col(Column::At)
                .take(),
        );
    }
}
