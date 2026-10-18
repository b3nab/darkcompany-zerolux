-- Create "actors" table
CREATE TABLE `actors` (`id` text NOT NULL, `name` text NOT NULL, `kind` text NOT NULL, `owner_id` text NULL, `harness` text NULL, `archived` boolean NOT NULL DEFAULT FALSE, `name_confirmed` boolean NOT NULL DEFAULT FALSE, `created_at` integer NOT NULL, `auth_subject` text NULL, `model` text NULL, `effort` text NULL, `permission_mode` text NULL, `approval_policy` text NULL, `sandbox` text NULL, `invited_by` text NULL, PRIMARY KEY (`id`), CONSTRAINT `0` FOREIGN KEY (`owner_id`) REFERENCES `actors` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION, CHECK ("kind" IN ('human', 'agent')), CHECK ("harness" IN ('pi', 'claude-code', 'codex')), CHECK (("kind" = 'human' AND "owner_id" IS NULL) OR ("kind" = 'agent' AND "owner_id" IS NOT NULL)), CHECK ("archived" IN (0, 1)), CHECK ("name_confirmed" IN (0, 1)));
-- Create index "one_workspace_owner" to table: "actors"
CREATE UNIQUE INDEX `one_workspace_owner` ON `actors` (`kind`) WHERE "kind" = 'human' AND "invited_by" IS NULL;
-- Create index "one_actor_per_subject" to table: "actors"
CREATE UNIQUE INDEX `one_actor_per_subject` ON `actors` (`auth_subject`) WHERE "auth_subject" IS NOT NULL;
-- Create "workspace" table
CREATE TABLE `workspace` (`id` text NOT NULL, `name` text NOT NULL, `created_at` integer NOT NULL, `only_one` integer NOT NULL DEFAULT 1, `auth_secret` text NULL, PRIMARY KEY (`id`), CHECK ("only_one" = 1));
-- Create index "workspace_only_one" to table: "workspace"
CREATE UNIQUE INDEX `workspace_only_one` ON `workspace` (`only_one`);
-- Create "sessions" table
CREATE TABLE `sessions` (`id` text NOT NULL, `actor_id` text NULL, `harness` text NOT NULL, `native_session_id` text NOT NULL, `title` text NOT NULL, `workspace` text NOT NULL, `native_locator_json` text NOT NULL, `token_hash` text NOT NULL, `status` text NOT NULL, `attention_reason` text NULL, `created_at` integer NOT NULL, `stopped_at` integer NULL, `activity` text NULL, `activity_conversation_id` text NULL, `host_id` text NULL, `pinned_at` integer NULL, `archived_at` integer NULL, `budget_cents` integer NULL, `parent_session_id` text NULL, `owner_id` text NOT NULL, `shared` text NULL, PRIMARY KEY (`id`), CONSTRAINT `0` FOREIGN KEY (`owner_id`) REFERENCES `actors` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION, CONSTRAINT `1` FOREIGN KEY (`activity_conversation_id`) REFERENCES `conversations` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION, CONSTRAINT `2` FOREIGN KEY (`actor_id`) REFERENCES `actors` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION, CHECK ("harness" IN ('pi', 'claude-code', 'codex')), CHECK ("status" IN ('connecting', 'connected', 'attention', 'stopped')), CHECK ("activity" IN ('working', 'idle')), CHECK ("shared" IN ('read', 'write')), CHECK (("status" = 'stopped') = ("stopped_at" IS NOT NULL)));
-- Create index "sessions_token_hash" to table: "sessions"
CREATE UNIQUE INDEX `sessions_token_hash` ON `sessions` (`token_hash`);
-- Create index "idx-sessions-native_session" to table: "sessions"
CREATE UNIQUE INDEX `idx-sessions-native_session` ON `sessions` (`harness`, `native_session_id`);
-- Create "conversations" table
CREATE TABLE `conversations` (`id` text NOT NULL, `kind` text NOT NULL, `title` text NOT NULL, `paused` boolean NOT NULL DEFAULT FALSE, `next_seq` integer NOT NULL DEFAULT 1, `created_at` integer NOT NULL, `parent_id` text NULL, `root_message_id` text NULL, `closed_at` integer NULL, PRIMARY KEY (`id`), CONSTRAINT `0` FOREIGN KEY (`root_message_id`) REFERENCES `messages` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION, CONSTRAINT `1` FOREIGN KEY (`parent_id`) REFERENCES `conversations` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION, CHECK ("kind" IN ('dm', 'group', 'thread')), CHECK (("kind" = 'thread') = ("parent_id" IS NOT NULL AND "root_message_id" IS NOT NULL)), CHECK ("paused" IN (0, 1)));
-- Create index "one_open_thread_per_root" to table: "conversations"
CREATE UNIQUE INDEX `one_open_thread_per_root` ON `conversations` (`root_message_id`) WHERE "closed_at" IS NULL;
-- Create "conversation_members" table
CREATE TABLE `conversation_members` (`conversation_id` text NOT NULL, `actor_id` text NOT NULL, `session_id` text NULL, PRIMARY KEY (`conversation_id`, `actor_id`), CONSTRAINT `0` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION, CONSTRAINT `1` FOREIGN KEY (`actor_id`) REFERENCES `actors` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION, CONSTRAINT `2` FOREIGN KEY (`conversation_id`) REFERENCES `conversations` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION);
-- Create index "conversation_members_session" to table: "conversation_members"
CREATE INDEX `conversation_members_session` ON `conversation_members` (`session_id`);
-- Create "messages" table
CREATE TABLE `messages` (`id` text NOT NULL, `conversation_id` text NOT NULL, `seq` integer NOT NULL, `author_id` text NOT NULL, `text` text NOT NULL, `reply_to_delivery_id` text NULL, `created_at` integer NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `0` FOREIGN KEY (`reply_to_delivery_id`) REFERENCES `deliveries` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION, CONSTRAINT `1` FOREIGN KEY (`author_id`) REFERENCES `actors` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION, CONSTRAINT `2` FOREIGN KEY (`conversation_id`) REFERENCES `conversations` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION);
-- Create index "messages_reply_to_delivery_id" to table: "messages"
CREATE UNIQUE INDEX `messages_reply_to_delivery_id` ON `messages` (`reply_to_delivery_id`);
-- Create index "messages_conversation_id_seq" to table: "messages"
CREATE UNIQUE INDEX `messages_conversation_id_seq` ON `messages` (`conversation_id`, `seq`);
-- Create "deliveries" table
CREATE TABLE `deliveries` (`id` text NOT NULL, `message_id` text NOT NULL, `actor_id` text NOT NULL, `session_id` text NOT NULL, `status` text NOT NULL, `native_request_id` text NULL, `last_error` text NULL, `created_at` integer NOT NULL, `updated_at` integer NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `0` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION, CONSTRAINT `1` FOREIGN KEY (`actor_id`) REFERENCES `actors` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION, CONSTRAINT `2` FOREIGN KEY (`message_id`) REFERENCES `messages` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION, CHECK ("status" IN ('stored', 'uncertain', 'notified', 'read')));
-- Create index "deliveries_message_id_actor_id" to table: "deliveries"
CREATE UNIQUE INDEX `deliveries_message_id_actor_id` ON `deliveries` (`message_id`, `actor_id`);
-- Create index "deliveries_session" to table: "deliveries"
CREATE INDEX `deliveries_session` ON `deliveries` (`session_id`, `status`, `created_at`);
-- Create "chat_outbox" table
CREATE TABLE `chat_outbox` (`event_id` text NOT NULL, `payload_json` text NOT NULL, `recipient_actor_ids_json` text NOT NULL, `created_at` integer NOT NULL, `published_at` integer NULL, PRIMARY KEY (`event_id`));
-- Create index "chat_outbox_pending" to table: "chat_outbox"
CREATE INDEX `chat_outbox_pending` ON `chat_outbox` (`created_at`) WHERE "published_at" IS NULL;
-- Create "tool_approvals" table
CREATE TABLE `tool_approvals` (`id` text NOT NULL, `session_id` text NOT NULL, `delivery_id` text NULL, `native_request_id` text NOT NULL, `kind` text NOT NULL DEFAULT 'permission', `summary` text NOT NULL, `details_json` text NOT NULL, `status` text NOT NULL, `decision` text NULL, `scope` text NULL, `reason` text NULL, `answer_json` text NULL, `last_error` text NULL, `created_at` integer NOT NULL, `updated_at` integer NOT NULL, `decision_delivered_at` integer NULL, PRIMARY KEY (`id`), CONSTRAINT `0` FOREIGN KEY (`delivery_id`) REFERENCES `deliveries` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION, CONSTRAINT `1` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION, CHECK ("status" IN ('pending', 'decided', 'uncertain', 'delivered', 'resolved')), CHECK ("kind" IN ('permission', 'question', 'form')), CHECK ("decision" IN ('allow', 'deny')), CHECK ("scope" IN ('once', 'session', 'always')), CHECK (("kind" = 'permission' AND "answer_json" IS NULL) OR ("kind" <> 'permission' AND "decision" IS NULL)), CHECK ("status" NOT IN ('decided', 'uncertain', 'delivered') OR "decision" IS NOT NULL OR "answer_json" IS NOT NULL));
-- Create index "tool_approvals_session_id_native_request_id" to table: "tool_approvals"
CREATE UNIQUE INDEX `tool_approvals_session_id_native_request_id` ON `tool_approvals` (`session_id`, `native_request_id`);
-- Create "schedules" table
CREATE TABLE `schedules` (`id` text NOT NULL, `session_id` text NOT NULL, `cron` text NOT NULL, `prompt` text NOT NULL, `enabled` boolean NOT NULL, `next_run_at` integer NULL, `last_run_at` integer NULL, `last_error` text NULL, `created_at` integer NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `0` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION);
-- Create index "schedules_due" to table: "schedules"
CREATE INDEX `schedules_due` ON `schedules` (`next_run_at`) WHERE "enabled" = TRUE;
-- Create "invites" table
CREATE TABLE `invites` (`id` text NOT NULL, `token_hash` text NOT NULL, `created_by` text NOT NULL, `created_at` integer NOT NULL, `expires_at` integer NOT NULL, `accepted_by` text NULL, `accepted_at` integer NULL, PRIMARY KEY (`id`), CONSTRAINT `0` FOREIGN KEY (`accepted_by`) REFERENCES `actors` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION, CONSTRAINT `1` FOREIGN KEY (`created_by`) REFERENCES `actors` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION);
-- Create index "invites_token_hash" to table: "invites"
CREATE UNIQUE INDEX `invites_token_hash` ON `invites` (`token_hash`);
-- Create "triggers" table
CREATE TABLE `triggers` (`id` text NOT NULL, `session_id` text NOT NULL, `event` text NOT NULL, `failures_only` boolean NOT NULL, `prompt` text NOT NULL, `enabled` boolean NOT NULL, `last_seen` text NULL, `last_run_at` integer NULL, `last_error` text NULL, `created_at` integer NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `0` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION, CHECK ("event" IN ('ci')));
-- Create "hosts" table
CREATE TABLE `hosts` (`id` text NOT NULL, `name` text NOT NULL, `person_id` text NOT NULL, `open` boolean NOT NULL, `created_at` integer NOT NULL, `seen_at` integer NOT NULL, `secret_hash` text NULL, `link_hash` text NULL, `link_expires_at` integer NULL, PRIMARY KEY (`id`), CONSTRAINT `0` FOREIGN KEY (`person_id`) REFERENCES `actors` (`id`) ON UPDATE NO ACTION ON DELETE NO ACTION);
-- Create index "hosts_secret_hash" to table: "hosts"
CREATE UNIQUE INDEX `hosts_secret_hash` ON `hosts` (`secret_hash`);
-- Create index "hosts_link_hash" to table: "hosts"
CREATE UNIQUE INDEX `hosts_link_hash` ON `hosts` (`link_hash`);
