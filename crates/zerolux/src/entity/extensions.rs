use sea_orm::entity::prelude::*;

/// An extension installed in the workspace.
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "extensions")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub workspace_id: String,
    /// `publisher.name`.
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub id: String,
    #[sea_orm(column_type = "Text")]
    pub version: String,
    /// Where its files are on the kernel's host.
    #[sea_orm(column_type = "Text")]
    pub source: String,
    /// Loaded from a folder being worked on, rather than from a package.
    pub dev: bool,
    pub enabled: bool,
    /// Why it could not be enabled or stopped working.
    #[sea_orm(column_type = "Text")]
    pub error: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub manifest_json: String,
    /// What it brings, as it said when it was last enabled.
    #[sea_orm(column_type = "Text")]
    pub contributes_json: Option<String>,
    pub installed_at: i64,
    pub updated_at: i64,
    /// The agent that proposed it, from a folder it wrote, until the owner enables it.
    #[sea_orm(column_type = "Text")]
    pub proposed_by: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::workspace::Entity",
        from = "Column::WorkspaceId",
        to = "super::workspace::Column::Id",
        fk_name = "extensions_workspace_id_fkey"
    )]
    Workspace,
}

impl ActiveModelBehavior for ActiveModel {}

impl super::schema::Definition for Entity {}
