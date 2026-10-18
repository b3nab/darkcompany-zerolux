use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbErr,
    EntityTrait, FromQueryResult, QueryFilter, QueryOrder, RuntimeErr, SqliteTransactionMode,
    Statement, TransactionOptions, TransactionTrait,
    sea_query::{Expr, Value},
};
use uuid::Uuid;

use crate::{
    db::Location,
    entity::{actors, workspace},
    model::*,
};

pub const LEASE_MS: i64 = 90_000;
/// The one writer at a time of a workspace on PostgreSQL ("ZEROLUXW").
const WORKSPACE_WRITE_LOCK: i64 = 0x5a45_524f_4c55_5857;
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Invalid or revoked agent token")]
    Unauthorized,
    #[error("This identity cannot access this operation")]
    Forbidden,
    #[error("{0}")]
    Invalid(String),
    #[error("Set your name to complete owner onboarding first")]
    OnboardingRequired,
    #[error("Not found")]
    NotFound,
    #[error("The requested operation conflicts with the current state; refresh and try again")]
    Conflict,
    #[error("The owner stopped this session while it was being relinked")]
    StoppedByOwner,
    #[error(transparent)]
    Database(#[from] DbErr),
    #[error("{0}")]
    Schema(String),
}

impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(DbErr::Conn(RuntimeErr::SqlxError(std::sync::Arc::new(
            error,
        ))))
    }
}

impl Error {
    /// SQLite reporting a lock it did not wait for.
    fn is_locked(&self) -> bool {
        match self {
            Self::Database(
                DbErr::Conn(RuntimeErr::SqlxError(e))
                | DbErr::Exec(RuntimeErr::SqlxError(e))
                | DbErr::Query(RuntimeErr::SqlxError(e)),
            ) => matches!(&**e, sqlx::Error::Database(d) if d.message().contains("locked")),
            _ => false,
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// The workspace's data. Every write of the domain happens in a `write()` transaction:
/// one writer at a time on either database, so what a transaction checked still holds when
/// it commits. Reads go through `read()` for a snapshot, or straight to `db` for one query.
#[derive(Clone)]
pub struct Store {
    pub(crate) db: DatabaseConnection,
    /// The kernel host this store serves: agent sessions it creates live here, and only
    /// these are recovered and relinked by it. `None` for a store without a host (tests).
    pub(crate) host: Option<String>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before Unix epoch")
        .as_millis() as i64
}

pub(crate) fn random_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

pub(crate) fn token_hash(token: &str) -> String {
    use sha2::Digest;
    format!("{:x}", sha2::Sha256::digest(token.as_bytes()))
}

/// The owner's own name: no placeholder, no control characters.
pub(crate) fn owner_name(value: &str) -> Result<String> {
    let name = text(value, "Your name", 200, true)?;
    if name.eq_ignore_ascii_case("Local owner") || name.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "Enter your name without placeholders or control characters".into(),
        ));
    }
    Ok(name)
}

pub(crate) fn text(value: &str, label: &str, max: usize, required: bool) -> Result<String> {
    let value = value.trim();
    if (required && value.is_empty()) || value.len() > max {
        return Err(Error::Invalid(format!(
            "{label} must be {}1–{max} bytes",
            if required { "" } else { "empty or " }
        )));
    }
    Ok(value.to_owned())
}

/// One SQL statement in the kernel's dialect-neutral form: `$N` placeholders, `TRUE`/`FALSE`
/// for flags. Both databases run it as written.
pub fn sql<C: ConnectionTrait>(
    db: &C,
    sql: impl Into<String>,
    values: impl IntoIterator<Item = Value>,
) -> Statement {
    Statement::from_sql_and_values(db.get_database_backend(), sql, values)
}

/// `UPDATE … RETURNING` and friends: the one row they produce, as `T`.
pub(crate) async fn fetch_one<T: FromQueryResult, C: ConnectionTrait>(
    db: &C,
    statement: Statement,
) -> Result<Option<T>> {
    Ok(T::find_by_statement(statement).one(db).await?)
}

pub(crate) async fn fetch_all<T: FromQueryResult, C: ConnectionTrait>(
    db: &C,
    statement: Statement,
) -> Result<Vec<T>> {
    Ok(T::find_by_statement(statement).all(db).await?)
}

/// A single value, such as `SELECT EXISTS(…)` or a count.
pub(crate) async fn scalar<T, C>(db: &C, statement: Statement) -> Result<T>
where
    T: sea_orm::TryGetable,
    C: ConnectionTrait,
{
    let row = db
        .query_one_raw(statement)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("Expected one row".into()))?;
    Ok(row.try_get_by_index::<T>(0)?)
}

pub(crate) async fn execute<C: ConnectionTrait>(db: &C, statement: Statement) -> Result<u64> {
    Ok(db.execute_raw(statement).await?.rows_affected())
}

impl Store {
    /// The database as SeaORM sees it.
    pub fn db(&self) -> &DatabaseConnection {
        &self.db
    }

    /// The same store, serving the kernel host `host_id`.
    pub fn hosted(mut self, host_id: String) -> Self {
        self.host = Some(host_id);
        self
    }

    pub fn host(&self) -> Option<&str> {
        self.host.as_deref()
    }

    /// A transaction that will write. Writers take turns, as they always have on SQLite: there
    /// `BEGIN IMMEDIATE` takes the write lock at once; on PostgreSQL the transaction takes the
    /// workspace's advisory lock first. Either way a check made inside the transaction still
    /// holds when its write commits, and readers are never blocked.
    pub async fn write(&self) -> Result<DatabaseTransaction> {
        let tx = self
            .db
            .begin_with_options(TransactionOptions {
                isolation_level: None,
                access_mode: None,
                sqlite_transaction_mode: Some(SqliteTransactionMode::Immediate),
            })
            .await?;
        if tx.get_database_backend() == sea_orm::DatabaseBackend::Postgres {
            tx.execute_raw(sql(
                &tx,
                "SELECT pg_advisory_xact_lock($1)",
                [WORKSPACE_WRITE_LOCK.into()],
            ))
            .await?;
        }
        Ok(tx)
    }

    /// A consistent read of several tables: one snapshot, on both databases.
    pub async fn read(&self) -> Result<DatabaseTransaction> {
        // SQLite reads one snapshot by nature; PostgreSQL is asked for one.
        let postgres = self.db.get_database_backend() == sea_orm::DatabaseBackend::Postgres;
        Ok(self
            .db
            .begin_with_options(TransactionOptions {
                isolation_level: postgres.then_some(sea_orm::IsolationLevel::RepeatableRead),
                access_mode: postgres.then_some(sea_orm::AccessMode::ReadOnly),
                sqlite_transaction_mode: None,
            })
            .await?)
    }

    /// Two processes may open a new database at once. SQLite reports the switch to WAL as
    /// locked without waiting, so opening waits and tries again.
    pub async fn open(path: &Path) -> Result<Self> {
        Self::open_at(&Location::Sqlite(path.to_path_buf())).await
    }

    pub async fn open_at(location: &Location) -> Result<Self> {
        let mut attempts = 0;
        loop {
            match Self::open_once(location).await {
                Err(error) if attempts < 50 && error.is_locked() => {
                    attempts += 1;
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                opened => return opened,
            }
        }
    }

    async fn open_once(location: &Location) -> Result<Self> {
        let store = Self {
            db: crate::db::connect(location).await?,
            host: None,
        };
        // The workspace and its owner are born together, by one open: both inserts in one
        // write transaction, so concurrent first opens cannot split them across two
        // instants. Existing identity, name, dates and ownership links are never regenerated.
        let now = now_ms();
        let tx = store.write().await?;
        if workspace::Entity::find().one(&tx).await?.is_none() {
            workspace::ActiveModel {
                id: sea_orm::Set(Uuid::new_v4().to_string()),
                name: sea_orm::Set("Workspace".into()),
                created_at: sea_orm::Set(now),
                only_one: sea_orm::Set(1),
                auth_secret: sea_orm::Set(None),
            }
            .insert(&tx)
            .await?;
        }
        if actors::Entity::find()
            .filter(actors::Column::Kind.eq("human"))
            .filter(actors::Column::InvitedBy.is_null())
            .one(&tx)
            .await?
            .is_none()
        {
            actors::ActiveModel {
                id: sea_orm::Set(Uuid::new_v4().to_string()),
                name: sea_orm::Set("Local owner".into()),
                kind: sea_orm::Set("human".into()),
                owner_id: sea_orm::Set(None),
                harness: sea_orm::Set(None),
                archived: sea_orm::Set(false),
                name_confirmed: sea_orm::Set(false),
                created_at: sea_orm::Set(now),
                auth_subject: sea_orm::Set(None),
                model: sea_orm::Set(None),
                effort: sea_orm::Set(None),
                permission_mode: sea_orm::Set(None),
                approval_policy: sea_orm::Set(None),
                sandbox: sea_orm::Set(None),
                invited_by: sea_orm::Set(None),
            }
            .insert(&tx)
            .await?;
        }
        tx.commit().await?;
        Ok(store)
    }

    pub async fn set_owner_name(&self, input: SetOwnerName) -> Result<Actor> {
        let name = owner_name(&input.name)?;
        let tx = self.write().await?;
        let owner = actors::Entity::update_many()
            .col_expr(actors::Column::Name, Expr::value(name))
            .col_expr(actors::Column::NameConfirmed, Expr::value(true))
            .filter(actors::Column::Kind.eq("human"))
            .filter(actors::Column::InvitedBy.is_null())
            .exec_with_returning(&tx)
            .await?
            .pop()
            .ok_or(Error::NotFound)?;
        tx.commit().await?;
        Ok(owner)
    }

    /// Whether a human account is bound to the owner yet: until then signing up is open and
    /// nobody is signed in as the owner; the first account to claim is the owner.
    pub async fn owner_bound(&self) -> Result<bool> {
        Ok(self.owner().await?.auth_subject.is_some())
    }

    /// The workspace's Better Auth secret: made once, by whichever kernel opens the workspace
    /// first, and used by every kernel serving it.
    pub async fn auth_secret(&self) -> Result<String> {
        let tx = self.write().await?;
        let workspace = workspace::Entity::find()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        if let Some(secret) = workspace.auth_secret {
            return Ok(secret);
        }
        let secret = random_token();
        workspace::Entity::update_many()
            .col_expr(
                workspace::Column::AuthSecret,
                Expr::value(Some(secret.clone())),
            )
            .exec(&tx)
            .await?;
        tx.commit().await?;
        Ok(secret)
    }

    /// The actor a signed-in subject is: the owner, once bound; nobody otherwise.
    pub async fn actor_for_subject(&self, subject: &str) -> Result<Option<Actor>> {
        Ok(actors::Entity::find()
            .filter(actors::Column::AuthSubject.eq(subject))
            .filter(actors::Column::Archived.eq(false))
            .one(&self.db)
            .await?)
    }

    /// Binds a signed-in subject to the owner, once: the first account to claim is the
    /// owner. A confirmed name stays; otherwise the account's name becomes the owner's, with
    /// the same checks as naming oneself. The same subject binding again is no change;
    /// another subject after that is a conflict: the owner is one.
    pub async fn bind_owner(&self, subject: &str, account_name: &str) -> Result<Actor> {
        let tx = self.write().await?;
        let owner = actors::Entity::find()
            .filter(actors::Column::Kind.eq("human"))
            .filter(actors::Column::InvitedBy.is_null())
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        match owner.auth_subject.as_deref() {
            Some(bound) if bound == subject => return Ok(owner),
            Some(_) => return Err(Error::Conflict),
            None => {}
        }
        let mut update = actors::Entity::update_many()
            .col_expr(
                actors::Column::AuthSubject,
                Expr::value(Some(subject.to_owned())),
            )
            .filter(actors::Column::Id.eq(&owner.id))
            .filter(actors::Column::AuthSubject.is_null());
        if !owner.name_confirmed {
            let name = owner_name(account_name)?;
            update = update
                .col_expr(actors::Column::Name, Expr::value(name))
                .col_expr(actors::Column::NameConfirmed, Expr::value(true));
        }
        let owner = update
            .exec_with_returning(&tx)
            .await?
            .pop()
            .ok_or(Error::Conflict)?;
        tx.commit().await?;
        Ok(owner)
    }

    async fn owner(&self) -> Result<Actor> {
        actors::Entity::find()
            .filter(actors::Column::Kind.eq("human"))
            .filter(actors::Column::InvitedBy.is_null())
            .one(&self.db)
            .await?
            .ok_or(Error::NotFound)
    }

    pub async fn workspace_info(&self) -> Result<WorkspaceInfo> {
        workspace::Entity::find()
            .one(&self.db)
            .await?
            .ok_or(Error::NotFound)
    }

    pub async fn set_workspace_name(&self, input: SetWorkspaceName) -> Result<WorkspaceInfo> {
        let name = text(&input.name, "Workspace name", 200, true)?;
        if name.chars().any(char::is_control) {
            return Err(Error::Invalid(
                "Enter the workspace name without control characters".into(),
            ));
        }
        let tx = self.write().await?;
        let workspace = workspace::Entity::update_many()
            .col_expr(workspace::Column::Name, Expr::value(name))
            .exec_with_returning(&tx)
            .await?
            .pop()
            .ok_or(Error::NotFound)?;
        tx.commit().await?;
        Ok(workspace)
    }

    pub(crate) async fn require_onboarding(&self) -> Result<()> {
        if !self.owner().await?.name_confirmed {
            return Err(Error::OnboardingRequired);
        }
        Ok(())
    }

    pub async fn workspace(&self) -> Result<Workspace> {
        let tx = self.read().await?;
        let workspace = workspace::Entity::find()
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        let actors = actors::Entity::find()
            .order_by_desc(actors::Column::Kind)
            .order_by_asc(actors::Column::Name)
            .all(&tx)
            .await?;
        let onboarding_required = !actors
            .iter()
            .find(|actor| actor.kind == "human" && actor.invited_by.is_none())
            .ok_or(Error::NotFound)?
            .name_confirmed;
        tx.commit().await?;
        Ok(Workspace {
            workspace,
            actors,
            onboarding_required,
        })
    }
}
