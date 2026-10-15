//! Print the entity schema for Atlas. No database connection or kernel startup.
use sea_orm::DatabaseBackend;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let dialect = args.next().unwrap_or_default();
    anyhow::ensure!(
        args.next().is_none(),
        "usage: schema-export sqlite|postgres|both"
    );
    match dialect.as_str() {
        "both" => println!(
            "{}",
            serde_json::json!({
                "sqlite": zerolux::entity::schema::sql(DatabaseBackend::Sqlite),
                "postgres": zerolux::entity::schema::sql(DatabaseBackend::Postgres),
            })
        ),
        "sqlite" => print!("{}", zerolux::entity::schema::sql(DatabaseBackend::Sqlite)),
        "postgres" => print!(
            "{}",
            zerolux::entity::schema::sql(DatabaseBackend::Postgres)
        ),
        _ => anyhow::bail!("usage: schema-export sqlite|postgres|both"),
    }
    Ok(())
}
