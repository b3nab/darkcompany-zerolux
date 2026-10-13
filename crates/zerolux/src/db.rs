//! The kernel's database: one SeaORM connection over the same pool the store queries, and
//! the migrations that shape it. SQLite is the local workspace's database; PostgreSQL the
//! server's. Both run the same migrations.
//!
//! Opening is one serialized write transaction: validation of what is already there and
//! every pending migration with its ledger row, committed together or not at all. Two
//! kernels opening the same data at once take turns; the second finds nothing left to do.
//! A database migrated by a newer kernel is refused rather than guessed at.

use std::{path::Path, time::Duration};

use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, DatabaseTransaction, DbErr,
    SqliteTransactionMode, SqlxPostgresConnector, SqlxSqliteConnector, Statement,
    TransactionOptions, TransactionTrait,
};
use sea_orm_migration::prelude::*;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

use crate::store::Error;

/// The bootstrap schema, in the dialect of each database.
const BOOTSTRAP_SQLITE: &str = include_str!("../schema/0001_bootstrap.sqlite.sql");
const BOOTSTRAP_POSTGRES: &str = include_str!("../schema/0001_bootstrap.postgres.sql");
/// One lock for every kernel migrating the same PostgreSQL database.
const MIGRATION_LOCK: i64 = 0x5a45_524f_4c55_5831; // "ZEROLUX1"

/// Where a workspace keeps its data: a SQLite file, or a PostgreSQL server by URL. Neither
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
    migrate::<Migrator>(&db).await?;
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
        tx.execute_raw(Statement::from_sql_and_values(
            backend,
            "SELECT pg_advisory_xact_lock($1)",
            [MIGRATION_LOCK.into()],
        ))
        .await
        .map_err(schema)?;
    }
    refuse_unknown::<M>(&tx).await?;
    M::up(&tx, None).await.map_err(schema)?;
    tx.commit().await.map_err(schema)?;
    Ok(())
}

/// A ledger naming a migration this kernel does not have is a database of a newer kernel:
/// refused before anything is written to it.
async fn refuse_unknown<M: MigratorTrait>(tx: &DatabaseTransaction) -> Result<(), Error> {
    let backend = tx.get_database_backend();
    if !table_exists(tx, "seaql_migrations").await? {
        return Ok(());
    }
    let known: Vec<String> = M::migrations()
        .iter()
        .map(|m| m.name().to_owned())
        .collect();
    let rows = tx
        .query_all_raw(Statement::from_string(
            backend,
            "SELECT version FROM seaql_migrations ORDER BY version",
        ))
        .await
        .map_err(schema)?;
    for row in rows {
        let version: String = row.try_get("", "version").map_err(schema)?;
        if !known.contains(&version) {
            return Err(Error::Schema(format!(
                "This workspace database was migrated by a newer ZeroLux ({version}); it is not opened"
            )));
        }
    }
    Ok(())
}

async fn table_exists(tx: &DatabaseTransaction, name: &str) -> Result<bool, Error> {
    let backend = tx.get_database_backend();
    let sql = match backend {
        DatabaseBackend::Sqlite => {
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = $1"
        }
        _ => {
            "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1"
        }
    };
    let row = tx
        .query_one_raw(Statement::from_sql_and_values(backend, sql, [name.into()]))
        .await
        .map_err(schema)?;
    let count: i64 = row
        .ok_or_else(|| Error::Schema("Schema catalogue returned no row".into()))?
        .try_get("", "n")
        .map_err(schema)?;
    Ok(count > 0)
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
        vec![Box::new(Bootstrap), Box::new(Auth)]
    }
}

/// The schema every workspace starts from, in the dialect of its database.
struct Bootstrap;

impl MigrationName for Bootstrap {
    fn name(&self) -> &str {
        "m0001_bootstrap"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Bootstrap {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let sql = match manager.get_database_backend() {
            DatabaseBackend::Postgres => BOOTSTRAP_POSTGRES,
            _ => BOOTSTRAP_SQLITE,
        };
        manager.get_connection().execute_unprepared(sql).await?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Migration(
            "The bootstrap schema is never dropped by a migration".into(),
        ))
    }
}

/// Sign-in and more than one kernel: the human subject bound to the owner, the workspace's
/// own authentication secret (shared by every kernel serving it), and the host each agent
/// session lives on.
struct Auth;

impl MigrationName for Auth {
    fn name(&self) -> &str {
        "m0002_auth"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Auth {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE actors ADD COLUMN auth_subject TEXT;
                CREATE UNIQUE INDEX one_actor_per_subject ON actors(auth_subject) WHERE auth_subject IS NOT NULL;
                ALTER TABLE workspace ADD COLUMN auth_secret TEXT;
                ALTER TABLE chat_sessions ADD COLUMN host_id TEXT;",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE chat_sessions DROP COLUMN host_id;
                ALTER TABLE workspace DROP COLUMN auth_secret;
                DROP INDEX one_actor_per_subject;
                ALTER TABLE actors DROP COLUMN auth_subject;",
            )
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            vec![Box::new(Bootstrap), Box::new(Auth), Box::new(Broken)]
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
