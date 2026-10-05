use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::Arc,
};

use axum::{
    Extension, Json, Router,
    extract::{
        ConnectInfo, DefaultBodyLimit, FromRef, FromRequest, Path, Query, Request, State,
        rejection::QueryRejection,
    },
    http::{Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

use crate::{
    chat_runtime::ChatRuntime,
    model::*,
    store::{Error, Store},
};

/// An additional address served by the kernel.
pub struct Exposed {
    address: SocketAddr,
}

impl Exposed {
    pub fn new(address: SocketAddr) -> Arc<Self> {
        Arc::new(Self { address })
    }

    fn authority(&self) -> String {
        self.address.to_string()
    }
}

#[derive(Clone)]
struct AppState {
    store: Store,
    runtime: Option<Arc<ChatRuntime>>,
    exposed: Option<Arc<Exposed>>,
}

impl FromRef<AppState> for Store {
    fn from_ref(state: &AppState) -> Self {
        state.store.clone()
    }
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = match self {
            Self::Invalid(_) => StatusCode::BAD_REQUEST,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::Conflict | Self::OnboardingRequired | Self::StoppedByOwner => {
                StatusCode::CONFLICT
            }
            Self::Database(_) | Self::Migration(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let message = if status.is_server_error() {
            tracing::error!(error = %self, "API failure");
            "Internal storage error".to_owned()
        } else {
            self.to_string()
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

pub fn router(store: Store, web_dir: PathBuf) -> Router {
    app_router(
        AppState {
            store,
            runtime: None,
            exposed: None,
        },
        web_dir,
    )
}

pub fn router_with_runtime(store: Store, web_dir: PathBuf, runtime: Arc<ChatRuntime>) -> Router {
    router_exposed(store, web_dir, Some(runtime), None)
}

/// Serve it with connection info: without the peer address an exposed kernel refuses everything.
pub fn router_exposed(
    store: Store,
    web_dir: PathBuf,
    runtime: Option<Arc<ChatRuntime>>,
    exposed: Option<Arc<Exposed>>,
) -> Router {
    app_router(
        AppState {
            store,
            runtime,
            exposed,
        },
        web_dir,
    )
}

fn app_router(state: AppState, web_dir: PathBuf) -> Router {
    let legacy = Router::new()
        .route("/workspace", get(workspace))
        .route("/onboarding/owner", post(set_owner_name))
        .route("/actors", post(create_agent))
        .route("/connections", post(connect_agent))
        .route("/connections/{id}/heartbeat", post(connection_heartbeat))
        .route("/connections/{id}/disconnect", post(disconnect_agent))
        .route("/projects", post(create_project))
        .route("/tasks", post(create_task))
        .route("/tasks/{id}/actions", post(act))
        .route("/tasks/{id}/assignee", post(reassign_task))
        .route("/tasks/{id}/runs", get(runs))
        .route("/worker/claim", post(claim))
        .route("/worker/runs/{id}/heartbeat", post(heartbeat))
        .route("/worker/runs/{id}/finish", post(finish))
        .route_layer(middleware::from_fn(owner_only));
    let api = legacy
        .route("/health", get(|| async {
            Json(json!({ "name": "zerolux", "version": env!("CARGO_PKG_VERSION"), "capabilities": ["byoh-v1", "owner-onboarding-v1", "chat-v1"] }))
        }))
        .route("/sessions", get(discover_sessions))
        .route("/chat/hire", post(hire_session))
        .route("/chat/claude-sessions", post(create_claude_session))
        .route("/chat/sessions/{id}/resume", post(resume_claude_session))
        .route("/actors/{id}/name", post(rename_agent))
        .route("/chat/sessions", get(chat_sessions))
        .route("/chat/sessions/{id}/stop", post(stop_session))
        .route("/chat/sessions/{id}/status", post(session_status))
        .route("/chat/sessions/{id}/activity", post(session_activity))
        .route("/conversations", get(conversations).post(create_conversation))
        .route("/conversations/{id}/members", post(add_conversation_member))
        .route("/conversations/{id}/threads", post(open_thread))
        .route("/conversations/{id}/close", post(close_thread))
        .route("/conversations/{id}/pause", post(pause_conversation))
        .route("/conversations/{id}/messages", get(messages).post(send_message))
        .route("/livekit/token", get(livekit_token))
        .route("/chat/inbox", get(chat_inbox))
        .route("/chat/deliveries/{id}/dispatch", post(dispatch_delivery))
        .route("/chat/deliveries/{id}/receipt", post(delivery_receipt))
        .route("/chat/approvals", get(approvals).post(create_approval))
        .route("/chat/approvals/{id}/decision", post(decide_approval))
        .route("/chat/approvals/{id}/dispatch", post(dispatch_approval))
        .route("/chat/approvals/{id}/receipt", post(approval_receipt))
        .fallback(|| async {
            (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "Unknown API endpoint" })),
            )
        })
        .layer(middleware::from_fn_with_state(state.clone(), chat_access));
    Router::new()
        .nest("/api", api)
        // The web app owns its addresses: any page address gets the app, which shows the page.
        // The build writes `.br` and `.gz` next to each file; a client that accepts them gets
        // the smaller one, the original is always there for the others.
        .fallback_service(
            ServeDir::new(&web_dir)
                .precompressed_br()
                .precompressed_gzip()
                .fallback(
                    ServeFile::new(web_dir.join("index.html"))
                        .precompressed_br()
                        .precompressed_gzip(),
                ),
        )
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), access))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn chat_access(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    let headers = request.headers().get_all(axum::http::header::AUTHORIZATION);
    if headers.iter().count() > 1 {
        return Error::Unauthorized.into_response();
    }
    let token = match headers.iter().next() {
        None => None,
        Some(header) => {
            let Some((scheme, token)) =
                header.to_str().ok().and_then(|value| value.split_once(' '))
            else {
                return Error::Unauthorized.into_response();
            };
            if !scheme.eq_ignore_ascii_case("bearer")
                || token.is_empty()
                || token.chars().any(char::is_whitespace)
            {
                return Error::Unauthorized.into_response();
            }
            Some(token)
        }
    };
    let identity = match state.store.chat_identity(token).await {
        Ok(identity) => identity,
        Err(error) => return error.into_response(),
    };
    request.extensions_mut().insert(identity);
    let mutation = !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    );
    let response = next.run(request).await;
    if mutation
        && response.status().is_success()
        && let Some(runtime) = &state.runtime
    {
        runtime.changed();
    }
    response
}

async fn owner_only(
    Extension(who): Extension<ChatIdentity>,
    request: Request,
    next: Next,
) -> Response {
    if !who.is_owner() {
        return Error::Forbidden.into_response();
    }
    next.run(request).await
}

struct ChatJson<T>(T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for ChatJson<T> {
    type Rejection = Response;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|error| {
                let status = match error.status() {
                    StatusCode::UNPROCESSABLE_ENTITY => StatusCode::BAD_REQUEST,
                    status => status,
                };
                (status, Json(json!({ "error": error.body_text() }))).into_response()
            })
    }
}

struct ApiFailure(Box<Response>);

impl IntoResponse for ApiFailure {
    fn into_response(self) -> Response {
        *self.0
    }
}

impl From<Error> for ApiFailure {
    fn from(error: Error) -> Self {
        Self(Box::new(error.into_response()))
    }
}

fn runtime(state: &AppState) -> Result<Arc<ChatRuntime>, ApiFailure> {
    state.runtime.clone().ok_or_else(|| {
        ApiFailure(Box::new((StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": "Native session and LiveKit services are not running in this kernel" }))).into_response()))
    })
}

fn runtime_error(error: anyhow::Error) -> ApiFailure {
    ApiFailure(Box::new(match error.downcast::<Error>() {
        Ok(error) => error.into_response(),
        Err(error) => {
            tracing::error!(error = %error, "Chat runtime operation failed");
            (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": "The chat service could not complete this operation; check the session status and kernel diagnostics" }))).into_response()
        }
    }))
}

async fn discover_sessions(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
) -> Result<Json<Value>, ApiFailure> {
    if !who.is_owner() {
        return Err(Error::Forbidden.into());
    }
    Ok(Json(json!(
        runtime(&state)?.discover().await.map_err(runtime_error)?
    )))
}

#[derive(Deserialize)]
struct HireRequest {
    discovered_session_id: String,
    name: String,
    actor_id: Option<String>,
}

async fn hire_session(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    ChatJson(input): ChatJson<HireRequest>,
) -> Result<Json<Value>, ApiFailure> {
    if !who.is_owner() {
        return Err(Error::Forbidden.into());
    }
    let (actor, session) = runtime(&state)?
        .hire(
            &who,
            &input.discovered_session_id,
            &input.name,
            input.actor_id,
        )
        .await
        .map_err(runtime_error)?;
    Ok(Json(json!({ "actor": actor, "session": session })))
}

async fn create_claude_session(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    ChatJson(input): ChatJson<CreateClaudeSession>,
) -> Result<Json<Value>, ApiFailure> {
    if !who.is_owner() {
        return Err(Error::Forbidden.into());
    }
    #[cfg(unix)]
    {
        let (actor, session) = runtime(&state)?
            .create_claude(&who, input)
            .await
            .map_err(runtime_error)?;
        Ok(Json(json!({"actor":actor,"session":session})))
    }
    #[cfg(not(unix))]
    {
        let _ = (state, input);
        Err(
            Error::Invalid("Owned Claude sessions are not available on this platform".into())
                .into(),
        )
    }
}

async fn resume_claude_session(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    if !who.is_owner() {
        return Err(Error::Forbidden.into());
    }
    #[cfg(unix)]
    {
        let (actor, session) = runtime(&state)?
            .resume_claude(&who, &id)
            .await
            .map_err(runtime_error)?;
        Ok(Json(json!({"actor":actor,"session":session})))
    }
    #[cfg(not(unix))]
    {
        let _ = (state, id);
        Err(
            Error::Invalid("Owned Claude sessions are not available on this platform".into())
                .into(),
        )
    }
}

async fn chat_sessions(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "sessions": store.chat_sessions(&who).await? }),
    ))
}

async fn stop_session(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let (mut session, was_already_stopped) =
        state.store.stop_chat_session_with_state(&who, &id).await?;
    let note = if was_already_stopped {
        None
    } else if let Some(runtime) = &state.runtime {
        // The stop is stored before contacting the runner.
        runtime.changed();
        match runtime.stop_session(&id).await {
            Ok(note) => note,
            Err(error) => {
                state.store.note_chat_stop(&who, &id,
                    "The chat link is stopped and its token revoked. Native cancellation was not confirmed; work may still be running in the harness.")
                    .await?;
                runtime.changed();
                return Err(runtime_error(error));
            }
        }
    } else {
        Some(
            "The chat link is stopped and its token revoked. Native cancellation was not confirmed because this kernel had no active adapter.",
        )
    };
    let note = if session.harness == "claude-code" && session.origin != ChatSessionOrigin::Owned {
        Some(
            "The chat link is stopped and its token revoked. Claude Code may continue working in its terminal; native cancellation is not available.",
        )
    } else {
        note
    };
    if !was_already_stopped
        && session.attention_reason.is_none()
        && let Some(note) = note
    {
        session = state.store.note_chat_stop(&who, &id, note).await?;
        if let Some(runtime) = &state.runtime {
            runtime.changed();
        }
    }
    Ok(Json(json!({ "session": session })))
}

async fn session_status(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<ChatSessionStatus>,
) -> Result<Json<Value>, Error> {
    if who.session_id.as_deref() != Some(&id) {
        return Err(Error::Forbidden);
    }
    Ok(Json(
        json!({ "session": store.set_chat_session_status(&who, &id, input).await? }),
    ))
}

#[derive(Deserialize)]
struct ActivityRequest {
    activity: Option<String>,
    #[serde(default)]
    conversation_id: Option<String>,
}

async fn open_thread(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<OpenThread>,
) -> Result<Json<Value>, Error> {
    let opened = state.store.open_thread(&who, &id, input).await?;
    if let Some(runtime) = &state.runtime {
        runtime.changed();
    }
    Ok(Json(
        json!({ "conversation": opened.conversation, "created": opened.created }),
    ))
}

async fn close_thread(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let conversation = state.store.close_thread(&who, &id).await?;
    if let Some(runtime) = &state.runtime {
        runtime.changed();
    }
    Ok(Json(json!({ "conversation": conversation })))
}

async fn session_activity(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<ActivityRequest>,
) -> Result<Json<Value>, Error> {
    if who.session_id.as_deref() != Some(&id) {
        return Err(Error::Forbidden);
    }
    Ok(Json(
        json!({ "session": store.set_chat_session_activity(&who, &id, input.activity, input.conversation_id).await? }),
    ))
}

async fn conversations(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "conversations": store.conversations(&who).await? }),
    ))
}

async fn create_conversation(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    ChatJson(input): ChatJson<CreateConversation>,
) -> Result<impl IntoResponse, Error> {
    Ok((
        StatusCode::CREATED,
        Json(json!({ "conversation": store.create_conversation(&who, input).await? })),
    ))
}

#[derive(Deserialize)]
struct RenameRequest {
    name: String,
}

async fn rename_agent(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<RenameRequest>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "actor": store.rename_agent(&who, &id, &input.name).await? }),
    ))
}

async fn add_conversation_member(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<ConversationMemberInput>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "conversation": store.add_conversation_member(&who, &id, input).await? }),
    ))
}

#[derive(Deserialize)]
struct PauseRequest {
    paused: bool,
}

async fn pause_conversation(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<PauseRequest>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "conversation": store.pause_conversation(&who, &id, input.paused).await? }),
    ))
}

#[derive(Deserialize)]
struct MessageQuery {
    #[serde(default)]
    after: i64,
    #[serde(default = "message_limit")]
    limit: i64,
}
fn message_limit() -> i64 {
    100
}

async fn messages(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    query: Result<Query<MessageQuery>, QueryRejection>,
) -> Result<Json<MessagePage>, Error> {
    let Query(query) = query.map_err(|error| Error::Invalid(error.body_text()))?;
    Ok(Json(
        store
            .chat_messages(&who, &id, query.after, query.limit)
            .await?,
    ))
}

async fn send_message(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<SendChatMessage>,
) -> Result<impl IntoResponse, Error> {
    let saved = store.send_chat_message(&who, &id, input).await?;
    Ok((
        if saved.created {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(saved.message),
    ))
}

async fn livekit_token(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    request: Request,
) -> Result<Json<Value>, ApiFailure> {
    let mut ticket = runtime(&state)?
        .client_token(&who.actor_id)
        .map_err(runtime_error)?;
    // A device that reached the kernel at the exposed address reaches LiveKit there too.
    if let Some(exposed) = &state.exposed
        && peer(&request).is_some_and(|peer| !peer.is_loopback())
        && let Ok(mut url) = reqwest::Url::parse(&ticket.url)
        && url.host_str().is_some_and(|host| host == "127.0.0.1")
        && url.set_ip_host(exposed.address.ip()).is_ok()
    {
        ticket.url = url.to_string().trim_end_matches('/').to_owned();
    }
    Ok(Json(json!(ticket)))
}

async fn chat_inbox(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
) -> Result<Json<ChatInbox>, Error> {
    Ok(Json(store.chat_inbox(&who).await?))
}

async fn dispatch_delivery(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<DeliveryDispatch>, Error> {
    Ok(Json(store.dispatch_chat_delivery(&who, &id).await?))
}

async fn delivery_receipt(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<DeliveryReceipt>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "delivery": store.chat_delivery_receipt(&who, &id, input).await? }),
    ))
}

async fn approvals(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "approvals": store.chat_approvals(&who).await? }),
    ))
}

async fn create_approval(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    ChatJson(input): ChatJson<CreateChatApproval>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "approval": store.create_chat_approval(&who, input).await? }),
    ))
}

#[derive(Deserialize)]
struct ApprovalDecision {
    decision: String,
}

async fn decide_approval(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<ApprovalDecision>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "approval": store.decide_chat_approval(&who, &id, &input.decision).await? }),
    ))
}

async fn dispatch_approval(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "approval": store.dispatch_chat_approval(&who, &id).await? }),
    ))
}

async fn approval_receipt(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<ApprovalReceipt>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "approval": store.chat_approval_receipt(&who, &id, input).await? }),
    ))
}

fn refused(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn same_origin(request: &Request, host: Option<&str>) -> bool {
    request
        .headers()
        .get("origin")
        .map(|origin| {
            origin
                .to_str()
                .ok()
                .and_then(|v| v.parse::<axum::http::Uri>().ok())
                .is_some_and(|uri| {
                    uri.scheme_str() == Some("http") && uri.authority().map(|a| a.as_str()) == host
                })
        })
        .unwrap_or(true)
}

fn peer(request: &Request) -> Option<IpAddr> {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(address)| address.ip())
}

/// Match the request's Host and Origin to a served address.
async fn access(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let host = request.headers().get("host").and_then(|h| h.to_str().ok());
    let remote = match (&state.exposed, peer(&request)) {
        (None, _) => false,
        (Some(_), Some(peer)) => !peer.is_loopback(),
        (Some(_), None) => {
            return refused(
                StatusCode::FORBIDDEN,
                "The origin of this request is unknown",
            );
        }
    };
    if !remote {
        let local = host
            .and_then(|h| h.parse::<axum::http::uri::Authority>().ok())
            .is_some_and(|h| matches!(h.host(), "localhost" | "127.0.0.1" | "[::1]"));
        if !local || !same_origin(&request, host) {
            return refused(
                StatusCode::FORBIDDEN,
                "Only same-origin, loopback requests are allowed",
            );
        }
        return next.run(request).await;
    }
    let exposed = state.exposed.as_ref().expect("remote implies exposed");
    if host != Some(exposed.authority().as_str()) || !same_origin(&request, host) {
        return refused(
            StatusCode::FORBIDDEN,
            "Only same-origin requests to the exposed address are allowed",
        );
    }
    // Agents run next to the kernel: a credential of theirs never arrives from elsewhere.
    if request.headers().contains_key(header::AUTHORIZATION) {
        return refused(
            StatusCode::FORBIDDEN,
            "Agents connect from the kernel's computer",
        );
    }
    next.run(request).await
}

async fn workspace(State(store): State<Store>) -> Result<Json<Workspace>, Error> {
    Ok(Json(store.workspace().await?))
}
async fn set_owner_name(
    State(store): State<Store>,
    Json(input): Json<SetOwnerName>,
) -> Result<Json<Actor>, Error> {
    Ok(Json(store.set_owner_name(input).await?))
}
async fn reassign_task(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(input): Json<ReassignTask>,
) -> Result<Json<Task>, Error> {
    Ok(Json(store.reassign_task(&id, input).await?))
}
async fn create_agent(
    State(store): State<Store>,
    Json(input): Json<CreateAgent>,
) -> Result<impl IntoResponse, Error> {
    Ok((StatusCode::CREATED, Json(store.create_agent(input).await?)))
}
async fn connect_agent(
    State(store): State<Store>,
    Json(input): Json<ConnectAgent>,
) -> Result<impl IntoResponse, Error> {
    Ok((StatusCode::CREATED, Json(store.connect_agent(input).await?)))
}
async fn connection_heartbeat(
    State(store): State<Store>,
    Path(id): Path<String>,
) -> Result<StatusCode, Error> {
    store.connection_heartbeat(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn disconnect_agent(
    State(store): State<Store>,
    Path(id): Path<String>,
) -> Result<StatusCode, Error> {
    store.disconnect_agent(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn create_project(
    State(store): State<Store>,
    Json(input): Json<CreateProject>,
) -> Result<impl IntoResponse, Error> {
    Ok((
        StatusCode::CREATED,
        Json(store.create_project(input).await?),
    ))
}
async fn create_task(
    State(store): State<Store>,
    Json(input): Json<CreateTask>,
) -> Result<impl IntoResponse, Error> {
    Ok((StatusCode::CREATED, Json(store.create_task(input).await?)))
}
async fn act(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(input): Json<TaskAction>,
) -> Result<Json<Task>, Error> {
    Ok(Json(store.act(&id, input).await?))
}
async fn runs(State(store): State<Store>, Path(id): Path<String>) -> Result<Json<Vec<Run>>, Error> {
    Ok(Json(store.runs(&id).await?))
}
async fn claim(
    State(store): State<Store>,
    Json(input): Json<ClaimRequest>,
) -> Result<Json<Option<Claim>>, Error> {
    Ok(Json(store.claim(input).await?))
}
async fn heartbeat(
    State(store): State<Store>,
    Path(id): Path<String>,
) -> Result<StatusCode, Error> {
    store.heartbeat(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn finish(
    State(store): State<Store>,
    Path(id): Path<String>,
    Json(input): Json<FinishRun>,
) -> Result<Json<Run>, Error> {
    Ok(Json(store.finish(&id, input).await?))
}
