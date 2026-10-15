//! Domain entities. Schema metadata belongs to the entities; release migrations
//! are immutable artifacts, not a schema inferred from the live database at startup.

pub mod schema;

pub mod actors;
pub mod chat_outbox;
pub mod chat_sessions;
pub mod console_events;
pub mod console_streams;
pub mod conversation_members;
pub mod conversations;
pub mod deliveries;
pub mod messages;
pub mod tool_approvals;
pub mod workspace;
