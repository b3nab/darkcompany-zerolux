use sea_orm::FromQueryResult;
use serde::{Deserialize, Serialize};

/// Rows of the workspace tables, as the API shows them.
pub use crate::entity::{
    actors::Model as Actor, deliveries::Model as ChatDelivery, workspace::Model as WorkspaceInfo,
};

#[derive(Debug, Serialize, Deserialize)]
pub struct SetOwnerName {
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SetWorkspaceName {
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateAgent {
    pub name: String,
    pub owner_id: String,
    pub harness: crate::harness::Harness,
}

/// Public native values, or requested choices. Missing fields are unknown/unchanged.
/// Live controls accept concrete choices, never empty-string or null resets.
/// `permission_mode` is Claude Code's; `approval_policy` and `sandbox` are Codex's.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AgentSettings {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub approval_policy: Option<String>,
    #[serde(default)]
    pub sandbox: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Workspace {
    pub workspace: WorkspaceInfo,
    pub actors: Vec<Actor>,
    pub onboarding_required: bool,
}

/// The owner, or a session through its token. A session may belong to an agent.
#[derive(Debug, Clone)]
pub struct ChatIdentity {
    pub actor_id: Option<String>,
    pub session_id: Option<String>,
}

impl ChatIdentity {
    pub fn is_owner(&self) -> bool {
        self.session_id.is_none()
    }

    /// Who takes part in chats: the owner, or an agent through its session.
    pub fn actor(&self) -> Result<&str, crate::store::Error> {
        self.actor_id
            .as_deref()
            .ok_or(crate::store::Error::Forbidden)
    }

    /// Whom notices reach: the actor, or a session without an agent.
    pub fn addressee(&self) -> &str {
        self.actor_id
            .as_deref()
            .or(self.session_id.as_deref())
            .unwrap_or_default()
    }
}

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ClaudePermissionMode {
    #[default]
    Default,
    AcceptEdits,
    Plan,
    Auto,
}
impl ClaudePermissionMode {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::AcceptEdits => "acceptEdits",
            Self::Plan => "plan",
            Self::Auto => "auto",
        }
    }
}

#[derive(Deserialize)]
pub struct CreateClaudeSession {
    #[serde(default)]
    pub name: String,
    pub actor_id: Option<String>,
    pub workspace: String,
    /// Work in a new git worktree of the folder's repository, on this branch (empty: one
    /// named by ZeroLux).
    #[serde(default)]
    pub worktree: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<ClaudePermissionMode>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

/// A new Codex session, started by ZeroLux in a folder. What is omitted is decided by the
/// user's own Codex configuration: ZeroLux names no policy, sandbox or model of its own.
#[derive(Deserialize)]
pub struct CreateCodexSession {
    #[serde(default)]
    pub name: String,
    pub actor_id: Option<String>,
    pub workspace: String,
    /// Work in a new git worktree of the folder's repository, on this branch (empty: one
    /// named by ZeroLux).
    #[serde(default)]
    pub worktree: Option<String>,
    #[serde(default)]
    pub approval_policy: Option<CodexApprovalPolicy>,
    #[serde(default)]
    pub sandbox: Option<CodexSandbox>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

/// Native pi settings choose the model/tools; no initial prompt is supplied.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreatePiSession {
    #[serde(default)]
    pub name: String,
    pub actor_id: Option<String>,
    pub workspace: String,
    /// Work in a new git worktree of the folder's repository, on this branch (empty: one
    /// named by ZeroLux).
    #[serde(default)]
    pub worktree: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

/// Codex's own `approvalPolicy` values, as its app-server protocol names them.
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum CodexApprovalPolicy {
    Untrusted,
    OnRequest,
    Never,
}

/// Codex's own `sandbox` modes, as its app-server protocol names them.
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum CodexSandbox {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

// Internal input, populated from verified discovery rather than the HTTP body.
pub struct HireChatSession {
    /// A new agent's name; with neither a name nor `actor_id` the session has no agent.
    pub name: String,
    pub actor_id: Option<String>,
    pub harness: crate::harness::Harness,
    pub native_session_id: String,
    pub title: String,
    pub workspace: String,
    pub native_locator: serde_json::Value,
    /// True when the kernel relinks a session after a restart: its unread deliveries follow it.
    pub resume: bool,
}

// Deliberately not Serialize or Debug: only the adapter receives the token.
pub struct IssuedChatSession {
    pub actor: Option<Actor>,
    pub session: ChatSession,
    pub token: String,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChatSessionOrigin {
    #[default]
    Attached,
    Owned,
}

impl TryFrom<String> for ChatSessionOrigin {
    type Error = serde_json::Error;
    fn try_from(locator: String) -> std::result::Result<Self, Self::Error> {
        let locator: serde_json::Value = serde_json::from_str(&locator)?;
        Ok(
            if locator["kind"] == "claude-runner" || locator["kind"] == "pi-runner" {
                Self::Owned
            } else {
                Self::Attached
            },
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: String,
    /// The agent this session works for; none for a session of the owner's own.
    pub actor_id: Option<String>,
    pub harness: String,
    #[serde(default)]
    pub origin: ChatSessionOrigin,
    pub native_session_id: String,
    pub title: String,
    pub workspace: String,
    pub status: String,
    pub attention_reason: Option<String>,
    pub stopped_at: Option<i64>,
    /// "working" or "idle" as reported by the native harness; None when it is not known.
    pub activity: Option<String>,
    /// While working: the chat every input of the current turn belongs to, if there is one.
    pub activity_conversation_id: Option<String>,
    /// Messages stored for this session and not yet handed to its harness.
    pub waiting: i64,
    /// The kernel host whose native process this is; only that kernel links and relinks it.
    pub host_id: Option<String>,
    pub created_at: i64,
    pub pinned_at: Option<i64>,
    pub archived_at: Option<i64>,
    /// What the session may cost, in US dollars; at the limit its work stops.
    pub budget_usd: Option<f64>,
    /// How its native record ends, from this kernel host's watcher.
    #[serde(flatten)]
    pub tail: crate::native_events::Tail,
}

/// A `sessions` row with its `waiting` count; the locator is read only for its origin
/// and the token hash never leaves the database.
impl FromQueryResult for ChatSession {
    fn from_query_result(
        row: &sea_orm::QueryResult,
        pre: &str,
    ) -> std::result::Result<Self, sea_orm::DbErr> {
        let locator: String = row.try_get(pre, "native_locator_json")?;
        let origin = ChatSessionOrigin::try_from(locator)
            .map_err(|error| sea_orm::DbErr::Type(error.to_string()))?;
        Ok(Self {
            id: row.try_get(pre, "id")?,
            actor_id: row.try_get(pre, "actor_id")?,
            harness: row.try_get(pre, "harness")?,
            origin,
            native_session_id: row.try_get(pre, "native_session_id")?,
            title: row.try_get(pre, "title")?,
            workspace: row.try_get(pre, "workspace")?,
            status: row.try_get(pre, "status")?,
            attention_reason: row.try_get(pre, "attention_reason")?,
            stopped_at: row.try_get(pre, "stopped_at")?,
            activity: row.try_get(pre, "activity")?,
            activity_conversation_id: row.try_get(pre, "activity_conversation_id")?,
            waiting: row.try_get(pre, "waiting")?,
            host_id: row.try_get(pre, "host_id")?,
            created_at: row.try_get(pre, "created_at")?,
            pinned_at: row.try_get(pre, "pinned_at")?,
            archived_at: row.try_get(pre, "archived_at")?,
            budget_usd: row
                .try_get::<Option<i64>>(pre, "budget_cents")?
                .map(|cents| cents as f64 / 100.0),
            tail: Default::default(),
        })
    }
}

/// How the owner's input reaches a session that is working: into the running turn (steer),
/// after it (queue), or in place of it (interrupt). An idle session starts a turn with it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InputMode {
    #[default]
    Steer,
    Queue,
    Interrupt,
}

/// An image the owner sends with their input, base64-encoded.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputImage {
    /// `image/png`, `image/jpeg`, `image/gif` or `image/webp`.
    pub media_type: String,
    pub data: String,
}

/// A command or skill the session's harness offers, and what to type to use it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionCommand {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub argument_hint: Option<String>,
    /// What runs it at the start of the input: `/name` or, for a Codex skill, `$name`.
    pub invoke: String,
}

/// What the owner changes about a session; what is omitted stays.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionChange {
    pub title: Option<String>,
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
    /// What the session may cost, in US dollars; `0` takes the limit away.
    pub budget_usd: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatSessionStatus {
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationMemberInput {
    pub actor_id: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromQueryResult)]
pub struct ConversationMember {
    pub actor_id: String,
    pub name: String,
    pub kind: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateConversation {
    pub kind: String,
    pub title: String,
    pub members: Vec<ConversationMemberInput>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub paused: bool,
    pub members: Vec<ConversationMember>,
    pub last_seq: i64,
    /// A thread: the chat it hangs under and the message it is rooted at.
    pub parent_id: Option<String>,
    pub root_message_id: Option<String>,
    pub closed_at: Option<i64>,
    /// The newest message, for the list's preview and time; none in an empty chat.
    pub last_message: Option<LastMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromQueryResult)]
pub struct LastMessage {
    pub author_id: String,
    pub text: String,
    pub created_at: i64,
}

/// Opens a thread under a chat, or joins the open one rooted at the same message.
#[derive(Debug, Serialize, Deserialize)]
pub struct OpenThread {
    /// The root: a message of the parent chat, or one of its deliveries.
    pub root: String,
    pub title: String,
    /// Agents of the parent chat who take part, besides the caller.
    pub participants: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OpenedThread {
    pub conversation: Conversation,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendChatMessage {
    pub id: String,
    pub text: String,
    pub reply_to_delivery_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub conversation_id: String,
    pub seq: i64,
    pub author_id: String,
    pub text: String,
    pub reply_to_delivery_id: Option<String>,
    pub created_at: i64,
    pub deliveries: Vec<ChatDelivery>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MessagePage {
    pub messages: Vec<ChatMessage>,
    pub next_cursor: i64,
    pub has_more: bool,
}

pub struct SavedChatMessage {
    pub message: ChatMessage,
    pub created: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DeliveryDispatch {
    pub delivery: ChatDelivery,
    pub message: ChatMessage,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DeliveryReceipt {
    pub status: String,
    pub native_request_id: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InboxDelivery {
    pub id: String,
    pub message: ChatMessage,
    pub session_id: String,
    pub status: String,
    pub native_request_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatInbox {
    pub session: ChatSession,
    /// The workspace this inbox belongs to: an agent linked by several tells them apart.
    pub workspace: WorkspaceInfo,
    pub conversations: Vec<Conversation>,
    pub deliveries: Vec<InboxDelivery>,
    pub approvals: Vec<ChatApproval>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateChatApproval {
    pub id: String,
    /// The chat delivery whose turn asks; none for work no chat message started.
    #[serde(default)]
    pub delivery_id: Option<String>,
    pub native_request_id: String,
    /// "permission", "question" or "form"; see `requests`.
    #[serde(default = "permission")]
    pub kind: String,
    pub summary: String,
    pub details: serde_json::Value,
}

fn permission() -> String {
    "permission".into()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatApproval {
    pub id: String,
    pub actor_id: Option<String>,
    pub session_id: String,
    pub conversation_id: Option<String>,
    pub delivery_id: Option<String>,
    pub native_request_id: String,
    pub kind: String,
    pub summary: String,
    pub details: serde_json::Value,
    pub status: String,
    /// A permission's decision.
    pub decision: Option<String>,
    /// How far an allowed permission goes: "once", "session" or "always".
    pub scope: Option<String>,
    /// Why the owner denied it.
    pub reason: Option<String>,
    /// The owner's answer to a question or a form.
    pub answer: Option<serde_json::Value>,
    pub last_error: Option<String>,
    pub created_at: i64,
}

/// The owner's decision on a permission.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalDecision {
    /// "allow" or "deny".
    pub decision: String,
    /// For "allow": "once" (the default), "session" or "always", as the request offers.
    #[serde(default)]
    pub scope: Option<String>,
    /// For "deny": why, for the session.
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ApprovalReceipt {
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Debug)]
pub struct ChatEvent {
    pub event_id: String,
    pub payload: serde_json::Value,
    pub actor_ids: Vec<String>,
}
