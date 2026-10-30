//! The kernel's database: one SeaORM connection over the same pool the store queries, and
//! the migrations that shape it. SQLite is a local instance's database; PostgreSQL the
//! server's. Both run the same migrations.
//!
//! Opening is one serialized write transaction: validation of what is already there and
//! every pending migration with its ledger row, committed together or not at all. Two
//! kernels opening the same data at once take turns; the second finds nothing left to do.
//! A database migrated by a newer kernel is refused rather than guessed at.

use std::{path::Path, time::Duration};

use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, DbErr, SqliteTransactionMode,
    SqlxPostgresConnector, SqlxSqliteConnector, TransactionOptions, TransactionTrait,
    sea_query::{Alias, Func, SelectStatement},
};
use sea_orm_migration::prelude::*;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

use crate::store::Error;

mod migrations;

/// One lock for every kernel migrating the same PostgreSQL database.
const MIGRATION_LOCK: i64 = 0x5a45_524f_4c55_5831; // "ZEROLUX1"

/// Where an instance keeps its data: a SQLite file, or a PostgreSQL server by URL. Neither
/// `Display` nor `Debug` shows the URL's credentials, query or fragment.
#[derive(Clone, PartialEq, Eq)]
pub enum Location {
    Sqlite(std::path::PathBuf),
    Postgres(String),
}

impl Location {
    /// A `postgres://` or `postgresql://` URL names a server; anything else without a scheme
    /// names a SQLite file. Another scheme, or a URL without a host, is an error: it never
    /// becomes a file name.
    pub fn parse(value: &str) -> Result<Self, String> {
        if !value.contains("://") {
            return Ok(Self::Sqlite(Path::new(value).to_path_buf()));
        }
        let url = url::Url::parse(value).map_err(|e| format!("Invalid database URL: {e}"))?;
        if !matches!(url.scheme(), "postgres" | "postgresql") {
            return Err(format!(
                "Unsupported database scheme {}://; use a SQLite path or a postgresql:// URL",
                url.scheme()
            ));
        }
        if url.host_str().is_none_or(str::is_empty) {
            return Err("A PostgreSQL URL names its host".into());
        }
        Ok(Self::Postgres(value.to_owned()))
    }

    pub fn is_postgres(&self) -> bool {
        matches!(self, Self::Postgres(_))
    }
}

/// For logs and messages: a PostgreSQL URL reduced to scheme, host, port and database.
impl std::fmt::Display for Location {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sqlite(path) => write!(f, "{}", path.display()),
            Self::Postgres(url) => match url::Url::parse(url) {
                Ok(mut url) => {
                    let _ = url.set_username("");
                    let _ = url.set_password(None);
                    url.set_query(None);
                    url.set_fragment(None);
                    write!(f, "{url}")
                }
                Err(_) => write!(f, "postgresql://…"),
            },
        }
    }
}

impl std::fmt::Debug for Location {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self}")
    }
}

/// Connects and brings the schema up to date. SQLite files are created, with WAL and foreign
/// keys as the kernel has always set them. Database errors keep their kind: a locked SQLite
/// file is still `Error::Database`, so the store's retry sees it.
pub async fn connect(location: &Location) -> Result<DatabaseConnection, Error> {
    let db = match location {
        Location::Sqlite(path) => {
            let options = SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(true)
                .foreign_keys(true)
                .journal_mode(SqliteJournalMode::Wal)
                .busy_timeout(Duration::from_secs(5));
            // SQLite's table-rebuild migrations need foreign keys disabled before BEGIN.
            // This private one-connection pool is never used by the store. Validate every
            // reference before COMMIT, close it, then open the ordinary FK-enabled pool.
            let migration_pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(options.clone().foreign_keys(false))
                .await?;
            let migration_db = SqlxSqliteConnector::from_sqlx_sqlite_pool(migration_pool);
            let result = migrate::<Migrator>(&migration_db).await;
            let closed = migration_db.close().await;
            result?;
            closed.map_err(schema)?;
            let pool = SqlitePoolOptions::new()
                .max_connections(5)
                .connect_with(options)
                .await?;
            SqlxSqliteConnector::from_sqlx_sqlite_pool(pool)
        }
        Location::Postgres(url) => {
            let pool = sqlx::postgres::PgPoolOptions::new()
                .max_connections(5)
                .connect(url)
                .await?;
            SqlxPostgresConnector::from_sqlx_postgres_pool(pool)
        }
    };
    if location.is_postgres() {
        migrate::<Migrator>(&db).await?;
    }
    Ok(db)
}

/// Validation and every pending migration of `M`, in one serialized transaction.
async fn migrate<M: MigratorTrait>(db: &DatabaseConnection) -> Result<(), Error> {
    let backend = db.get_database_backend();
    let tx = db
        .begin_with_options(TransactionOptions {
            isolation_level: None,
            access_mode: None,
            // SQLite: the write lock is taken at BEGIN, so concurrent opens queue here.
            sqlite_transaction_mode: Some(SqliteTransactionMode::Immediate),
        })
        .await
        .map_err(schema)?;
    if backend == DatabaseBackend::Postgres {
        tx.query_one(
            SelectStatement::new()
                .expr(Func::cust(Alias::new("pg_advisory_xact_lock")).arg(MIGRATION_LOCK)),
        )
        .await
        .map_err(schema)?;
    }
    // SeaORM already validates the applied versions without creating or changing tables.
    // Do not maintain a second ledger reader or backend-specific catalogue queries.
    M::get_migration_with_status_read_only(&tx)
        .await
        .map_err(|error| match error {
            DbErr::Migration(reason) => Error::Schema(format!(
                "This database was migrated by a newer ZeroLux or has an incomplete migration history; it is not opened: {reason}"
            )),
            other => schema(other),
        })?;
    M::up(&tx, None).await.map_err(schema)?;
    if backend == DatabaseBackend::Sqlite {
        let violation = tx
            .query_one(
                SelectStatement::new()
                    .expr(sea_orm::sea_query::Expr::val(1))
                    .from(Alias::new("pragma_foreign_key_check"))
                    .limit(1),
            )
            .await
            .map_err(schema)?;
        if violation.is_some() {
            return Err(Error::Schema(
                "The migration leaves invalid foreign keys; no schema changes were committed"
                    .into(),
            ));
        }
    }
    tx.commit().await.map_err(schema)?;
    Ok(())
}

/// Database errors keep their kind (a locked SQLite file stays retryable); what SeaORM
/// reports about the migration itself is a schema error.
fn schema(error: DbErr) -> Error {
    match error {
        DbErr::Conn(_) | DbErr::Exec(_) | DbErr::Query(_) => Error::Database(error),
        other => Error::Schema(other.to_string()),
    }
}

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        migrations::all()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::Statement;

    /// The bootstrap, then a migration that fails halfway: nothing of either may remain.
    struct Broken;
    impl MigrationName for Broken {
        fn name(&self) -> &str {
            "m0002_broken"
        }
    }
    #[async_trait::async_trait]
    impl MigrationTrait for Broken {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
            manager
                .get_connection()
                .execute_unprepared("CREATE TABLE half_done (id TEXT PRIMARY KEY)")
                .await?;
            Err(DbErr::Migration(
                "fixture failure after the first statement".into(),
            ))
        }
        async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
            Ok(())
        }
    }
    struct BrokenMigrator;
    #[async_trait::async_trait]
    impl MigratorTrait for BrokenMigrator {
        fn migrations() -> Vec<Box<dyn MigrationTrait>> {
            let mut migrations = Migrator::migrations();
            migrations.push(Box::new(Broken));
            migrations
        }
    }

    async fn sqlite(path: &Path) -> DatabaseConnection {
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(true)
                    .journal_mode(SqliteJournalMode::Wal)
                    .busy_timeout(Duration::from_secs(5)),
            )
            .await
            .unwrap();
        SqlxSqliteConnector::from_sqlx_sqlite_pool(pool)
    }

    async fn tables(db: &DatabaseConnection) -> Vec<String> {
        db.query_all_raw(Statement::from_string(
            db.get_database_backend(),
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.try_get::<String>("", "name").unwrap())
        .collect()
    }

    #[tokio::test]
    async fn a_migration_that_fails_halfway_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let db = sqlite(&dir.path().join("half.db")).await;
        let error = migrate::<BrokenMigrator>(&db).await.unwrap_err();
        assert!(error.to_string().contains("fixture failure"), "{error}");
        // Neither the bootstrap tables nor the half-done one nor any ledger row exists.
        assert_eq!(tables(&db).await, Vec::<String>::new());
        // The database is still a fresh one for a sound migrator.
        migrate::<Migrator>(&db).await.unwrap();
        assert!(tables(&db).await.contains(&"seaql_migrations".to_owned()));
    }

    #[test]
    fn a_location_is_a_file_or_a_postgres_url_and_shows_no_credentials() {
        assert_eq!(
            Location::parse(".zerolux/zerolux.db").unwrap(),
            Location::Sqlite(".zerolux/zerolux.db".into())
        );
        let url = "postgresql://user:secret@db.example:5432/zerolux?password=also-secret#x";
        let location = Location::parse(url).unwrap();
        assert_eq!(location, Location::Postgres(url.into()));
        assert_eq!(location.to_string(), "postgresql://db.example:5432/zerolux");
        assert_eq!(
            format!("{location:?}"),
            "postgresql://db.example:5432/zerolux"
        );
        for bad in [
            "mysql://db/x",
            "postgres:///nohost",
            "http://db/x",
            "postgresql://",
        ] {
            assert!(Location::parse(bad).is_err(), "{bad}");
        }
    }
}
