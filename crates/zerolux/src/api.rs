use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::Arc,
};

use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{
        ConnectInfo, DefaultBodyLimit, FromRef, FromRequest, Path, Query, Request, State,
        rejection::QueryRejection,
    },
    http::{HeaderMap, Method, StatusCode, header},
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
    auth::{AuthService, HumanSession},
    chat::Access,
    chat_runtime::ChatRuntime,
    codex::CodexStartFailure,
    model::*,
    store::{Error, Store},
};

/// An additional address served by the kernel.
pub struct Exposed {
    address: SocketAddr,
}

/// The public origin a reverse proxy serves this kernel at, e.g. `https://company.example`.
/// Requests arriving under that authority are public, whatever address they came from: same
/// rules as an exposed address, no agent credentials. Forwarded headers are never trusted.
pub struct PublicOrigin {
    origin: String,
    authority: String,
    /// The LiveKit address clients reach from the public origin, when the kernel runs its
    /// own LiveKit behind the proxy. An external LIVEKIT_URL stays authoritative.
    livekit_url: Option<String>,
}

impl PublicOrigin {
    pub fn new(origin: &str, livekit_url: Option<String>) -> anyhow::Result<Arc<Self>> {
        let uri: axum::http::Uri = origin
            .trim()
            .parse()
            .map_err(|_| anyhow::anyhow!("The public origin must be a URL like https://host"))?;
        let scheme = uri.scheme_str().unwrap_or_default();
        let authority = uri
            .authority()
            .ok_or_else(|| anyhow::anyhow!("The public origin must name a host"))?;
        anyhow::ensure!(
            matches!(scheme, "http" | "https")
                && uri.query().is_none()
                && matches!(uri.path(), "" | "/")
                && !authority.as_str().contains('@'),
            "The public origin must be scheme://host[:port], without path, query or credentials"
        );
        if let Some(url) = &livekit_url {
            let parsed = reqwest::Url::parse(url).map_err(|_| {
                anyhow::anyhow!("The public LiveKit URL must be a ws:// or wss:// URL")
            })?;
            anyhow::ensure!(
                matches!(parsed.scheme(), "ws" | "wss"),
                "The public LiveKit URL must be a ws:// or wss:// URL"
            );
        }
        let authority = authority.as_str().to_ascii_lowercase();
        Ok(Arc::new(Self {
            origin: format!("{scheme}://{authority}"),
            authority,
            livekit_url,
        }))
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    fn serves(&self, host: Option<&str>) -> bool {
        host.is_some_and(|h| h.eq_ignore_ascii_case(&self.authority))
    }
}

impl Exposed {
    pub fn new(address: SocketAddr) -> Arc<Self> {
        Arc::new(Self { address })
    }

    fn authority(&self) -> String {
        self.address.to_string()
    }
}

/// Human sign-in: the authentication service. Without it (tests, embedders) requests
/// without credentials are the local owner's, as before any account existed.
pub struct Auth {
    pub service: Arc<AuthService>,
}

/// Who a request is from, as the middleware established it.
#[derive(Clone)]
enum Identity {
    /// An agent's session, by its kernel-issued token; or the owner, with the sign-in
    /// behind them when there is an authentication service.
    Known(ChatIdentity, Option<HumanSession>),
    /// A signed-in account not bound to the owner: may ask who it is and claim, nothing else.
    Unbound(HumanSession),
    /// No credentials: the health endpoint and the sign-in endpoints only.
    Anonymous,
}

#[derive(Clone)]
struct AppState {
    store: Store,
    runtime: Option<Arc<ChatRuntime>>,
    exposed: Option<Arc<Exposed>>,
    public: Option<Arc<PublicOrigin>>,
    auth: Option<Arc<Auth>>,
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
            Self::Database(_) | Self::Schema(_) => StatusCode::INTERNAL_SERVER_ERROR,
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
            public: None,
            auth: None,
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
    router_public(store, web_dir, runtime, exposed, None, None)
}

/// Also serve a public origin, as a reverse proxy presents this kernel; with human sign-in
/// when `auth` is given.
pub fn router_public(
    store: Store,
    web_dir: PathBuf,
    runtime: Option<Arc<ChatRuntime>>,
    exposed: Option<Arc<Exposed>>,
    public: Option<Arc<PublicOrigin>>,
    auth: Option<Arc<Auth>>,
) -> Router {
    app_router(
        AppState {
            store,
            runtime,
            exposed,
            public,
            auth,
        },
        web_dir,
    )
}

fn app_router(state: AppState, web_dir: PathBuf) -> Router {
    let legacy = Router::new()
        .route("/workspace", get(workspace).post(set_workspace_name))
        .route("/onboarding/owner", post(set_owner_name))
        .route("/actors", post(create_agent))
        .route_layer(middleware::from_fn(owner_only));
    let domain = legacy
        .route("/sessions", get(list_sessions).post(create_session))
        .route("/sessions/discover", get(discover_sessions))
        .route("/sessions/search", get(search_sessions))
        .route("/sessions/attach", post(attach_session))
        .route("/sessions/catalog", get(settings_catalog))
        .route("/sessions/{id}", get(read_session).patch(change_session))
        .route(
            "/sessions/{id}/settings",
            get(read_session_settings).patch(change_session_settings),
        )
        .route("/sessions/{id}/resume", post(resume_session))
        .route("/sessions/{id}/fork", post(fork_session))
        .route(
            "/sessions/{id}/schedules",
            get(session_schedules).post(create_schedule),
        )
        .route("/schedules", get(all_schedules))
        .route(
            "/sessions/{id}/triggers",
            get(session_triggers).post(create_trigger),
        )
        .route(
            "/sessions/{id}/background-commands",
            get(session_background).post(start_background),
        )
        .route("/background-commands/{command}", get(read_background))
        .route("/background-commands/{command}/stop", post(stop_background))
        .route(
            "/triggers/{trigger}",
            axum::routing::patch(change_trigger).delete(delete_trigger),
        )
        .route(
            "/schedules/{schedule}",
            axum::routing::patch(change_schedule).delete(delete_schedule),
        )
        .route("/sessions/{id}/rewind-files", post(rewind_files))
        .route("/sessions/{id}/takeover", post(takeover_pi_session))
        .route("/sessions/{id}/stop", post(stop_session))
        .route("/sessions/{id}/output", get(session_output))
        .route("/sessions/{id}/live", get(session_live))
        .route("/sessions/{id}/events", get(session_events))
        .route("/sessions/{id}/subagents", get(session_subagents))
        .route(
            "/sessions/{id}/terminal-command",
            get(session_terminal_command),
        )
        .route(
            "/sessions/{id}/subagents/{agent}/events",
            get(subagent_events),
        )
        .route("/sessions/{id}/interrupt", post(interrupt_session))
        .route(
            "/sessions/{id}/input",
            // With images: 15 MiB of them, in base64.
            post(session_input).layer(DefaultBodyLimit::max(21 * 1024 * 1024)),
        )
        .route("/sessions/{id}/commands", get(session_commands))
        .route(
            "/sessions/{id}/queue/{item}",
            axum::routing::patch(requeue).delete(unqueue),
        )
        .route(
            "/sessions/{id}/goal",
            get(session_goal)
                .put(set_session_goal)
                .delete(clear_session_goal),
        )
        .route("/sessions/{id}/files", get(session_files))
        .route("/sessions/{id}/file", get(session_file))
        .route(
            "/sessions/{id}/terminals",
            get(session_terminals).post(open_terminal),
        )
        .route(
            "/terminals/{terminal}",
            get(terminal_output).delete(close_terminal),
        )
        .route("/terminals/{terminal}/input", post(terminal_input))
        .route("/terminals/{terminal}/resize", post(resize_terminal))
        .route("/sessions/{id}/git", get(session_git))
        .route("/sessions/{id}/git/diff", get(session_diff))
        .route("/sessions/{id}/git/stage", post(git_stage))
        .route("/sessions/{id}/git/unstage", post(git_unstage))
        .route("/sessions/{id}/git/discard", post(git_discard))
        .route("/sessions/{id}/git/commit", post(git_commit))
        .route("/sessions/{id}/git/push", post(git_push))
        .route(
            "/sessions/{id}/git/pr",
            get(git_pull_request).post(git_open_pull_request),
        )
        .route("/sessions/{id}/compact", post(compact_session))
        .route("/actors/{id}/name", post(rename_agent))
        .route(
            "/actors/{id}/settings",
            get(read_agent_settings).post(agent_settings),
        )
        .route("/chat/sessions/{id}/status", post(session_status))
        .route("/chat/sessions/{id}/activity", post(session_activity))
        .route("/chat/sessions/{id}/live", post(session_live_changes))
        .route(
            "/conversations",
            get(conversations).post(create_conversation),
        )
        .route("/conversations/{id}/members", post(add_conversation_member))
        .route("/conversations/{id}/threads", post(open_thread))
        .route("/conversations/{id}/close", post(close_thread))
        .route("/conversations/{id}/pause", post(pause_conversation))
        .route(
            "/conversations/{id}/messages",
            get(messages).post(send_message),
        )
        .route("/livekit/token", get(livekit_token))
        .route("/chat/inbox", get(chat_inbox))
        .route("/chat/deliveries/{id}/dispatch", post(dispatch_delivery))
        .route("/chat/deliveries/{id}/receipt", post(delivery_receipt))
        .route("/hosts", get(list_hosts))
        .route("/hosts/link", post(link_host))
        .route(
            "/hosts/{id}",
            axum::routing::patch(change_host).delete(remove_host),
        )
        .route("/hosts/{id}/accounts", get(host_accounts))
        .route(
            "/hosts/{id}/accounts/claude-code",
            axum::routing::put(set_claude_account),
        )
        .route(
            "/hosts/{id}/accounts/codex",
            post(set_codex_account).delete(clear_codex_account),
        )
        .route(
            "/hosts/{id}/accounts/pi",
            axum::routing::put(set_pi_account),
        )
        .route("/extensions", get(list_extensions))
        .route("/extensions/folder", post(install_extension_folder))
        .route("/extensions/available", get(available_extensions))
        .route(
            "/extensions/available/{id}",
            post(install_official_extension),
        )
        .route("/extensions/{id}", axum::routing::delete(remove_extension))
        .route("/extensions/{id}/enable", post(enable_extension))
        .route("/extensions/{id}/disable", post(disable_extension))
        .route(
            "/extensions/{id}/settings",
            axum::routing::patch(extension_settings),
        )
        .route("/actions", get(list_actions))
        .route(
            "/ext/{extension}/{action}",
            post(run_action).layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
        )
        .route("/invites", get(list_invites).post(create_invite))
        .route("/invites/{id}", axum::routing::delete(revoke_invite))
        .route("/chat/approvals", get(approvals).post(create_approval))
        .route("/chat/approvals/{id}/decision", post(decide_approval))
        .route("/chat/approvals/{id}/answer", post(answer_approval))
        .route("/chat/approvals/{id}/dispatch", post(dispatch_approval))
        .route("/chat/approvals/{id}/receipt", post(approval_receipt))
        .route_layer(middleware::from_fn(require_identity));
    // Reachable before one is signed in: what this kernel is, and how to sign in.
    let open = Router::new()
        .route("/health", get(health))
        .route("/auth/identity", get(auth_identity))
        .route("/auth/claim", post(auth_claim))
        .route("/auth/invites/{token}", get(invitation))
        .route("/hosts/join", post(join_host))
        .route("/hosts/channel", get(host_channel))
        .route("/auth/{*rest}", axum::routing::any(auth_proxy));
    let api = open
        .merge(domain)
        .fallback(|| async {
            (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "Unknown API endpoint" })),
            )
        })
        .layer(middleware::from_fn_with_state(state.clone(), identify))
        .layer(middleware::from_fn(no_store));
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
        .layer(middleware::from_fn(web_cache))
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), access))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// The web app's files with a hash in their names never change: a browser keeps them. Every
/// other address, the app's page first, is asked again, so a new build reaches it at once.
async fn web_cache(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let mut response = next.run(request).await;
    if path.starts_with("/api/") || !response.status().is_success() {
        return response;
    }
    let file = path.rsplit('/').next().unwrap_or_default();
    let hashed = file.split_once('.').is_some_and(|(stem, _)| {
        stem.rsplit_once('-').is_some_and(|(_, hash)| {
            hash.len() == 8
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
    });
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static(if hashed {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }),
    );
    response
}

/// Nothing of the API is cached by a browser or a device: discovery, identity and
/// revocation take effect on the next request.
async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

/// Who the request is from. A bearer token is an agent's (kernel-issued) or a signed-in
/// account's (signed by the authentication service); a cookie is an account's. Without the
/// authentication service, a request without credentials is the local owner's.
async fn identify(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
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
            Some(token.to_owned())
        }
    };
    let identity = match (&state.auth, token.as_deref()) {
        // A joined computer's secret: its channel checks it, and it is nobody else.
        (_, Some(token)) if token.starts_with(crate::host_link::SECRET_PREFIX) => {
            Identity::Anonymous
        }
        (None, token) => match state.store.chat_identity(token).await {
            Ok(identity) => Identity::Known(identity, None),
            Err(error) => return error.into_response(),
        },
        (Some(_), Some(token)) if is_agent_token(token) => {
            match state.store.chat_identity(Some(token)).await {
                Ok(identity) => Identity::Known(identity, None),
                Err(error) => return error.into_response(),
            }
        }
        (Some(auth), token) => {
            if token.is_none() && !request.headers().contains_key(header::COOKIE) {
                Identity::Anonymous
            } else {
                match auth
                    .service
                    .session(request.headers(), peer(&request))
                    .await
                {
                    Err(error) => {
                        tracing::error!(error = format!("{error:#}"), "Session check failed");
                        return refused(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "Sign-in is unavailable right now",
                        );
                    }
                    Ok(None) => Identity::Anonymous,
                    Ok(Some(session)) => {
                        match state.store.actor_for_subject(&session.subject).await {
                            Err(error) => return error.into_response(),
                            Ok(Some(actor)) => Identity::Known(
                                ChatIdentity {
                                    actor_id: Some(actor.id),
                                    session_id: None,
                                },
                                Some(session),
                            ),
                            Ok(None) => Identity::Unbound(session),
                        }
                    }
                }
            }
        }
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

/// An agent's token is 64 hex digits of the kernel's; a signed session token is not.
fn is_agent_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The domain: someone known. An account not bound to the owner is told so; no one is
/// told anything.
async fn require_identity(
    Extension(identity): Extension<Identity>,
    mut request: Request,
    next: Next,
) -> Response {
    match identity {
        Identity::Known(who, session) => {
            request.extensions_mut().insert(who);
            if let Some(session) = session {
                request.extensions_mut().insert(session);
            }
            next.run(request).await
        }
        Identity::Unbound(_) => refused(
            StatusCode::FORBIDDEN,
            "This account is not the workspace owner",
        ),
        Identity::Anonymous => Error::Unauthorized.into_response(),
    }
}

/// The native sessions already on this kernel's computer are its person's: only they find
/// and open them.
async fn host_person(state: &AppState, who: &ChatIdentity) -> Result<(), ApiFailure> {
    match state.store.host_use(who).await? {
        Some(crate::hosts::HostUse::Own) => Ok(()),
        _ => Err(failure(
            StatusCode::FORBIDDEN,
            "The sessions on this computer are its person's",
        )),
    }
}

/// New sessions on this kernel's computer: its person's, and those of the people it is open
/// to, who run them with their own harness accounts.
async fn host_open(state: &AppState, who: &ChatIdentity) -> Result<(), ApiFailure> {
    match state.store.host_use(who).await? {
        Some(_) => Ok(()),
        None => Err(failure(
            StatusCode::FORBIDDEN,
            "This computer is not open to you",
        )),
    }
}

async fn owner_only(
    Extension(who): Extension<ChatIdentity>,
    request: Request,
    next: Next,
) -> Response {
    if !who.is_person() {
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

/// What could not be done, said as it is.
fn said(error: anyhow::Error) -> ApiFailure {
    match error.downcast::<Error>() {
        Ok(error) => error.into(),
        Err(error) => Error::Invalid(format!("{error:#}")).into(),
    }
}

fn runtime_error(error: anyhow::Error) -> ApiFailure {
    ApiFailure(Box::new(match error.downcast::<Error>() {
        Ok(error) => error.into_response(),
        Err(error) => {
            tracing::error!(error = %error, "Chat runtime operation failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "The operation failed; check the session's status" })),
            )
                .into_response()
        }
    }))
}

async fn discover_sessions(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
) -> Result<Json<Value>, ApiFailure> {
    host_person(&state, &who).await?;
    if !who.is_person() {
        return Err(Error::Forbidden.into());
    }
    Ok(Json(json!(
        runtime(&state)?.discover().await.map_err(runtime_error)?
    )))
}

#[derive(Deserialize)]
struct AttachRequest {
    discovered_session_id: String,
    /// A new agent's name; with neither a name nor `actor_id` the session has no agent.
    #[serde(default)]
    name: String,
    actor_id: Option<String>,
}

async fn attach_session(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    ChatJson(input): ChatJson<AttachRequest>,
) -> Result<Json<Value>, ApiFailure> {
    host_person(&state, &who).await?;
    if !who.is_person() {
        return Err(Error::Forbidden.into());
    }
    let (actor, session) = runtime(&state)?
        .attach(
            &who,
            &input.discovered_session_id,
            &input.name,
            input.actor_id,
        )
        .await
        .map_err(runtime_error)?;
    Ok(Json(json!({ "actor": actor, "session": session })))
}

/// A new session of one of the harnesses, with or without an agent.
#[derive(Deserialize)]
#[serde(tag = "harness")]
enum NewSession {
    #[serde(rename = "claude-code")]
    Claude(CreateClaudeSession),
    #[serde(rename = "codex")]
    Codex(CreateCodexSession),
    #[serde(rename = "pi")]
    Pi(CreatePiSession),
}

/// A new session: the owner's, or one a session starts to delegate work to it, which the owner
/// owns and that session may follow and steer. A delegated session has no agent.
async fn create_session(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    ChatJson(mut input): ChatJson<NewSession>,
) -> Result<Json<Value>, ApiFailure> {
    let parent = who.session_id.clone();
    let acting = if let Some(parent) = &parent {
        match &mut input {
            NewSession::Claude(input) => (input.name.clear(), input.actor_id = None),
            NewSession::Codex(input) => (input.name.clear(), input.actor_id = None),
            NewSession::Pi(input) => (input.name.clear(), input.actor_id = None),
        };
        state.store.session_person(parent).await?
    } else {
        who
    };
    // On this kernel's computer, if it is open to them; on a joined computer, if it is theirs.
    let host = match &input {
        NewSession::Codex(input) => input.host.as_deref(),
        NewSession::Pi(input) => input.host.as_deref(),
        NewSession::Claude(input) => input.host.as_deref(),
    };
    let elsewhere = host.is_some_and(|host| Some(host) != state.store.host());
    if !elsewhere {
        host_open(&state, &acting).await?;
    }
    let created = match input {
        NewSession::Claude(input) => {
            create_claude_session(State(state.clone()), Extension(acting), input).await
        }
        NewSession::Codex(input) => {
            create_codex_session(State(state.clone()), Extension(acting), input).await
        }
        NewSession::Pi(input) => {
            create_pi_session(State(state.clone()), Extension(acting), input).await
        }
    }?;
    let Some(parent) = parent else {
        return Ok(created);
    };
    let child = created.0["session"]["id"]
        .as_str()
        .ok_or_else(|| runtime_error(anyhow::anyhow!("The new session has no ID")))?;
    let session = state.store.delegate(child, &parent).await?;
    if let Some(runtime) = &state.runtime {
        runtime.changed();
    }
    Ok(Json(json!({ "actor": null, "session": session })))
}

async fn create_codex_session(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    input: CreateCodexSession,
) -> Result<Json<Value>, ApiFailure> {
    if !who.is_person() {
        return Err(Error::Forbidden.into());
    }
    let runtime = runtime(&state)?;
    let created = match input.host.clone() {
        Some(host) if Some(host.as_str()) != state.store.host() => {
            runtime.create_codex_on(&who, input, &host).await
        }
        _ => runtime.create_codex(&who, input).await,
    };
    let (actor, session) = created.map_err(|error| {
        // What Codex did, or may have done, is the owner's to know: a thread it started
        // is named, an unanswered start is called uncertain. Nothing else is exposed.
        match error.downcast_ref::<CodexStartFailure>() {
            Some(failure) => {
                tracing::error!(
                    error = format!("{error:#}"),
                    "Codex session was not started"
                );
                let thread_id = match failure {
                    CodexStartFailure::Unlinked { thread_id } => Some(thread_id.as_str()),
                    CodexStartFailure::Uncertain => None,
                };
                ApiFailure(Box::new(
                    (
                        StatusCode::BAD_GATEWAY,
                        Json(json!({ "error": failure.to_string(), "thread_id": thread_id })),
                    )
                        .into_response(),
                ))
            }
            None => runtime_error(error),
        }
    })?;
    let mut session = session;
    state.store.mark_created(&mut session).await?;
    Ok(Json(json!({"actor":actor,"session":session})))
}

async fn create_pi_session(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    input: CreatePiSession,
) -> Result<Json<Value>, ApiFailure> {
    if !who.is_person() {
        return Err(Error::Forbidden.into());
    }
    {
        use crate::chat_runtime::PiStartFailure;
        let runtime = runtime(&state)?;
        let created = match input.host.clone() {
            Some(host) if Some(host.as_str()) != state.store.host() => {
                runtime.create_pi_on(&who, input, &host).await
            }
            _ => runtime.create_pi(&who, input).await,
        };
        let (actor, session) = created.map_err(|error| {
            if let Some(failure) = error.downcast_ref::<PiStartFailure>() {
                tracing::error!(
                    error = format!("{error:#}"),
                    "Pi session creation was not confirmed"
                );
                let id = match failure {
                    PiStartFailure::Unlinked { native_session_id } => {
                        Some(native_session_id.as_str())
                    }
                    PiStartFailure::Uncertain => None,
                };
                ApiFailure(Box::new(
                    (
                        StatusCode::BAD_GATEWAY,
                        Json(json!({"error":failure.to_string(),"native_session_id":id})),
                    )
                        .into_response(),
                ))
            } else {
                runtime_error(error)
            }
        })?;
        let mut session = session;
        state.store.mark_created(&mut session).await?;
        Ok(Json(json!({"actor":actor,"session":session})))
    }
}

async fn create_claude_session(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    input: CreateClaudeSession,
) -> Result<Json<Value>, ApiFailure> {
    if !who.is_person() {
        return Err(Error::Forbidden.into());
    }
    {
        let runtime = runtime(&state)?;
        let (actor, session) = match input.host.clone() {
            Some(host) if Some(host.as_str()) != state.store.host() => runtime
                .create_claude_on(&who, input, &host)
                .await
                .map_err(said)?,
            _ => runtime
                .create_claude(&who, input)
                .await
                .map_err(runtime_error)?,
        };
        let mut session = session;
        state.store.mark_created(&mut session).await?;
        Ok(Json(json!({"actor":actor,"session":session})))
    }
}

async fn takeover_pi_session(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Own).await?;
    if !who.is_person() {
        return Err(Error::Forbidden.into());
    }
    {
        let session = runtime(&state)?
            .takeover_pi(&who, &id)
            .await
            .map_err(runtime_error)?;
        Ok(Json(json!({"session": session})))
    }
}

async fn resume_session(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Write).await?;
    if !who.is_person() {
        return Err(Error::Forbidden.into());
    }
    let (actor, session) = runtime(&state)?
        .resume(&who, &id)
        .await
        .map_err(runtime_error)?;
    Ok(Json(json!({"actor":actor,"session":session})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ForkRequest {
    /// The offset, in the session's `/events`, of the input to fork before; none: all of it.
    #[serde(default)]
    at: Option<u64>,
    #[serde(default)]
    name: String,
    actor_id: Option<String>,
}

/// A new session that goes on from all of this one's history, or from before one of its
/// inputs, with the harness's own fork.
async fn fork_session(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<ForkRequest>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Own).await?;
    let (actor, session) = runtime(&state)?
        .fork(&who, &id, input.at, &input.name, input.actor_id)
        .await
        .map_err(runtime_error)?;
    let mut session = session;
    state.store.mark_created(&mut session).await?;
    Ok(Json(json!({ "actor": actor, "session": session })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RewindFiles {
    /// The offset, in the session's `/events`, of the input to go back to before.
    at: u64,
    #[serde(default)]
    dry_run: bool,
}

/// The files as they were before one of the session's inputs, from the harness's checkpoints.
async fn rewind_files(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<RewindFiles>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Write).await?;
    let result = runtime(&state)?
        .rewind_files(&who, &id, input.at, input.dry_run)
        .await
        .map_err(runtime_error)?;
    Ok(Json(json!({ "result": result })))
}

async fn all_schedules(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "schedules": store.schedules(&who, None).await? }),
    ))
}

async fn session_schedules(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "schedules": store.schedules(&who, Some(&id)).await? }),
    ))
}

/// Words the session receives on a schedule, as the owner's input.
async fn create_schedule(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<crate::schedules::NewSchedule>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "schedule": store.create_schedule(&who, &id, input).await? }),
    ))
}

async fn change_schedule(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(schedule): Path<String>,
    ChatJson(input): ChatJson<crate::schedules::ScheduleChange>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "schedule": store.change_schedule(&who, &schedule, input).await? }),
    ))
}

async fn delete_schedule(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(schedule): Path<String>,
) -> Result<Json<Value>, Error> {
    store.delete_schedule(&who, &schedule).await?;
    Ok(Json(json!({ "deleted": true })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewBackgroundCommand {
    command: String,
}

/// Runs a command in the background, in the session's folder; the session is told how it ends.
async fn start_background(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<NewBackgroundCommand>,
) -> Result<Json<Value>, ApiFailure> {
    let started = runtime(&state)?
        .start_background(&who, &id, &input.command)
        .await
        .map_err(said)?;
    Ok(Json(json!({ "background_command": started })))
}

async fn session_background(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let commands = runtime(&state)?
        .background_commands(&who, &id)
        .await
        .map_err(said)?;
    Ok(Json(json!({ "background_commands": commands })))
}

#[derive(Deserialize)]
struct OutputRead {
    #[serde(default)]
    after: u64,
}

/// A background command, and its output from `after`.
async fn read_background(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(command): Path<String>,
    Query(read): Query<OutputRead>,
) -> Result<Json<Value>, ApiFailure> {
    let (command, output) = runtime(&state)?
        .background_command(&who, &command, read.after)
        .await
        .map_err(said)?;
    Ok(Json(
        json!({ "background_command": command, "output": output }),
    ))
}

async fn stop_background(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(command): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let stopped = runtime(&state)?
        .stop_background(&who, &command)
        .await
        .map_err(said)?;
    Ok(Json(json!({ "background_command": stopped })))
}

async fn session_triggers(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "triggers": store.triggers(&who, &id).await? }),
    ))
}

async fn create_trigger(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<crate::triggers::NewTrigger>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "trigger": store.create_trigger(&who, &id, input).await? }),
    ))
}

async fn change_trigger(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(trigger): Path<String>,
    ChatJson(input): ChatJson<crate::triggers::TriggerChange>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "trigger": store.change_trigger(&who, &trigger, input).await? }),
    ))
}

async fn delete_trigger(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(trigger): Path<String>,
) -> Result<Json<Value>, Error> {
    store.delete_trigger(&who, &trigger).await?;
    Ok(Json(json!({ "deleted": true })))
}

async fn list_sessions(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
) -> Result<Json<Value>, Error> {
    let sessions = crate::native_output::with_tails(store.sessions(&who).await?);
    Ok(Json(json!({ "sessions": sessions })))
}

async fn read_session(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    if who.session_id.as_deref() != Some(&id) {
        store.acting_for(&who, &id, Access::Read).await?;
    }
    let session = crate::native_output::with_tails(store.sessions(&who).await?)
        .into_iter()
        .find(|session| session.id == id)
        .ok_or(Error::NotFound)?;
    Ok(Json(json!({ "session": session })))
}

async fn change_session(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<SessionChange>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Own).await?;
    let budget = input.budget_usd.is_some();
    let mut session = state.store.change_session(&who, &id, input).await?;
    if let Some(runtime) = &state.runtime {
        if budget {
            runtime
                .budget_changed(&who, &session)
                .await
                .map_err(runtime_error)?;
            session = state.store.chat_session(&who, &id).await?;
        }
        runtime.changed();
    }
    Ok(Json(json!({ "session": session })))
}

async fn read_session_settings(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Read).await?;
    if !who.is_person() {
        return Err(Error::Forbidden.into());
    }
    let settings = runtime(&state)?
        .session_settings(&who, &id)
        .await
        .map_err(runtime_error)?;
    Ok(Json(json!(settings)))
}

async fn change_session_settings(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<AgentSettings>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Write).await?;
    if !who.is_person() {
        return Err(Error::Forbidden.into());
    }
    let settings = runtime(&state)?
        .change_session_settings(&who, &id, input)
        .await
        .map_err(runtime_error)?;
    Ok(Json(json!(settings)))
}

async fn stop_session(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Write).await?;
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
                state
                    .store
                    .note_chat_stop(
                        &who,
                        &id,
                        "Stopped. Its harness did not confirm it stopped working.",
                    )
                    .await?;
                runtime.changed();
                return Err(runtime_error(error));
            }
        }
    } else {
        Some("Stopped. Its harness did not confirm it stopped working.")
    };
    let note = if session.harness == "claude-code" && session.origin != ChatSessionOrigin::Owned {
        Some("Stopped. Claude Code may go on in its terminal.")
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
#[serde(deny_unknown_fields)]
struct LiveChanges {
    changes: Vec<crate::live::Change>,
}

/// The integration's report of what its session is producing right now.
async fn session_live_changes(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<LiveChanges>,
) -> Result<Json<Value>, ApiFailure> {
    if who.session_id.as_deref() != Some(&id) {
        return Err(Error::Forbidden.into());
    }
    let seq = runtime(&state)?
        .live_changes(&id, input.changes)
        .await
        .map_err(runtime_error)?;
    Ok(Json(json!({ "seq": seq })))
}

/// What the session is producing right now, before its native record has it.
async fn session_live(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Read).await?;
    state.store.observed_session(&who, &id).await?;
    Ok(Json(json!(runtime(&state)?.live_state(&id))))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OutputQuery {
    #[serde(default)]
    after: u64,
}

/// The agent's native session record, as the harness wrote it.
async fn session_output(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    query: Result<Query<OutputQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Read).await?;
    let Query(query) = query.map_err(|error| Error::Invalid(error.body_text()))?;
    on_record(&state, &who, &id, "output", json!({ "after": query.after })).await
}

/// What a session's native record says, read where it is: on this kernel's host, or on the
/// joined computer the session runs on.
async fn on_record(
    state: &AppState,
    who: &ChatIdentity,
    id: &str,
    op: &str,
    params: Value,
) -> Result<Json<Value>, ApiFailure> {
    let row = state.store.observed_session(who, id).await?;
    let record = crate::host_ops::RecordRef::of(&row);
    let result = match row.host_id.as_deref() {
        host if host == state.store.host() => crate::host_ops::record(op, &record, &params).await,
        Some(host) => {
            runtime(state)?
                .hosts
                .call(
                    host,
                    "record",
                    json!({"op": op, "record": record, "params": params}),
                )
                .await
        }
        None => Err(Error::NotFound.into()),
    };
    Ok(Json(result.map_err(said)?))
}

/// What a session's folder holds, read or done where it is.
async fn on_folder(
    state: &AppState,
    who: &ChatIdentity,
    id: &str,
    op: &str,
    params: Value,
) -> Result<Json<Value>, ApiFailure> {
    let session = state.store.chat_session(who, id).await?;
    let folder = std::path::Path::new(&session.workspace);
    let result = match session.host_id.as_deref() {
        host if host == state.store.host() => crate::host_ops::folder(op, folder, &params).await,
        Some(host) => {
            runtime(state)?
                .hosts
                .call(
                    host,
                    "folder",
                    json!({"op": op, "folder": session.workspace, "params": params}),
                )
                .await
        }
        None => Err(Error::NotFound.into()),
    };
    Ok(Json(result.map_err(said)?))
}

/// The agent's native record in the Agent Console's common model.
async fn session_events(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    query: Result<Query<crate::native_output::EventQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Read).await?;
    let Query(query) = query.map_err(|error| Error::Invalid(error.body_text()))?;
    on_record(&state, &who, &id, "events", json!({ "query": query })).await
}

/// Stops the native turn in progress; the session stays linked.
async fn interrupt_session(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Write).await?;
    let interrupted = runtime(&state)?
        .interrupt(&who, &id)
        .await
        .map_err(runtime_error)?;
    Ok(Json(json!({ "interrupted": interrupted })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompactRequest {
    /// What the summary should keep, as `/compact <instructions>`.
    instructions: Option<String>,
}

/// Starts the harness's own compaction of the session's history; the record shows the result.
async fn compact_session(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(request): ChatJson<CompactRequest>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Write).await?;
    runtime(&state)?
        .compact(&who, &id, request.instructions.as_deref())
        .await
        .map_err(runtime_error)?;
    Ok(Json(json!({ "started": true })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InputRequest {
    #[serde(default)]
    text: String,
    #[serde(default)]
    mode: InputMode,
    #[serde(default)]
    images: Vec<InputImage>,
}

/// The owner's own input, straight into the native session; not a chat message.
async fn session_input(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<InputRequest>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Write).await?;
    runtime(&state)?
        .input(&who, &id, &input.text, input.mode, &input.images)
        .await
        .map_err(runtime_error)?;
    Ok(Json(json!({ "sent": true })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FilesQuery {
    #[serde(default)]
    query: String,
    #[serde(default = "files_limit")]
    limit: usize,
}

fn files_limit() -> usize {
    50
}

/// The folder of a session that runs on this kernel host, for the owner.
async fn session_folder(
    state: &AppState,
    who: &ChatIdentity,
    id: &str,
) -> Result<std::path::PathBuf, ApiFailure> {
    let session = state.store.chat_session(who, id).await?;
    if session.host_id.as_deref() != state.store.host() {
        return Err(Error::Invalid(
            "This session runs on another kernel host; read its folder there".into(),
        )
        .into());
    }
    Ok(std::path::PathBuf::from(session.workspace))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PathQuery {
    path: String,
}

/// A file of the session's folder, as it is now.
async fn session_file(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    Query(input): Query<PathQuery>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Read).await?;
    on_folder(&state, &who, &id, "file", json!({ "path": input.path })).await
}

/// What git says has changed in the session's folder.
async fn session_git(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Read).await?;
    on_folder(&state, &who, &id, "git", json!({})).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiffQuery {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    staged: bool,
}

/// The changes in the session's folder, for a path or all of them, as a unified diff.
async fn session_diff(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    Query(input): Query<DiffQuery>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Read).await?;
    on_folder(
        &state,
        &who,
        &id,
        "diff",
        json!({ "path": input.path, "staged": input.staged }),
    )
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TerminalSize {
    cols: u16,
    rows: u16,
}

async fn session_terminals(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Read).await?;
    let session = state.store.chat_session(&who, &id).await?;
    let runtime = runtime(&state)?;
    // On a joined computer: its terminals there, remembered here by ID.
    if let Some(host) = remote(&state, &session) {
        let terminals = runtime
            .hosts
            .call(&host, "terminal.list", json!({ "session_id": id }))
            .await
            .map_err(said)?;
        let mut known = runtime.remote_terminals.lock().expect("terminals");
        for terminal in terminals.as_array().into_iter().flatten() {
            if let Some(terminal) = terminal["id"].as_str() {
                known.insert(terminal.to_owned(), (host.clone(), id.clone()));
            }
        }
        return Ok(Json(json!({ "terminals": terminals })));
    }
    session_folder(&state, &who, &id).await?;
    Ok(Json(json!({ "terminals": runtime.terminals.of(&id) })))
}

/// The joined computer a session runs on, if it is not this kernel's.
fn remote(state: &AppState, session: &ChatSession) -> Option<String> {
    session
        .host_id
        .clone()
        .filter(|host| Some(host.as_str()) != state.store.host())
}

/// A terminal on a joined computer that `who` may use as `need` asks: its computer.
async fn remote_terminal(
    state: &AppState,
    who: &ChatIdentity,
    terminal: &str,
    need: Access,
) -> Result<Option<String>, ApiFailure> {
    let runtime = runtime(state)?;
    let known = runtime
        .remote_terminals
        .lock()
        .expect("terminals")
        .get(terminal)
        .cloned();
    let Some((host, session)) = known else {
        return Ok(None);
    };
    state.store.acting_for(who, &session, need).await?;
    Ok(Some(host))
}

/// A shell in the session's folder, on the kernel host.
async fn open_terminal(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(size): ChatJson<TerminalSize>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Write).await?;
    let session = state.store.chat_session(&who, &id).await?;
    if let Some(host) = remote(&state, &session) {
        let runtime = runtime(&state)?;
        let terminal = runtime
            .hosts
            .call(
                &host,
                "terminal.open",
                json!({"session_id": id, "folder": session.workspace,
                    "cols": size.cols, "rows": size.rows}),
            )
            .await
            .map_err(said)?;
        if let Some(terminal) = terminal["id"].as_str() {
            runtime
                .remote_terminals
                .lock()
                .expect("terminals")
                .insert(terminal.to_owned(), (host, id.clone()));
        }
        return Ok(Json(json!({ "terminal": terminal })));
    }
    let folder = session_folder(&state, &who, &id).await?;
    let terminal = runtime(&state)?
        .terminals
        .open(&id, &folder.to_string_lossy(), size.cols, size.rows)
        .map_err(runtime_error)?;
    Ok(Json(json!({ "terminal": terminal })))
}

/// The terminal of a session the owner may see.
/// A terminal of a session `who` may read, or for `Write` also type into, resize and close.
async fn owned_terminal(
    state: &AppState,
    who: &ChatIdentity,
    terminal: &str,
    need: Access,
) -> Result<crate::terminals::Info, ApiFailure> {
    let info = runtime(state)?.terminals.info(terminal)?;
    state.store.acting_for(who, &info.session_id, need).await?;
    Ok(info)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TerminalRead {
    #[serde(default)]
    after: u64,
}

/// The terminal's output after an offset, base64-encoded; `next` is where to read on.
async fn terminal_output(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(terminal): Path<String>,
    Query(input): Query<TerminalRead>,
) -> Result<Json<Value>, ApiFailure> {
    if let Some(host) = remote_terminal(&state, &who, &terminal, Access::Read).await? {
        let read = runtime(&state)?
            .hosts
            .call(
                &host,
                "terminal.output",
                json!({"id": terminal, "after": input.after}),
            )
            .await
            .map_err(said)?;
        return Ok(Json(read));
    }
    let info = owned_terminal(&state, &who, &terminal, Access::Read).await?;
    let output = runtime(&state)?.terminals.output(&terminal, input.after)?;
    Ok(Json(json!({ "terminal": info, "output": output })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TerminalInput {
    data: String,
}

/// What the owner types, as the terminal receives it.
async fn terminal_input(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(terminal): Path<String>,
    ChatJson(input): ChatJson<TerminalInput>,
) -> Result<Json<Value>, ApiFailure> {
    if let Some(host) = remote_terminal(&state, &who, &terminal, Access::Write).await? {
        runtime(&state)?
            .hosts
            .call(
                &host,
                "terminal.input",
                json!({"id": terminal, "data": input.data}),
            )
            .await
            .map_err(said)?;
        return Ok(Json(json!({ "sent": true })));
    }
    owned_terminal(&state, &who, &terminal, Access::Write).await?;
    runtime(&state)?
        .terminals
        .write(&terminal, &input.data)
        .map_err(runtime_error)?;
    Ok(Json(json!({ "sent": true })))
}

async fn resize_terminal(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(terminal): Path<String>,
    ChatJson(size): ChatJson<TerminalSize>,
) -> Result<Json<Value>, ApiFailure> {
    if let Some(host) = remote_terminal(&state, &who, &terminal, Access::Write).await? {
        let info = runtime(&state)?
            .hosts
            .call(
                &host,
                "terminal.resize",
                json!({"id": terminal, "cols": size.cols, "rows": size.rows}),
            )
            .await
            .map_err(said)?;
        return Ok(Json(json!({ "terminal": info })));
    }
    owned_terminal(&state, &who, &terminal, Access::Write).await?;
    let info = runtime(&state)?
        .terminals
        .resize(&terminal, size.cols, size.rows)
        .map_err(runtime_error)?;
    Ok(Json(json!({ "terminal": info })))
}

/// Ends the terminal's shell, if it still runs, and closes it.
async fn close_terminal(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(terminal): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    if let Some(host) = remote_terminal(&state, &who, &terminal, Access::Write).await? {
        let runtime = runtime(&state)?;
        runtime
            .hosts
            .call(&host, "terminal.close", json!({ "id": terminal }))
            .await
            .map_err(said)?;
        runtime
            .remote_terminals
            .lock()
            .expect("terminals")
            .remove(&terminal);
        return Ok(Json(json!({ "closed": true })));
    }
    owned_terminal(&state, &who, &terminal, Access::Write).await?;
    runtime(&state)?.terminals.close(&terminal)?;
    Ok(Json(json!({ "closed": true })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GitPaths {
    paths: Vec<String>,
}

async fn git_stage(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<GitPaths>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Write).await?;
    on_folder(&state, &who, &id, "stage", json!({ "paths": input.paths })).await
}

async fn git_unstage(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<GitPaths>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Write).await?;
    on_folder(
        &state,
        &who,
        &id,
        "unstage",
        json!({ "paths": input.paths }),
    )
    .await
}

/// Throws away the paths' changes that are not staged.
async fn git_discard(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<GitPaths>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Write).await?;
    on_folder(
        &state,
        &who,
        &id,
        "discard",
        json!({ "paths": input.paths }),
    )
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GitCommit {
    message: String,
}

async fn git_commit(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<GitCommit>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Write).await?;
    on_folder(
        &state,
        &who,
        &id,
        "commit",
        json!({ "message": input.message }),
    )
    .await
}

async fn git_push(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Write).await?;
    on_folder(&state, &who, &id, "push", json!({})).await
}

/// The branch's pull request with its checks, through GitHub's `gh`; null when there is none.
async fn git_pull_request(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Read).await?;
    on_folder(&state, &who, &id, "pr", json!({})).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenPullRequest {
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    draft: bool,
}

async fn git_open_pull_request(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<OpenPullRequest>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Write).await?;
    on_folder(
        &state,
        &who,
        &id,
        "open_pr",
        json!({ "title": input.title, "body": input.body, "draft": input.draft }),
    )
    .await
}

/// Files of the session's folder matching what the owner is typing, to mention them.
async fn session_files(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    Query(input): Query<FilesQuery>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Read).await?;
    on_folder(
        &state,
        &who,
        &id,
        "files",
        json!({ "query": input.query, "limit": input.limit }),
    )
    .await
}

/// The command that opens the session in its harness's own terminal, in its folder, on the
/// computer it runs on: to go on there. A session ZeroLux runs is stopped here first.
async fn session_terminal_command(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Own).await?;
    let session = state.store.chat_session(&who, &id).await?;
    let locator = state.store.chat_session_locator(&who, &id).await?;
    if crate::homes::Homes::of_locator(&locator).is_guest() {
        return Err(Error::Invalid(
            "This session runs on another person's computer; continue it in ZeroLux".into(),
        )
        .into());
    }
    let quoted = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    let command = match session.harness.as_str() {
        "claude-code" => format!("claude --resume {}", quoted(&session.native_session_id)),
        "codex" => format!("codex resume {}", quoted(&session.native_session_id)),
        _ => match locator["session_file"].as_str() {
            Some(file) => format!("pi --session {}", quoted(file)),
            None => format!("pi --session {}", quoted(&session.native_session_id)),
        },
    };
    Ok(Json(json!({
        "command": format!("cd {} && {command}", quoted(&session.workspace)),
        "host_id": session.host_id,
        // Two processes never run one native session: it is stopped in ZeroLux first.
        "stop_first": session.stopped_at.is_none(),
    })))
}

/// The subagents the session's harness started, newest first.
async fn session_subagents(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Read).await?;
    on_record(&state, &who, &id, "subagents", json!({})).await
}

/// A subagent's events, paged like the session's own.
async fn subagent_events(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path((id, agent)): Path<(String, String)>,
    query: Result<Query<crate::native_output::EventQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiFailure> {
    let Query(query) = query.map_err(|error| Error::Invalid(error.body_text()))?;
    let who = state.store.acting_for(&who, &id, Access::Read).await?;
    on_record(
        &state,
        &who,
        &id,
        "subagent_events",
        json!({ "agent": agent, "query": query }),
    )
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchQuery {
    q: String,
    #[serde(default = "search_limit")]
    limit: usize,
}

fn search_limit() -> usize {
    50
}

/// What the sessions one may read said and did, newest first: their words, reasoning and
/// tool calls that contain the text looked for.
async fn search_sessions(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    query: Result<Query<SearchQuery>, QueryRejection>,
) -> Result<Json<crate::history::Results>, Error> {
    let Query(query) = query.map_err(|error| Error::Invalid(error.body_text()))?;
    let mut found = state
        .store
        .search_sessions(&who, &query.q, query.limit)
        .await?;
    // The sessions on joined computers, searched there; one offline is left out.
    if let Some(runtime) = &state.runtime {
        for session in state.store.sessions(&who).await? {
            let Some(host) = remote(&state, &session) else {
                continue;
            };
            let row = state.store.observed_session(&who, &session.id).await?;
            let Ok(answer) = runtime
                .hosts
                .call(
                    &host,
                    "record",
                    json!({"op": "search", "record": crate::host_ops::RecordRef::of(&row),
                        "params": {"query": query.q}}),
                )
                .await
            else {
                found.truncated = true;
                continue;
            };
            found.truncated |= answer["truncated"] == true;
            for hit in answer["found"].as_array().into_iter().flatten() {
                found.results.push(crate::history::Found {
                    session_id: session.id.clone(),
                    title: session.title.clone(),
                    harness: session.harness.clone(),
                    at: hit["at"].as_u64().unwrap_or_default(),
                    time: hit["time"].as_str().map(str::to_owned),
                    kind: hit["kind"].as_str().unwrap_or_default().to_owned(),
                    snippet: hit["snippet"].as_str().unwrap_or_default().to_owned(),
                });
            }
        }
        found.results.sort_by(|a, b| b.time.cmp(&a.time));
        found.results.truncate(query.limit.clamp(1, 200));
    }
    Ok(Json(found))
}

/// The goal the session works toward on its own, as its harness keeps it.
async fn session_goal(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Read).await?;
    let goal = runtime(&state)?
        .goal(&who, &id, None, false)
        .await
        .map_err(runtime_error)?;
    Ok(Json(json!({ "goal": goal })))
}

async fn set_session_goal(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(change): ChatJson<GoalChange>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Write).await?;
    let goal = runtime(&state)?
        .goal(&who, &id, Some(change), false)
        .await
        .map_err(runtime_error)?;
    Ok(Json(json!({ "goal": goal })))
}

async fn clear_session_goal(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Write).await?;
    runtime(&state)?
        .goal(&who, &id, None, true)
        .await
        .map_err(runtime_error)?;
    Ok(Json(json!({ "goal": null })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueuedChange {
    text: String,
}

/// Rewrites one of the owner's inputs waiting in the session's queue.
async fn requeue(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path((id, item)): Path<(String, String)>,
    ChatJson(input): ChatJson<QueuedChange>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Write).await?;
    runtime(&state)?
        .change_queued(&who, &id, &item, Some(&input.text))
        .await
        .map_err(runtime_error)?;
    Ok(Json(json!({ "changed": true })))
}

/// Takes one of the owner's inputs out of the session's queue.
async fn unqueue(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path((id, item)): Path<(String, String)>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Write).await?;
    runtime(&state)?
        .change_queued(&who, &id, &item, None)
        .await
        .map_err(runtime_error)?;
    Ok(Json(json!({ "removed": true })))
}

/// The commands and skills the session's harness offers.
async fn session_commands(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let who = state.store.acting_for(&who, &id, Access::Read).await?;
    let commands = runtime(&state)?
        .commands(&who, &id)
        .await
        .map_err(runtime_error)?;
    Ok(Json(json!({ "commands": commands })))
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

async fn agent_settings(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<Value>,
) -> Result<Json<Value>, ApiFailure> {
    if !who.is_person() {
        return Err(Error::Forbidden.into());
    }
    Ok(Json(
        json!({ "actor": runtime(&state)?.change_agent_settings(&who, &id, crate::agent_settings::patch(input)?).await.map_err(runtime_error)? }),
    ))
}

async fn read_agent_settings(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    if !who.is_person() {
        return Err(Error::Forbidden.into());
    }
    Ok(Json(json!(
        runtime(&state)?
            .agent_settings(&who, &id)
            .await
            .map_err(runtime_error)?
    )))
}

#[derive(Deserialize)]
struct CatalogQuery {
    harness: crate::harness::Harness,
}

async fn settings_catalog(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Query(input): Query<CatalogQuery>,
) -> Result<Json<Value>, ApiFailure> {
    if !who.is_person() {
        return Err(Error::Forbidden.into());
    }
    Ok(Json(
        json!({ "models": runtime(&state)?.settings_catalog(&who, input.harness.id()).await.map_err(runtime_error)? }),
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
    session: Option<Extension<HumanSession>>,
    request: Request,
) -> Result<Json<Value>, ApiFailure> {
    let runtime = runtime(&state)?;
    // A person's token ends with their sign-in; an agent's lasts its working day.
    let mut ticket = match session {
        Some(Extension(session)) => runtime.human_token(who.addressee(), session.expires_at),
        None => runtime.client_token(who.addressee()),
    }
    .map_err(runtime_error)?;
    let host = request.headers().get("host").and_then(|h| h.to_str().ok());
    if let Some(public) = state.public.as_ref().filter(|p| p.serves(host)) {
        // Behind the proxy, the kernel's own LiveKit is reachable only where the operator
        // says; an external server's URL is already the one clients use.
        if ticket.managed {
            match &public.livekit_url {
                Some(url) => ticket.url = url.clone(),
                None => {
                    return Err(ApiFailure(Box::new(refused(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Realtime is not configured for the public origin: set the public LiveKit URL",
                    ))));
                }
            }
        }
        return Ok(Json(json!(ticket)));
    }
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

async fn decide_approval(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(input): ChatJson<ApprovalDecision>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "approval": store.decide_chat_approval(&who, &id, input).await? }),
    ))
}

/// The owner's answer to a question or a form, checked against what was asked.
async fn answer_approval(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(answer): ChatJson<Value>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "approval": store.answer_chat_approval(&who, &id, answer).await? }),
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

/// The origins of the packaged desktop app, as Tauri 2 presents them: its pages call the
/// kernel's API from here. Accepted wherever a same-origin request would be, as the same
/// class of request (local, exposed or public): the desktop never gains a privilege by it.
const DESKTOP_ORIGINS: [&str; 2] = ["tauri://localhost", "http://tauri.localhost"];

fn desktop_origin(request: &Request) -> Option<&'static str> {
    let origin = request.headers().get("origin")?.to_str().ok()?;
    DESKTOP_ORIGINS
        .into_iter()
        .find(|known| known.eq_ignore_ascii_case(origin))
}

/// CORS for the desktop app only: the exact origin, no credentials, no wildcard.
fn with_desktop_cors(mut response: Response, origin: &str) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        header::HeaderValue::from_str(origin).expect("known origin"),
    );
    headers.insert(header::VARY, header::HeaderValue::from_static("Origin"));
    // The signed session token of a sign-in, for the app to keep.
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        header::HeaderValue::from_static("set-auth-token"),
    );
    response
}

fn desktop_preflight(origin: &str) -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        header::HeaderValue::from_static("GET, POST"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        header::HeaderValue::from_static("content-type, authorization, x-zerolux-invite"),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        header::HeaderValue::from_static("600"),
    );
    with_desktop_cors(response, origin)
}

/// The Origin header, when present, must be exactly the configured public origin.
fn same_origin_as(request: &Request, origin: &str) -> bool {
    request
        .headers()
        .get("origin")
        .map(|value| {
            value
                .to_str()
                .is_ok_and(|v| v.trim_end_matches('/').eq_ignore_ascii_case(origin))
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
    // The desktop app's pages are cross-origin to every kernel they talk to: answer the
    // browser's preflight, then let the request through the same checks as any other, with
    // its Origin accepted, and tag the response for the browser.
    let desktop = desktop_origin(&request);
    if let Some(origin) = desktop
        && request.method() == axum::http::Method::OPTIONS
        && request
            .headers()
            .contains_key(header::ACCESS_CONTROL_REQUEST_METHOD)
    {
        return desktop_preflight(origin);
    }
    let response = classify(state, request, next).await;
    match desktop {
        Some(origin) => with_desktop_cors(response, origin),
        None => response,
    }
}

async fn classify(state: AppState, request: Request, next: Next) -> Response {
    let desktop = desktop_origin(&request).is_some();
    let host = request.headers().get("host").and_then(|h| h.to_str().ok());
    // Public by authority, even when the proxy connects from loopback: never a local privilege.
    if let Some(public) = state.public.as_ref().filter(|p| p.serves(host)) {
        if !desktop && !same_origin_as(&request, &public.origin) {
            return refused(
                StatusCode::FORBIDDEN,
                "Only same-origin requests to the public origin are allowed",
            );
        }
        if carries_agent_token(&request) {
            return refused(
                StatusCode::FORBIDDEN,
                "Agents connect from the kernel's computer",
            );
        }
        return next.run(request).await;
    }
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
        if !local || !(desktop || same_origin(&request, host)) {
            return refused(
                StatusCode::FORBIDDEN,
                "Only same-origin, loopback requests are allowed",
            );
        }
        return next.run(request).await;
    }
    let exposed = state.exposed.as_ref().expect("remote implies exposed");
    if host != Some(exposed.authority().as_str()) || !(desktop || same_origin(&request, host)) {
        return refused(
            StatusCode::FORBIDDEN,
            "Only same-origin requests to the exposed address are allowed",
        );
    }
    // Agents run next to the kernel: a credential of theirs never arrives from elsewhere.
    if carries_agent_token(&request) {
        return refused(
            StatusCode::FORBIDDEN,
            "Agents connect from the kernel's computer",
        );
    }
    next.run(request).await
}

/// A bearer token of the kernel's own (an agent's), as opposed to a signed session token of
/// a person signing in from their device.
fn carries_agent_token(request: &Request) -> bool {
    request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_once(' '))
        .is_some_and(|(_, token)| is_agent_token(token.trim()))
}

async fn workspace(State(store): State<Store>) -> Result<Json<Workspace>, Error> {
    Ok(Json(store.workspace().await?))
}
/// The HTTP API's generation, for information: clients decide by `capabilities`, never by
/// refusing a number. 2: the domain requires a signed-in, bound account (`auth-v1`).
pub const API_VERSION: u32 = 2;

/// The invitation a signup comes with, once the workspace has its owner.
const INVITE_HEADER: &str = "x-zerolux-invite";

/// Reachable without credentials: what this kernel is, the company it runs, and whether an
/// account still has to be bound to its owner.
async fn health(State(state): State<AppState>) -> Result<Json<Value>, Error> {
    let workspace = state.store.workspace_info().await?;
    let mut capabilities = vec!["byoh-v1", "owner-onboarding-v1", "chat-v1", "people-v1"];
    let auth = match &state.auth {
        Some(_) => {
            capabilities.push("auth-v1");
            Some(json!({ "setup_required": !state.store.owner_bound().await? }))
        }
        None => None,
    };
    Ok(Json(json!({
        "name": "zerolux",
        "version": env!("CARGO_PKG_VERSION"),
        "api_version": API_VERSION,
        "capabilities": capabilities,
        "workspace": workspace,
        "auth": auth,
    })))
}

fn auth_of(state: &AppState) -> Result<&Arc<Auth>, ApiFailure> {
    state
        .auth
        .as_ref()
        .ok_or_else(|| failure(StatusCode::NOT_FOUND, "This kernel runs without sign-in"))
}

fn failure(status: StatusCode, message: &str) -> ApiFailure {
    ApiFailure(Box::new(refused(status, message)))
}

/// `owner`: whether the account is the workspace's owner, rather than a person who joined.
fn identity_json(
    session: &HumanSession,
    actor_id: Option<&str>,
    owner: bool,
    setup_required: bool,
) -> Value {
    json!({
        "user": { "id": session.subject, "name": session.name, "email": session.email },
        "actor_id": actor_id,
        "owner": owner,
        "setup_required": setup_required,
    })
}

/// Who the signed-in account is to this workspace: the owner, or not bound yet.
async fn auth_identity(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
) -> Result<Json<Value>, ApiFailure> {
    auth_of(&state)?;
    let setup_required = !state.store.owner_bound().await?;
    match identity {
        Identity::Unbound(session) => {
            Ok(Json(identity_json(&session, None, false, setup_required)))
        }
        Identity::Known(who, Some(session)) if who.is_person() => Ok(Json(identity_json(
            &session,
            who.actor_id.as_deref(),
            state.store.is_workspace_owner(&who).await?,
            setup_required,
        ))),
        Identity::Known(..) => Err(Error::Forbidden.into()),
        Identity::Anonymous => Err(Error::Unauthorized.into()),
    }
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Claim {
    invite: Option<String>,
}

/// Binds the signed-in account to a person: the first account to claim is the owner; a later
/// one joins as a new person with an invitation.
async fn auth_claim(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    body: axum::body::Bytes,
) -> Result<Json<Value>, ApiFailure> {
    auth_of(&state)?;
    let claim: Claim = if body.iter().all(u8::is_ascii_whitespace) {
        Claim::default()
    } else {
        serde_json::from_slice(&body)
            .map_err(|_| failure(StatusCode::BAD_REQUEST, "Send an invitation, or nothing"))?
    };
    let session = match identity {
        Identity::Unbound(session) => session,
        Identity::Known(who, _) if who.is_person() => {
            return Err(failure(
                StatusCode::CONFLICT,
                "This account is already the owner",
            ));
        }
        Identity::Known(..) => return Err(Error::Forbidden.into()),
        Identity::Anonymous => return Err(Error::Unauthorized.into()),
    };
    if let Some(invite) = claim.invite {
        let person = state
            .store
            .join(&invite, &session.subject, &session.name)
            .await
            .map_err(|error| match error {
                Error::NotFound => invitation_gone(),
                other => other.into(),
            })?;
        return Ok(Json(identity_json(
            &session,
            Some(&person.id),
            false,
            false,
        )));
    }
    let owner = state
        .store
        .bind_owner(&session.subject, &session.name)
        .await
        .map_err(|error| match error {
            Error::Conflict => failure(
                StatusCode::FORBIDDEN,
                "This workspace already has its owner; join it with an invitation",
            ),
            other => other.into(),
        })?;
    Ok(Json(identity_json(&session, Some(&owner.id), true, false)))
}

/// Better Auth's own endpoints, through the kernel: sign-in, sign-out, sessions, password.
/// Signing up is open until the owner has an account, and closed after. What ends or may
/// end sessions also disconnects the person's realtime clients: the ones still signed in
/// come back on their own.
async fn auth_proxy(
    State(state): State<AppState>,
    Extension(identity): Extension<Identity>,
    mut request: Request,
) -> Response {
    let auth = match auth_of(&state) {
        Ok(auth) => auth,
        Err(failure) => return failure.into_response(),
    };
    // The path as the service will see it: normalized, so nothing dodges the signup check.
    let path = request
        .extensions()
        .get::<axum::extract::OriginalUri>()
        .map_or_else(
            || request.uri().path().to_owned(),
            |o| o.0.path().to_owned(),
        );
    let path = match reqwest::Url::parse(&format!("http://kernel{path}")) {
        Ok(url) => url.path().to_owned(),
        Err(_) => return refused(StatusCode::BAD_REQUEST, "Invalid path"),
    };
    let signup = path == "/api/auth/sign-up/email";
    let revokes = matches!(
        path.rsplit('/').next(),
        Some(
            "sign-out"
                | "revoke-session"
                | "revoke-sessions"
                | "revoke-other-sessions"
                | "change-password"
        )
    );
    let peer = peer(&request);
    let enroll = if signup {
        // Open for the owner's account; after it, for a person with an invitation.
        let invite = request
            .headers()
            .get(INVITE_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        match (state.store.owner_bound().await, &invite) {
            (Ok(false), _) => {}
            (Ok(true), None) => {
                return refused(
                    StatusCode::FORBIDDEN,
                    "This workspace already has its owner; sign in, or join it with an invitation",
                );
            }
            (Ok(true), Some(invite)) => match state.store.invitation(invite).await {
                Ok(_) => {}
                Err(Error::NotFound) => return invitation_gone().into_response(),
                Err(error) => return error.into_response(),
            },
            (Err(error), _) => return error.into_response(),
        }
        // The name, as the kernel checks it: a signup the claim would refuse is refused
        // here, before an account exists.
        let (parts, body) = request.into_parts();
        let bytes = match axum::body::to_bytes(body, 64 * 1024).await {
            Ok(bytes) => bytes,
            Err(_) => return refused(StatusCode::BAD_REQUEST, "Invalid signup"),
        };
        let name = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v.get("name").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_default();
        let checked = match invite {
            Some(_) => state.store.person_name(&name).await,
            None => crate::store::owner_name(&name),
        };
        if let Err(error) = checked {
            return error.into_response();
        }
        request = Request::from_parts(parts, Body::from(bytes));
        true
    } else {
        false
    };
    match auth.service.proxy(request, enroll, peer).await {
        Ok(response) => {
            if revokes
                && response.status().is_success()
                && let Identity::Known(who, _) = identity
                && who.is_person()
                && let Some(runtime) = &state.runtime
                && let Err(error) = runtime.disconnect_clients(who.addressee()).await
            {
                tracing::error!(
                    error = format!("{error:#}"),
                    "Disconnecting realtime clients failed"
                );
            }
            response
        }
        Err(error) => {
            tracing::error!(error = format!("{error:#}"), "Authentication proxy failed");
            refused(
                StatusCode::SERVICE_UNAVAILABLE,
                "Sign-in is unavailable right now",
            )
        }
    }
}
async fn set_owner_name(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Json(input): Json<SetOwnerName>,
) -> Result<Json<Actor>, Error> {
    if !store.is_workspace_owner(&who).await? {
        return Err(Error::Forbidden);
    }
    Ok(Json(store.set_owner_name(input).await?))
}
async fn set_workspace_name(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Json(input): Json<SetWorkspaceName>,
) -> Result<Json<Value>, Error> {
    if !store.is_workspace_owner(&who).await? {
        return Err(Error::Forbidden);
    }
    Ok(Json(
        json!({ "workspace": store.set_workspace_name(input).await? }),
    ))
}
/// A person's own new agent.
async fn create_agent(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Json(input): Json<CreateAgent>,
) -> Result<impl IntoResponse, Error> {
    if who.actor_id.as_deref() != Some(input.owner_id.as_str()) {
        return Err(Error::Forbidden);
    }
    Ok((StatusCode::CREATED, Json(store.create_agent(input).await?)))
}

/// The workspace's extensions, as they are now.
async fn list_extensions(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
) -> Result<Json<Value>, ApiFailure> {
    if !who.is_person() {
        return Err(Error::Forbidden.into());
    }
    let extensions = runtime(&state)?.extensions.list().await.map_err(said)?;
    Ok(Json(json!({ "extensions": extensions })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExtensionFolder {
    folder: String,
}

/// An extension being worked on, from a folder on the kernel's computer: installed, or
/// installed again, and enabled.
async fn install_extension_folder(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    ChatJson(input): ChatJson<ExtensionFolder>,
) -> Result<Json<Value>, ApiFailure> {
    let extension = runtime(&state)?
        .extensions
        .install_folder(&who, &input.folder)
        .await
        .map_err(said)?;
    Ok(Json(json!({ "extension": extension })))
}

/// The official extensions ZeroLux brings, installed or not.
async fn available_extensions(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
) -> Result<Json<Value>, ApiFailure> {
    if !who.is_person() {
        return Err(Error::Forbidden.into());
    }
    let available = runtime(&state)?
        .extensions
        .available()
        .await
        .map_err(said)?;
    Ok(Json(json!({ "extensions": available })))
}

/// Installs and enables one of the official extensions.
async fn install_official_extension(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let extension = runtime(&state)?
        .extensions
        .install_official(&who, &id)
        .await
        .map_err(said)?;
    Ok(Json(json!({ "extension": extension })))
}

async fn enable_extension(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let extension = runtime(&state)?
        .extensions
        .enable(&who, &id)
        .await
        .map_err(said)?;
    Ok(Json(json!({ "extension": extension })))
}

async fn disable_extension(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let extension = runtime(&state)?
        .extensions
        .disable(&who, &id)
        .await
        .map_err(said)?;
    Ok(Json(json!({ "extension": extension })))
}

async fn remove_extension(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    runtime(&state)?
        .extensions
        .remove(&who, &id)
        .await
        .map_err(said)?;
    Ok(Json(json!({ "removed": true })))
}

async fn extension_settings(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(changes): ChatJson<serde_json::Map<String, Value>>,
) -> Result<Json<Value>, ApiFailure> {
    let extension = runtime(&state)?
        .extensions
        .set_settings(&who, &id, changes)
        .await
        .map_err(said)?;
    Ok(Json(json!({ "extension": extension })))
}

/// The enabled extensions' actions, for people's clients and agents alike.
async fn list_actions(State(state): State<AppState>) -> Result<Json<Value>, ApiFailure> {
    Ok(Json(
        json!({ "actions": runtime(&state)?.extensions.actions().await }),
    ))
}

/// Runs an action, for a person or an agent's session: its input is the body.
async fn run_action(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path((extension, action)): Path<(String, String)>,
    ChatJson(input): ChatJson<Value>,
) -> Result<Json<Value>, ApiFailure> {
    let result = runtime(&state)?
        .extensions
        .run(
            crate::extensions::Caller::of(&who),
            &extension,
            &action,
            input,
        )
        .await
        .map_err(said)?;
    Ok(Json(json!({ "result": result })))
}

/// The computers that run the workspace's sessions, and which joined ones are connected now.
async fn list_hosts(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
) -> Result<Json<Value>, ApiFailure> {
    let mut hosts = state.store.hosts(&who).await?;
    if let Some(runtime) = &state.runtime {
        for host in &mut hosts {
            host.online = host.here || runtime.hosts.online(&host.id).await;
        }
    }
    Ok(Json(json!({ "hosts": hosts })))
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct LinkHost {
    name: Option<String>,
}

/// A host for one of one's computers, with the one-time code it joins with: shown only here.
async fn link_host(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    ChatJson(input): ChatJson<LinkHost>,
) -> Result<Json<Value>, Error> {
    let (host, code) = store.link_host(&who, input.name.as_deref()).await?;
    Ok(Json(json!({ "host": host, "code": code })))
}

async fn remove_host(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    state.store.remove_host(&who, &id).await?;
    if let Some(runtime) = &state.runtime {
        runtime.hosts.disconnect(&id).await;
    }
    Ok(Json(json!({ "removed": true })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JoinHost {
    code: String,
    #[serde(default)]
    name: String,
}

/// A computer joins with the code its person made: its host and the secret it connects with.
async fn join_host(
    State(store): State<Store>,
    ChatJson(input): ChatJson<JoinHost>,
) -> Result<Json<Value>, ApiFailure> {
    match store.join_host(input.code.trim(), &input.name).await {
        Ok((host_id, secret)) => Ok(Json(json!({ "host_id": host_id, "secret": secret }))),
        Err(Error::NotFound) => Err(failure(
            StatusCode::GONE,
            "This code was used or has expired; make a new one",
        )),
        Err(error) => Err(error.into()),
    }
}

/// A joined computer's channel to this kernel, with its secret.
async fn host_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    upgrade: axum::extract::ws::WebSocketUpgrade,
) -> Result<Response, ApiFailure> {
    let secret = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|secret| secret.starts_with(crate::host_link::SECRET_PREFIX))
        .ok_or(Error::Unauthorized)?;
    let host = state
        .store
        .host_by_secret(secret)
        .await?
        .ok_or(Error::Unauthorized)?;
    let runtime = runtime(&state)?.clone();
    state.store.host_seen(&host).await?;
    Ok(upgrade.on_upgrade(move |socket| async move {
        let links = runtime.hosts.clone();
        // Once connected, the computer continues its sessions with new tokens.
        let relink = {
            let (runtime, host) = (runtime.clone(), host.clone());
            tokio::spawn(async move {
                for _ in 0..50 {
                    if runtime.hosts.online(&host).await {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                if let Err(error) = runtime.relink_host(&host).await {
                    tracing::warn!(
                        host,
                        error = format!("{error:#}"),
                        "Relinking a computer failed"
                    );
                }
            })
        };
        let gone = links
            .serve(host.clone(), socket, runtime.host_notices.clone())
            .await;
        relink.abort();
        if gone {
            runtime.host_gone(&host).await;
        }
    }))
}

/// Its person names a host, or opens it to the others.
async fn change_host(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(change): ChatJson<crate::hosts::HostChange>,
) -> Result<Json<Value>, Error> {
    Ok(Json(
        json!({ "host": store.change_host(&who, &id, change).await? }),
    ))
}

/// The harness folders of a guest on this kernel's host, where their accounts are kept.
async fn guest_homes(
    state: &AppState,
    who: &ChatIdentity,
    host: &str,
) -> Result<crate::homes::Homes, ApiFailure> {
    if state.store.host() != Some(host) {
        return Err(Error::Invalid("Sign in on that host, through its own kernel".into()).into());
    }
    host_open(state, who).await?;
    Ok(state.store.homes(who).await?)
}

/// One's own harness accounts on a host open to one.
async fn host_accounts(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let homes = guest_homes(&state, &who, &id).await?;
    let accounts = crate::accounts::read(&homes).await.map_err(said)?;
    Ok(Json(json!({ "accounts": accounts })))
}

async fn set_claude_account(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(account): ChatJson<crate::accounts::ClaudeAccount>,
) -> Result<Json<Value>, ApiFailure> {
    let homes = guest_homes(&state, &who, &id).await?;
    crate::accounts::set_claude(&homes, account).map_err(said)?;
    Ok(Json(json!({ "saved": true })))
}

async fn set_codex_account(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(account): ChatJson<crate::accounts::CodexAccount>,
) -> Result<Json<Value>, ApiFailure> {
    let homes = guest_homes(&state, &who, &id).await?;
    let started = crate::accounts::set_codex(&homes, account)
        .await
        .map_err(said)?;
    Ok(Json(started))
}

async fn clear_codex_account(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let homes = guest_homes(&state, &who, &id).await?;
    crate::accounts::clear_codex(&homes).await.map_err(said)?;
    Ok(Json(json!({ "signed_out": true })))
}

async fn set_pi_account(
    State(state): State<AppState>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
    ChatJson(account): ChatJson<crate::accounts::PiAccount>,
) -> Result<Json<Value>, ApiFailure> {
    let homes = guest_homes(&state, &who, &id).await?;
    crate::accounts::set_pi(&homes, account).map_err(said)?;
    Ok(Json(json!({ "saved": true })))
}

/// A new invitation to join the workspace: its token is in the answer only.
async fn create_invite(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
) -> Result<Json<Value>, Error> {
    let (invite, token) = store.create_invite(&who).await?;
    Ok(Json(json!({ "invite": invite, "token": token })))
}

async fn list_invites(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
) -> Result<Json<Value>, Error> {
    Ok(Json(json!({ "invites": store.invites(&who).await? })))
}

async fn revoke_invite(
    State(store): State<Store>,
    Extension(who): Extension<ChatIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    store.revoke_invite(&who, &id).await?;
    Ok(Json(json!({ "revoked": true })))
}

/// What an invitation is to, before one signs up with it.
async fn invitation(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    auth_of(&state)?;
    match state.store.invitation(&token).await {
        Ok(invitation) => Ok(Json(json!({ "invitation": invitation }))),
        Err(Error::NotFound) => Err(invitation_gone()),
        Err(error) => Err(error.into()),
    }
}

fn invitation_gone() -> ApiFailure {
    failure(
        StatusCode::GONE,
        "This invitation was used, withdrawn or has expired; ask for a new one",
    )
}
