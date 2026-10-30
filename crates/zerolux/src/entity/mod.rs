//! Domain entities. Schema metadata belongs to the entities; release migrations
//! are immutable artifacts, not a schema inferred from the live database at startup.

pub mod background_commands;
pub mod schema;

pub mod actors;
pub mod chat_outbox;
pub mod conversation_members;
pub mod conversations;
pub mod deliveries;
pub mod extension_calls;
pub mod extension_values;
pub mod extensions;
pub mod hosts;
pub mod instance;
pub mod invites;
pub mod messages;
pub mod read_positions;
pub mod schedules;
pub mod sessions;
pub mod tool_approvals;
pub mod triggers;
pub mod workspace;
