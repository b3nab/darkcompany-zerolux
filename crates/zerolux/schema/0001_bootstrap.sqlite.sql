-- Complete bootstrap schema. During bootstrap, schema changes require a fresh
-- disposable database; SQLx checksum validation must not be bypassed.
CREATE TABLE actors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
    owner_id TEXT REFERENCES actors(id),
    harness TEXT CHECK (harness IN ('pi', 'claude-code', 'codex')),
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    name_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (name_confirmed IN (0, 1)),
    -- When the actor was created, in milliseconds since the Unix epoch like every other date.
    created_at INTEGER NOT NULL,
    CHECK ((kind = 'human' AND owner_id IS NULL) OR (kind = 'agent' AND owner_id IS NOT NULL))
);

-- The company this kernel runs: one row, created with the owner on the first start. Its name
-- is set during or after onboarding; its creation date is day 1 for the whole workspace.
CREATE TABLE workspace (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    only_one INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (only_one = 1)
);

-- Single-owner bootstrap. The kernel creates the human with a random UUID;
-- naming happens during onboarding and agents are hired explicitly.
CREATE UNIQUE INDEX one_bootstrap_owner ON actors(kind) WHERE kind = 'human';





-- Chat sessions are independent of task connections and their workspace leases.
CREATE TABLE chat_sessions (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL REFERENCES actors(id),
    harness TEXT NOT NULL CHECK (harness IN ('pi', 'claude-code', 'codex')),
    native_session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    workspace TEXT NOT NULL,
    native_locator_json TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('connecting', 'connected', 'attention', 'stopped')),
    attention_reason TEXT,
    created_at INTEGER NOT NULL,
    stopped_at INTEGER,
    -- What the native harness reports; NULL when it is not known.
    activity TEXT CHECK (activity IN ('working', 'idle')),
    -- The chat the current turn is about, when every input of the turn belongs to one chat.
    activity_conversation_id TEXT REFERENCES conversations(id),
    CHECK ((status = 'stopped') = (stopped_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_chat_session ON chat_sessions(harness, native_session_id) WHERE stopped_at IS NULL;

CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('dm', 'group', 'thread')),
    title TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
    next_seq INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    -- A thread hangs under a parent chat, rooted at one of its messages. Its audience is the
    -- parent's whole membership; its own members are the participants who write and receive.
    parent_id TEXT REFERENCES conversations(id),
    root_message_id TEXT REFERENCES messages(id),
    closed_at INTEGER,
    CHECK ((kind = 'thread') = (parent_id IS NOT NULL AND root_message_id IS NOT NULL))
);
-- One open thread per root message: opening it twice joins the one that exists.
CREATE UNIQUE INDEX one_open_thread_per_root ON conversations(root_message_id) WHERE closed_at IS NULL;
CREATE TABLE conversation_members (
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    actor_id TEXT NOT NULL REFERENCES actors(id),
    session_id TEXT REFERENCES chat_sessions(id),
    PRIMARY KEY (conversation_id, actor_id)
);
CREATE INDEX conversation_members_session ON conversation_members(session_id);

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    seq INTEGER NOT NULL,
    author_id TEXT NOT NULL REFERENCES actors(id),
    text TEXT NOT NULL,
    reply_to_delivery_id TEXT UNIQUE REFERENCES deliveries(id),
    created_at INTEGER NOT NULL,
    UNIQUE (conversation_id, seq)
);
CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id),
    actor_id TEXT NOT NULL REFERENCES actors(id),
    session_id TEXT NOT NULL REFERENCES chat_sessions(id),
    status TEXT NOT NULL CHECK (status IN ('stored', 'uncertain', 'notified', 'read')),
    native_request_id TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (message_id, actor_id)
);
CREATE INDEX deliveries_session ON deliveries(session_id, status, created_at);

CREATE TABLE chat_outbox (
    event_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    recipient_actor_ids_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    published_at INTEGER
);
CREATE INDEX chat_outbox_pending ON chat_outbox(created_at) WHERE published_at IS NULL;

CREATE TABLE tool_approvals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id),
    delivery_id TEXT NOT NULL REFERENCES deliveries(id),
    native_request_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    details_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'decided', 'uncertain', 'delivered', 'resolved')),
    decision TEXT CHECK (decision IN ('allow', 'deny')),
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    decision_delivered_at INTEGER,
    UNIQUE (session_id, native_request_id),
    CHECK (status NOT IN ('decided', 'uncertain', 'delivered') OR decision IS NOT NULL)
);

