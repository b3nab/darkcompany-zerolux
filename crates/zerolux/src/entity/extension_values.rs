use sea_orm::entity::prelude::*;

/// An extension's settings, secrets and stored values.
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "extension_values")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub extension_id: String,
    /// `setting`, `secret` or `value`.
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub kind: String,
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub key: String,
    #[sea_orm(column_type = "Text")]
    pub value_json: String,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::extensions::Entity",
        from = "Column::ExtensionId",
        to = "super::extensions::Column::Id",
        on_delete = "Cascade",
        fk_name = "extension_values_extension_id_fkey"
    )]
    Extension,
}

impl ActiveModelBehavior for ActiveModel {}

impl super::schema::Definition for Entity {
    fn constraints(
        _: sea_orm::DatabaseBackend,
        table: &mut sea_orm::sea_query::TableCreateStatement,
        _: &mut Vec<sea_orm::sea_query::IndexCreateStatement>,
    ) {
        use sea_orm::sea_query::{Expr, ExprTrait};
        table.check(Expr::col(Column::Kind).is_in(["setting", "secret", "value"]));
    }
}
