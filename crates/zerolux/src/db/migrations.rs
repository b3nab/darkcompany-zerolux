//! SeaORM applies the immutable SQL artifacts produced by the development workflow.
//! There is no schema diff, Atlas invocation or entity-driven DDL at kernel startup.

use sea_orm::{ConnectionTrait, DatabaseBackend, DbErr};
use sea_orm_migration::{MigrationName, MigrationTrait, SchemaManager};

#[derive(Clone, Copy)]
struct SqlMigration {
    name: &'static str,
    sqlite: &'static str,
    postgres: &'static str,
}

include!("../../migrations/registry.rs");

pub(super) fn all() -> Vec<Box<dyn MigrationTrait>> {
    MIGRATIONS
        .iter()
        .map(|migration| Box::new(*migration) as Box<dyn MigrationTrait>)
        .collect()
}

impl MigrationName for SqlMigration {
    fn name(&self) -> &str {
        self.name
    }
}

#[async_trait::async_trait]
impl MigrationTrait for SqlMigration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let sql = match manager.get_database_backend() {
            DatabaseBackend::Sqlite => self.sqlite,
            DatabaseBackend::Postgres => self.postgres,
            _ => return Err(DbErr::Migration("Unsupported workspace database".into())),
        };
        if !sql.trim().is_empty() {
            manager.get_connection().execute_unprepared(sql).await?;
        }
        Ok(())
    }

    async fn down(&self, _: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Migration(
            "Automatic schema rollback is disabled: restore the workspace backup together with its kernel version".into(),
        ))
    }
}
