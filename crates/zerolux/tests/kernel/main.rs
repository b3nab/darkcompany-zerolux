//! The kernel's integration tests, in one binary: linked once, each test still run in a
//! process of its own by nextest. Tests that change the process's environment (`PATH`, homes) or
//! count its open files keep binaries of their own beside this one, so `cargo test` never runs
//! them among these.

// Unix only, as the tests that use them.
#[cfg(unix)]
#[allow(dead_code, unused_imports)]
#[path = "../support/claude_owned.rs"]
mod claude_owned;
#[cfg(unix)]
#[path = "../support/codex_runtime.rs"]
mod codex_runtime;
#[path = "../support/db.rs"]
mod db;
#[path = "../support/livekit.rs"]
mod livekit_support;
#[cfg(unix)]
#[path = "../support/owner.rs"]
mod owner;

mod auth;
mod background;
mod bootstrap;
mod byoh;
mod chat;
mod chat_api;
mod claude_terminal;
mod codex;
mod codex_stop;
mod expose;
mod internal_notifications;
mod livekit;
mod onboarding;
mod owned_chat;
mod owned_runner;
mod pi_chat;
mod pi_creation;
mod postgres;
mod schema;
mod server;
mod workspaces;
