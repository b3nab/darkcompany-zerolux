//! The workspace tables as SeaORM entities, one module per table, in the order of the
//! bootstrap schema. Column types are those of the kernel: milliseconds as `i64`, flags as
//! `bool`.

pub mod actors;
pub mod chat_outbox;
pub mod chat_sessions;
pub mod conversation_members;
pub mod conversations;
pub mod deliveries;
pub mod messages;
pub mod tool_approvals;
pub mod workspace;
