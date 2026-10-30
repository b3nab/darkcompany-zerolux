//! The database a test runs against: a SQLite file in its temporary directory, or, when
//! `ZEROLUX_TEST_POSTGRES_URL` names a disposable server, a PostgreSQL database of its own,
//! created here and dropped at the end. The same scenarios run on both, one pass each. A test
//! works in a workspace it makes with its owner, explicitly, on its first open.
#![allow(dead_code)]

use std::path::PathBuf;

use sqlx::Executor;
use zerolux::{
    db::Location,
    store::{Instance, Store},
};

/// The account a test's workspace owner is bound to.
pub const OWNER_SUBJECT: &str = "owner-account";

pub struct TestDatabase {
    location: Location,
    postgres: Option<Dropped>,
    /// The test's workspace, made by its first open.
    workspace: tokio::sync::OnceCell<String>,
}

/// Drops the PostgreSQL database when the test is done with it.
struct Dropped {
    admin: String,
    name: String,
}

impl Drop for Dropped {
    fn drop(&mut self) {
        let admin = self.admin.clone();
        let name = self.name.clone();
        // A runtime of its own: a destructor cannot await, and the test's runtime may be gone.
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    if let Ok(control) = sqlx::postgres::PgPoolOptions::new()
                        .max_connections(1)
                        .connect(&admin)
                        .await
                    {
                        let _ = control
                            .execute(sqlx::AssertSqlSafe(format!(
                                "DROP DATABASE {name} WITH (FORCE)"
                            )))
                            .await;
                    }
                });
        })
        .join()
        .ok();
    }
}

impl TestDatabase {
    /// `file` is where the SQLite database goes; on PostgreSQL it only names the test.
    pub async fn new(file: PathBuf) -> Self {
        let Ok(admin) = std::env::var("ZEROLUX_TEST_POSTGRES_URL") else {
            return Self {
                location: Location::Sqlite(file),
                postgres: None,
                workspace: Default::default(),
            };
        };
        let name = format!("zl_{}", uuid::Uuid::new_v4().simple());
        let control = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&admin)
            .await
            .expect("connect to the disposable PostgreSQL server");
        control
            .execute(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
            .await
            .expect("create the test database");
        let mut url = reqwest::Url::parse(&admin).unwrap();
        url.set_path(&format!("/{name}"));
        Self {
            location: Location::Postgres(url.to_string()),
            postgres: Some(Dropped { admin, name }),
            workspace: Default::default(),
        }
    }

    pub fn location(&self) -> &Location {
        &self.location
    }

    pub fn is_postgres(&self) -> bool {
        self.postgres.is_some()
    }

    /// The PostgreSQL database's name, for fixtures that look at the server's own view.
    pub fn name(&self) -> Option<String> {
        self.postgres.as_ref().map(|p| p.name.clone())
    }

    /// Opens the instance; again and again, as a kernel restart would.
    pub async fn instance(&self) -> Instance {
        Instance::open(&self.location).await.unwrap()
    }

    /// Opens the test's workspace, made with its owner the first time; again and again, as a
    /// kernel restart would.
    pub async fn open(&self) -> Store {
        let instance = self.instance().await;
        let id = self
            .workspace
            .get_or_init(|| async {
                instance
                    .create_workspace(OWNER_SUBJECT, "Owner", "Workspace", None)
                    .await
                    .unwrap()
                    .id
            })
            .await;
        instance.store(id)
    }
}
