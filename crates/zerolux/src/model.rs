use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct Actor {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub owner_id: Option<String>,
    pub harness: Option<String>,
    pub archived: bool,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SetOwnerName {
    pub name: String,
}

/// The company this kernel runs. Its creation is day 1.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SetWorkspaceName {
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReassignTask {
    pub assignee_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateAgent {
    pub name: String,
    pub owner_id: String,
    pub harness: crate::harness::Harness,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct AgentConnection {
    pub id: String,
    pub actor_id: String,
    pub project_id: String,
    pub mode: String,
    pub workspace: String,
    pub session_id: Option<String>,
    pub connected_at: i64,
    pub lease_expires_at: i64,
    pub disconnected_at: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ConnectAgent {
    pub actor_id: String,
    pub project_id: String,
    pub mode: String,
    pub workspace: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct Task {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub assignee_id: String,
    pub status: String,
    pub review_note: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct Run {
    pub id: String,
    pub task_id: String,
    pub status: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub failure_reason: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub lease_expires_at: i64,
    pub connection_id: Option<String>,
    pub actor_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Workspace {
    pub workspace: WorkspaceInfo,
    pub actors: Vec<Actor>,
    pub projects: Vec<Project>,
    pub tasks: Vec<Task>,
    pub connections: Vec<AgentConnection>,
    pub onboarding_required: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateProject {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateTask {
    pub project_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub assignee_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Queue,
    Approve,
    RequestChanges,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TaskAction {
    pub action: Action,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClaimRequest {
    pub project_id: String,
    pub actor_id: String,
    #[serde(default)]
    pub connection_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Claim {
    pub task: Task,
    pub run: Run,
    pub project: Project,
    pub prompt: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FinishRun {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub failure_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ChatIdentity {
    pub actor_id: String,
    pub session_id: Option<String>,
}

impl ChatIdentity {
    pub fn is_owner(&self) -> bool {
        self.session_id.is_none()
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
    pub name: String,
    pub actor_id: Option<String>,
    pub workspace: String,
    #[serde(default)]
    pub permission_mode: ClaudePermissionMode,
}

/// A new Codex session, started by ZeroLux in a folder. What is omitted is decided by the
/// user's own Codex configuration: ZeroLux names no policy, sandbox or model of its own.
#[derive(Deserialize)]
pub struct CreateCodexSession {
    pub name: String,
    pub actor_id: Option<String>,
    pub workspace: String,
    #[serde(default)]
    pub approval_policy: Option<CodexApprovalPolicy>,
    #[serde(default)]
    pub sandbox: Option<CodexSandbox>,
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
    pub actor: Actor,
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
        Ok(if locator["kind"] == "claude-runner" {
            Self::Owned
        } else {
            Self::Attached
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ChatSession {
    pub id: String,
    pub actor_id: String,
    pub harness: String,
    #[serde(default)]
    #[sqlx(rename = "native_locator_json", try_from = "String")]
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

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
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

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
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

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ChatDelivery {
    pub id: String,
    pub message_id: String,
    pub actor_id: String,
    pub session_id: String,
    pub status: String,
    pub native_request_id: Option<String>,
    pub last_error: Option<String>,
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
    pub conversations: Vec<Conversation>,
    pub deliveries: Vec<InboxDelivery>,
    pub approvals: Vec<ChatApproval>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateChatApproval {
    pub id: String,
    pub delivery_id: String,
    pub native_request_id: String,
    pub summary: String,
    pub details: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatApproval {
    pub id: String,
    pub actor_id: String,
    pub session_id: String,
    pub conversation_id: String,
    pub delivery_id: String,
    pub native_request_id: String,
    pub summary: String,
    pub details: serde_json::Value,
    pub status: String,
    pub decision: Option<String>,
    pub last_error: Option<String>,
    pub created_at: i64,
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
