//! Development-time SQL export for Atlas. Columns and relations come from SeaORM;
//! additional constraints are declared alongside their entity, never in a second schema.
//! This module does not connect to a database or generate/apply migrations.

use sea_orm::sea_query::{IndexCreateStatement, Table, TableCreateStatement};
use sea_orm::{DatabaseBackend, EntityTrait, Schema};

pub trait Definition: EntityTrait {
    fn constraints(
        _backend: DatabaseBackend,
        _table: &mut TableCreateStatement,
        _indexes: &mut Vec<IndexCreateStatement>,
    ) {
    }
}

/// PostgreSQL needs cyclic references after all tables exist. SQLite needs them inline.
/// Both forms are derived from the same SeaORM relations.
fn append<E: Definition>(
    entity: E,
    backend: DatabaseBackend,
    tables: &mut Vec<String>,
    indexes: &mut Vec<String>,
    foreign_keys: &mut Vec<String>,
) {
    let schema = Schema::new(backend);
    let derived = schema.create_table_from_entity(entity);
    let mut table = if backend == DatabaseBackend::Postgres {
        let mut table = Table::create().table(entity.table_ref()).take();
        for column in derived.get_columns() {
            table.col(column.clone());
        }
        for index in derived.get_indexes() {
            table.index(&mut index.clone());
        }
        for key in derived.get_foreign_key_create_stmts() {
            let mut key = key.clone();
            key.from_tbl(entity.table_ref());
            foreign_keys.push(backend.build(&key).to_string());
        }
        table
    } else {
        derived
    };
    let mut entity_indexes = schema.create_index_from_entity(entity);
    E::constraints(backend, &mut table, &mut entity_indexes);
    tables.push(backend.build(&table).to_string());
    indexes.extend(
        entity_indexes
            .iter()
            .map(|index| backend.build(index).to_string()),
    );
}

pub fn sql(backend: DatabaseBackend) -> String {
    assert!(matches!(
        backend,
        DatabaseBackend::Sqlite | DatabaseBackend::Postgres
    ));
    let mut tables = Vec::new();
    let mut indexes = Vec::new();
    let mut foreign_keys = Vec::new();
    macro_rules! export {
        ($($name:ident),+ $(,)?) => {$(
            append(super::$name::Entity, backend, &mut tables, &mut indexes, &mut foreign_keys);
        )+};
    }
    export!(
        actors,
        workspace,
        chat_sessions,
        conversations,
        conversation_members,
        messages,
        deliveries,
        chat_outbox,
        tool_approvals,
        console_streams,
        console_events,
    );
    tables.extend(indexes);
    tables.extend(foreign_keys);
    format!(
        "-- Generated from ZeroLux SeaORM entities. Do not edit.\n{};\n",
        tables.join(";\n")
    )
}
