//! The database a test runs against: a SQLite file in its temporary directory, or, when
//! `ZEROLUX_TEST_POSTGRES_URL` names a disposable server, a PostgreSQL database of its own,
//! created here and dropped at the end. The same scenarios run on both, one pass each.
#![allow(dead_code)]

use std::path::PathBuf;

use sqlx::Executor;
use zerolux::{db::Location, store::Store};

pub struct TestDatabase {
    location: Location,
    postgres: Option<Dropped>,
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

    /// Opens the store; again and again, as a kernel restart would.
    pub async fn open(&self) -> Store {
        Store::open_at(&self.location).await.unwrap()
    }
}
