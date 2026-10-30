use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbErr,
    EntityTrait, FromQueryResult, QueryFilter, QueryOrder, RuntimeErr, Set, SqliteTransactionMode,
    Statement, TransactionOptions, TransactionTrait,
    sea_query::{Expr, Value},
};
use uuid::Uuid;

use crate::{
    db::Location,
    entity::{actors, instance, invites, workspace},
    model::*,
};

pub const LEASE_MS: i64 = 90_000;
/// The one writer at a time of a workspace on PostgreSQL ("ZLXW"), keyed by its ID.
const WORKSPACE_WRITE_LOCK: i32 = 0x5a4c_5857;
/// The one writer at a time of the instance's own rows on PostgreSQL ("ZEROLUXI").
const INSTANCE_WRITE_LOCK: i64 = 0x5a45_524f_4c55_5849;
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
    #[error("This changed meanwhile; refresh and try again")]
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

/// The instance: one database, its identity and sign-in secret, and its workspaces. Each
/// workspace's data is reached through its own `Store`.
#[derive(Clone)]
pub struct Instance {
    db: DatabaseConnection,
    id: String,
    auth_secret: String,
}

/// A workspace the signed-in account is a person of.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, FromQueryResult)]
pub struct Membership {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    /// The account is its owner, rather than a member who joined.
    pub owner: bool,
}

/// One workspace's data. Every statement reads or writes only its rows. Every write of the
/// domain happens in a `write()` transaction: one writer at a time of the workspace, so what
/// a transaction checked still holds when it commits. Reads go through `read()` for a
/// snapshot, or straight to `db` for one query.
#[derive(Clone)]
pub struct Store {
    pub(crate) db: DatabaseConnection,
    pub(crate) workspace: String,
    /// The kernel host this store serves: agent sessions it creates live here, and only
    /// these are recovered and relinked by it. `None` for a store without a host (tests).
    pub(crate) host: Option<String>,
    /// Where the people a host is open to keep their harness folders on it.
    pub(crate) people: Option<std::path::PathBuf>,
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

/// A transaction that will write. Writers take turns, as they always have on SQLite: there
/// `BEGIN IMMEDIATE` takes the write lock at once; on PostgreSQL the transaction takes the
/// advisory lock of the workspace, or of the instance, first. Either way a check made inside
/// the transaction still holds when its write commits, and readers are never blocked.
async fn begin_write(
    db: &DatabaseConnection,
    workspace: Option<&str>,
) -> Result<DatabaseTransaction> {
    let tx = db
        .begin_with_options(TransactionOptions {
            isolation_level: None,
            access_mode: None,
            sqlite_transaction_mode: Some(SqliteTransactionMode::Immediate),
        })
        .await?;
    if tx.get_database_backend() == sea_orm::DatabaseBackend::Postgres {
        let lock = match workspace {
            Some(id) => sql(
                &tx,
                "SELECT pg_advisory_xact_lock($1, hashtext($2))",
                [WORKSPACE_WRITE_LOCK.into(), id.into()],
            ),
            None => sql(
                &tx,
                "SELECT pg_advisory_xact_lock($1)",
                [INSTANCE_WRITE_LOCK.into()],
            ),
        };
        tx.execute_raw(lock).await?;
    }
    Ok(tx)
}

/// A workspace's name: no control characters.
fn workspace_name(value: &str) -> Result<String> {
    let name = text(value, "Workspace name", 200, true)?;
    if name.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "Enter the workspace name without control characters".into(),
        ));
    }
    Ok(name)
}

impl Instance {
    /// Opens the database, brings its schema up to date and makes the instance's row the first
    /// time. Two processes may open a new database at once. SQLite reports the switch to WAL as
    /// locked without waiting, so opening waits and tries again.
    pub async fn open(location: &Location) -> Result<Self> {
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
        let db = crate::db::connect(location).await?;
        // Made once, by whichever kernel opens the database first; never regenerated.
        let tx = begin_write(&db, None).await?;
        let row = match instance::Entity::find().one(&tx).await? {
            Some(row) => row,
            None => {
                instance::ActiveModel {
                    id: Set(Uuid::new_v4().to_string()),
                    auth_secret: Set(random_token()),
                    created_at: Set(now_ms()),
                }
                .insert(&tx)
                .await?
            }
        };
        tx.commit().await?;
        Ok(Self {
            db,
            id: row.id,
            auth_secret: row.auth_secret,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// Better Auth's signing secret, the same for every kernel serving this instance.
    pub fn auth_secret(&self) -> &str {
        &self.auth_secret
    }

    pub fn db(&self) -> &DatabaseConnection {
        &self.db
    }

    /// The data of the workspace `workspace_id`.
    pub fn store(&self, workspace_id: &str) -> Store {
        Store {
            db: self.db.clone(),
            workspace: workspace_id.to_owned(),
            host: None,
            people: None,
        }
    }

    /// A transaction that changes the instance's own rows, such as its workspaces.
    pub async fn write(&self) -> Result<DatabaseTransaction> {
        begin_write(&self.db, None).await
    }

    /// A new workspace and its owner, the account `subject`, named after the account: both in
    /// one transaction. Its `folder` is a path on the kernel's computer; by default
    /// `workspaces/<id>`, in the kernel's data directory.
    pub async fn create_workspace(
        &self,
        subject: &str,
        account_name: &str,
        name: &str,
        folder: Option<&Path>,
    ) -> Result<WorkspaceInfo> {
        let name = workspace_name(name)?;
        let owner = owner_name(account_name)?;
        let id = Uuid::new_v4().to_string();
        let folder = match folder {
            Some(folder) => folder.to_owned(),
            None => Path::new("workspaces").join(&id),
        };
        let folder = folder
            .to_str()
            .filter(|folder| !folder.is_empty())
            .ok_or_else(|| Error::Invalid("Name the workspace's folder with a UTF-8 path".into()))?
            .to_owned();
        let now = now_ms();
        let tx = self.write().await?;
        if workspace::Entity::find()
            .filter(workspace::Column::Folder.eq(&folder))
            .one(&tx)
            .await?
            .is_some()
        {
            return Err(Error::Conflict);
        }
        let workspace = workspace::ActiveModel {
            id: Set(id.clone()),
            name: Set(name),
            created_at: Set(now),
            folder: Set(folder),
        }
        .insert(&tx)
        .await?;
        actors::ActiveModel {
            workspace_id: Set(id),
            id: Set(Uuid::new_v4().to_string()),
            name: Set(owner),
            kind: Set("human".into()),
            owner_id: Set(None),
            harness: Set(None),
            archived: Set(false),
            name_confirmed: Set(true),
            created_at: Set(now),
            auth_subject: Set(Some(subject.to_owned())),
            model: Set(None),
            effort: Set(None),
            permission_mode: Set(None),
            approval_policy: Set(None),
            sandbox: Set(None),
            invited_by: Set(None),
            role: Set(Some(OWNER.into())),
        }
        .insert(&tx)
        .await?;
        tx.commit().await?;
        Ok(workspace)
    }

    /// Every workspace of the instance, oldest first.
    pub async fn workspaces(&self) -> Result<Vec<WorkspaceInfo>> {
        Ok(workspace::Entity::find()
            .order_by_asc(workspace::Column::CreatedAt)
            .order_by_asc(workspace::Column::Id)
            .all(&self.db)
            .await?)
    }

    /// The workspaces the account `subject` is a person of, oldest first.
    pub async fn memberships(&self, subject: &str) -> Result<Vec<Membership>> {
        fetch_all(
            &self.db,
            sql(
                &self.db,
                "SELECT w.id,w.name,w.created_at,a.role='owner' AS owner FROM workspace w
                JOIN actors a ON a.workspace_id=w.id
                WHERE a.auth_subject=$1 AND a.kind='human' AND a.archived=FALSE
                ORDER BY w.created_at,w.id",
                [subject.into()],
            ),
        )
        .await
    }

    /// The workspace holding a usable invitation with `token`, whichever it is.
    pub async fn invited_to(&self, token: &str) -> Result<Option<String>> {
        Ok(invites::Entity::find()
            .filter(invites::Column::TokenHash.eq(token_hash(token)))
            .filter(invites::Column::AcceptedBy.is_null())
            .filter(invites::Column::ExpiresAt.gt(now_ms()))
            .one(&self.db)
            .await?
            .map(|invite| invite.workspace_id))
    }
}

/// The role of the person who set a workspace up; the others are members.
pub(crate) const OWNER: &str = "owner";
pub(crate) const MEMBER: &str = "member";

impl Store {
    /// The database as SeaORM sees it.
    pub fn db(&self) -> &DatabaseConnection {
        &self.db
    }

    /// The workspace whose rows this store reads and writes.
    pub fn workspace_id(&self) -> &str {
        &self.workspace
    }

    /// The primary key of this workspace's row `id`.
    pub fn key(&self, id: &str) -> (String, String) {
        (self.workspace.clone(), id.to_owned())
    }

    /// The same store, serving the kernel host `host_id`.
    pub fn hosted(mut self, host_id: String) -> Self {
        self.host = Some(host_id);
        self
    }

    pub fn host(&self) -> Option<&str> {
        self.host.as_deref()
    }

    /// The same store, keeping the harness folders of the people its host is open to under
    /// `dir`.
    pub fn with_people(mut self, dir: std::path::PathBuf) -> Self {
        self.people = Some(dir);
        self
    }

    /// A transaction that will write this workspace's rows: one writer of it at a time.
    pub async fn write(&self) -> Result<DatabaseTransaction> {
        begin_write(&self.db, Some(&self.workspace)).await
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

    pub async fn set_owner_name(&self, input: SetOwnerName) -> Result<Actor> {
        let name = owner_name(&input.name)?;
        let tx = self.write().await?;
        let owner = actors::Entity::update_many()
            .col_expr(actors::Column::Name, Expr::value(name))
            .col_expr(actors::Column::NameConfirmed, Expr::value(true))
            .filter(actors::Column::WorkspaceId.eq(&self.workspace))
            .filter(actors::Column::Role.eq(OWNER))
            .exec_with_returning(&tx)
            .await?
            .pop()
            .ok_or(Error::NotFound)?;
        tx.commit().await?;
        Ok(owner)
    }

    /// The person a signed-in subject is in this workspace; nobody when it is not a member.
    pub async fn actor_for_subject(&self, subject: &str) -> Result<Option<Actor>> {
        Ok(actors::Entity::find()
            .filter(actors::Column::WorkspaceId.eq(&self.workspace))
            .filter(actors::Column::AuthSubject.eq(subject))
            .filter(actors::Column::Archived.eq(false))
            .one(&self.db)
            .await?)
    }

    /// The workspace's owner, by role.
    pub(crate) async fn owner(&self) -> Result<Actor> {
        actors::Entity::find()
            .filter(actors::Column::WorkspaceId.eq(&self.workspace))
            .filter(actors::Column::Role.eq(OWNER))
            .one(&self.db)
            .await?
            .ok_or(Error::NotFound)
    }

    pub async fn workspace_info(&self) -> Result<WorkspaceInfo> {
        workspace::Entity::find_by_id(&self.workspace)
            .one(&self.db)
            .await?
            .ok_or(Error::NotFound)
    }

    pub async fn set_workspace_name(&self, input: SetWorkspaceName) -> Result<WorkspaceInfo> {
        let name = workspace_name(&input.name)?;
        let tx = self.write().await?;
        let workspace = workspace::Entity::update_many()
            .col_expr(workspace::Column::Name, Expr::value(name))
            .filter(workspace::Column::Id.eq(&self.workspace))
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
        let workspace = workspace::Entity::find_by_id(&self.workspace)
            .one(&tx)
            .await?
            .ok_or(Error::NotFound)?;
        let actors = actors::Entity::find()
            .filter(actors::Column::WorkspaceId.eq(&self.workspace))
            .order_by_desc(actors::Column::Kind)
            .order_by_asc(actors::Column::Name)
            .all(&tx)
            .await?;
        let onboarding_required = !actors
            .iter()
            .find(|actor| actor.role.as_deref() == Some(OWNER))
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
