-- Create "actors" table
CREATE TABLE "actors" ("id" text NOT NULL, "name" text NOT NULL, "kind" text NOT NULL, "owner_id" text NULL, "harness" text NULL, "archived" boolean NOT NULL DEFAULT false, "name_confirmed" boolean NOT NULL DEFAULT false, "created_at" bigint NOT NULL, "auth_subject" text NULL, "model" text NULL, "effort" text NULL, "permission_mode" text NULL, "approval_policy" text NULL, "sandbox" text NULL, "invited_by" text NULL, PRIMARY KEY ("id"), CONSTRAINT "actors_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "actors" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION, CONSTRAINT "actors_check" CHECK (((kind = 'human'::text) AND (owner_id IS NULL)) OR ((kind = 'agent'::text) AND (owner_id IS NOT NULL))), CONSTRAINT "actors_harness_check" CHECK (harness = ANY (ARRAY['pi'::text, 'claude-code'::text, 'codex'::text])), CONSTRAINT "actors_kind_check" CHECK (kind = ANY (ARRAY['human'::text, 'agent'::text])));
-- Create index "one_actor_per_subject" to table: "actors"
CREATE UNIQUE INDEX "one_actor_per_subject" ON "actors" ("auth_subject") WHERE (auth_subject IS NOT NULL);
-- Create index "one_workspace_owner" to table: "actors"
CREATE UNIQUE INDEX "one_workspace_owner" ON "actors" ("kind") WHERE ((kind = 'human'::text) AND (invited_by IS NULL));
-- Create "chat_outbox" table
CREATE TABLE "chat_outbox" ("event_id" text NOT NULL, "payload_json" text NOT NULL, "recipient_actor_ids_json" text NOT NULL, "created_at" bigint NOT NULL, "published_at" bigint NULL, PRIMARY KEY ("event_id"));
-- Create index "chat_outbox_pending" to table: "chat_outbox"
CREATE INDEX "chat_outbox_pending" ON "chat_outbox" ("created_at") WHERE (published_at IS NULL);
-- Create "conversation_members" table
CREATE TABLE "conversation_members" ("conversation_id" text NOT NULL, "actor_id" text NOT NULL, "session_id" text NULL, PRIMARY KEY ("conversation_id", "actor_id"));
-- Create index "conversation_members_session" to table: "conversation_members"
CREATE INDEX "conversation_members_session" ON "conversation_members" ("session_id");
-- Create "conversations" table
CREATE TABLE "conversations" ("id" text NOT NULL, "kind" text NOT NULL, "title" text NOT NULL, "paused" boolean NOT NULL DEFAULT false, "next_seq" bigint NOT NULL DEFAULT 1, "created_at" bigint NOT NULL, "parent_id" text NULL, "root_message_id" text NULL, "closed_at" bigint NULL, PRIMARY KEY ("id"), CONSTRAINT "conversations_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "conversations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION, CONSTRAINT "conversations_check" CHECK ((kind = 'thread'::text) = ((parent_id IS NOT NULL) AND (root_message_id IS NOT NULL))), CONSTRAINT "conversations_kind_check" CHECK (kind = ANY (ARRAY['dm'::text, 'group'::text, 'thread'::text])));
-- Create index "one_open_thread_per_root" to table: "conversations"
CREATE UNIQUE INDEX "one_open_thread_per_root" ON "conversations" ("root_message_id") WHERE (closed_at IS NULL);
-- Create "deliveries" table
CREATE TABLE "deliveries" ("id" text NOT NULL, "message_id" text NOT NULL, "actor_id" text NOT NULL, "session_id" text NOT NULL, "status" text NOT NULL, "native_request_id" text NULL, "last_error" text NULL, "created_at" bigint NOT NULL, "updated_at" bigint NOT NULL, PRIMARY KEY ("id"), CONSTRAINT "deliveries_message_id_actor_id_key" UNIQUE ("message_id", "actor_id"), CONSTRAINT "deliveries_status_check" CHECK (status = ANY (ARRAY['stored'::text, 'uncertain'::text, 'notified'::text, 'read'::text])));
-- Create index "deliveries_session" to table: "deliveries"
CREATE INDEX "deliveries_session" ON "deliveries" ("session_id", "status", "created_at");
-- Create "hosts" table
CREATE TABLE "hosts" ("id" text NOT NULL, "name" text NOT NULL, "person_id" text NOT NULL, "open" boolean NOT NULL, "created_at" bigint NOT NULL, "seen_at" bigint NOT NULL, "secret_hash" text NULL, "link_hash" text NULL, "link_expires_at" bigint NULL, PRIMARY KEY ("id"), CONSTRAINT "hosts_link_hash_key" UNIQUE ("link_hash"), CONSTRAINT "hosts_secret_hash_key" UNIQUE ("secret_hash"));
-- Create "invites" table
CREATE TABLE "invites" ("id" text NOT NULL, "token_hash" text NOT NULL, "created_by" text NOT NULL, "created_at" bigint NOT NULL, "expires_at" bigint NOT NULL, "accepted_by" text NULL, "accepted_at" bigint NULL, PRIMARY KEY ("id"), CONSTRAINT "invites_token_hash_key" UNIQUE ("token_hash"));
-- Create "messages" table
CREATE TABLE "messages" ("id" text NOT NULL, "conversation_id" text NOT NULL, "seq" bigint NOT NULL, "author_id" text NOT NULL, "text" text NOT NULL, "reply_to_delivery_id" text NULL, "created_at" bigint NOT NULL, PRIMARY KEY ("id"), CONSTRAINT "messages_conversation_id_seq_key" UNIQUE ("conversation_id", "seq"), CONSTRAINT "messages_reply_to_delivery_id_key" UNIQUE ("reply_to_delivery_id"));
-- Create "schedules" table
CREATE TABLE "schedules" ("id" text NOT NULL, "session_id" text NOT NULL, "cron" text NOT NULL, "prompt" text NOT NULL, "enabled" boolean NOT NULL, "next_run_at" bigint NULL, "last_run_at" bigint NULL, "last_error" text NULL, "created_at" bigint NOT NULL, PRIMARY KEY ("id"));
-- Create index "schedules_due" to table: "schedules"
CREATE INDEX "schedules_due" ON "schedules" ("next_run_at") WHERE (enabled = true);
-- Create "sessions" table
CREATE TABLE "sessions" ("id" text NOT NULL, "actor_id" text NULL, "harness" text NOT NULL, "native_session_id" text NOT NULL, "title" text NOT NULL, "workspace" text NOT NULL, "native_locator_json" text NOT NULL, "token_hash" text NOT NULL, "status" text NOT NULL, "attention_reason" text NULL, "created_at" bigint NOT NULL, "stopped_at" bigint NULL, "activity" text NULL, "activity_conversation_id" text NULL, "host_id" text NULL, "pinned_at" bigint NULL, "archived_at" bigint NULL, "budget_cents" bigint NULL, "parent_session_id" text NULL, "owner_id" text NOT NULL, "shared" text NULL, PRIMARY KEY ("id"), CONSTRAINT "sessions_token_hash_key" UNIQUE ("token_hash"), CONSTRAINT "sessions_activity_check" CHECK (activity = ANY (ARRAY['working'::text, 'idle'::text])), CONSTRAINT "sessions_check" CHECK ((status = 'stopped'::text) = (stopped_at IS NOT NULL)), CONSTRAINT "sessions_harness_check" CHECK (harness = ANY (ARRAY['pi'::text, 'claude-code'::text, 'codex'::text])), CONSTRAINT "sessions_shared_check" CHECK (shared = ANY (ARRAY['read'::text, 'write'::text])), CONSTRAINT "sessions_status_check" CHECK (status = ANY (ARRAY['connecting'::text, 'connected'::text, 'attention'::text, 'stopped'::text])));
-- Create index "idx-sessions-native_session" to table: "sessions"
CREATE UNIQUE INDEX "idx-sessions-native_session" ON "sessions" ("harness", "native_session_id");
-- Create "tool_approvals" table
CREATE TABLE "tool_approvals" ("id" text NOT NULL, "session_id" text NOT NULL, "delivery_id" text NULL, "native_request_id" text NOT NULL, "kind" text NOT NULL DEFAULT 'permission', "summary" text NOT NULL, "details_json" text NOT NULL, "status" text NOT NULL, "decision" text NULL, "scope" text NULL, "reason" text NULL, "answer_json" text NULL, "last_error" text NULL, "created_at" bigint NOT NULL, "updated_at" bigint NOT NULL, "decision_delivered_at" bigint NULL, PRIMARY KEY ("id"), CONSTRAINT "tool_approvals_session_id_native_request_id_key" UNIQUE ("session_id", "native_request_id"), CONSTRAINT "tool_approvals_check" CHECK (((kind = 'permission'::text) AND (answer_json IS NULL)) OR ((kind <> 'permission'::text) AND (decision IS NULL))), CONSTRAINT "tool_approvals_check1" CHECK ((status <> ALL (ARRAY['decided'::text, 'uncertain'::text, 'delivered'::text])) OR (decision IS NOT NULL) OR (answer_json IS NOT NULL)), CONSTRAINT "tool_approvals_decision_check" CHECK (decision = ANY (ARRAY['allow'::text, 'deny'::text])), CONSTRAINT "tool_approvals_kind_check" CHECK (kind = ANY (ARRAY['permission'::text, 'question'::text, 'form'::text])), CONSTRAINT "tool_approvals_scope_check" CHECK (scope = ANY (ARRAY['once'::text, 'session'::text, 'always'::text])), CONSTRAINT "tool_approvals_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'decided'::text, 'uncertain'::text, 'delivered'::text, 'resolved'::text])));
-- Create "triggers" table
CREATE TABLE "triggers" ("id" text NOT NULL, "session_id" text NOT NULL, "event" text NOT NULL, "failures_only" boolean NOT NULL, "prompt" text NOT NULL, "enabled" boolean NOT NULL, "last_seen" text NULL, "last_run_at" bigint NULL, "last_error" text NULL, "created_at" bigint NOT NULL, PRIMARY KEY ("id"), CONSTRAINT "triggers_event_check" CHECK (event = 'ci'::text));
-- Create "workspace" table
CREATE TABLE "workspace" ("id" text NOT NULL, "name" text NOT NULL, "created_at" bigint NOT NULL, "only_one" bigint NOT NULL DEFAULT 1, "auth_secret" text NULL, PRIMARY KEY ("id"), CONSTRAINT "workspace_only_one_key" UNIQUE ("only_one"), CONSTRAINT "workspace_only_one_check" CHECK (only_one = 1));
-- Modify "conversation_members" table
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION, ADD CONSTRAINT "conversation_members_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION, ADD CONSTRAINT "conversation_members_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
-- Modify "conversations" table
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_root_message_id_fkey" FOREIGN KEY ("root_message_id") REFERENCES "messages" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
-- Modify "deliveries" table
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION, ADD CONSTRAINT "deliveries_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION, ADD CONSTRAINT "deliveries_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
-- Modify "hosts" table
ALTER TABLE "hosts" ADD CONSTRAINT "hosts_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "actors" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
-- Modify "invites" table
ALTER TABLE "invites" ADD CONSTRAINT "invites_accepted_by_fkey" FOREIGN KEY ("accepted_by") REFERENCES "actors" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION, ADD CONSTRAINT "invites_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "actors" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
-- Modify "messages" table
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "actors" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION, ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION, ADD CONSTRAINT "messages_reply_to_delivery_id_fkey" FOREIGN KEY ("reply_to_delivery_id") REFERENCES "deliveries" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
-- Modify "schedules" table
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
-- Modify "sessions" table
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_activity_conversation_id_fkey" FOREIGN KEY ("activity_conversation_id") REFERENCES "conversations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION, ADD CONSTRAINT "sessions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "actors" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION, ADD CONSTRAINT "sessions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "actors" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
-- Modify "tool_approvals" table
ALTER TABLE "tool_approvals" ADD CONSTRAINT "tool_approvals_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION, ADD CONSTRAINT "tool_approvals_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
-- Modify "triggers" table
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
