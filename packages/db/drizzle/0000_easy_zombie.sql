CREATE TYPE "public"."agent_status" AS ENUM('active', 'paused', 'offline');--> statement-breakpoint
CREATE TYPE "public"."approval_kind" AS ENUM('hire', 'tool_call', 'spend', 'question');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."artifact_kind" AS ENUM('file', 'diff', 'pr', 'doc', 'image', 'design', 'link', 'report');--> statement-breakpoint
CREATE TYPE "public"."author_type" AS ENUM('agent', 'human');--> statement-breakpoint
CREATE TYPE "public"."channel_kind" AS ENUM('project', 'team', 'dm', 'task_thread', 'general');--> statement-breakpoint
CREATE TYPE "public"."model_provider" AS ENUM('anthropic', 'openai_compatible', 'google', 'ollama', 'combo');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'waiting_human', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."run_step_kind" AS ENUM('llm_call', 'tool_call', 'tool_result', 'message', 'thinking_summary');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('task', 'mention', 'schedule', 'human');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('backlog', 'todo', 'in_progress', 'review', 'done', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."tool_config_kind" AS ENUM('mcp', 'builtin');--> statement-breakpoint
CREATE TABLE "company" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"lead_agent_id" text
);
--> statement-breakpoint
CREATE TABLE "agent" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"persona" jsonb NOT NULL,
	"system_prompt" text NOT NULL,
	"avatar" text NOT NULL,
	"reports_to" text,
	"team_id" text,
	"model_config" jsonb NOT NULL,
	"tool_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "agent_status" DEFAULT 'active' NOT NULL,
	"budget_daily_usd" numeric(12, 4) DEFAULT '0' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"repos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"workspace_id" text,
	"board_settings" jsonb NOT NULL,
	"wiki_path" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"acceptance_criteria" text DEFAULT '' NOT NULL,
	"status" "task_status" DEFAULT 'backlog' NOT NULL,
	"priority" "task_priority" DEFAULT 'medium' NOT NULL,
	"assignee_id" text,
	"created_by" text NOT NULL,
	"parent_id" text,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"due_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "run" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" text NOT NULL,
	"task_id" text,
	"channel_id" text,
	"trigger" "run_trigger" NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"summary" text
);
--> statement-breakpoint
CREATE TABLE "run_step" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" "run_step_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"tokens" integer,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "channel" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" text,
	"team_id" text,
	"kind" "channel_kind" NOT NULL,
	"name" text,
	"task_id" text
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"channel_id" text NOT NULL,
	"author_type" "author_type" NOT NULL,
	"author_id" text NOT NULL,
	"content" text NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reply_to" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" text,
	"task_id" text,
	"run_id" text,
	"artifact_group_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"kind" "artifact_kind" NOT NULL,
	"title" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kg_node" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" text,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"summary" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"embedding" vector(1536)
);
--> statement-breakpoint
CREATE TABLE "kg_edge" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_id" text NOT NULL,
	"to_id" text NOT NULL,
	"type" text NOT NULL,
	"weight" real,
	"evidence" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_page" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" text NOT NULL,
	"path" text NOT NULL,
	"title" text NOT NULL,
	"frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536)
);
--> statement-breakpoint
CREATE TABLE "tool_config" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "tool_config_kind" NOT NULL,
	"name" text NOT NULL,
	"command" text,
	"url" text,
	"env_secret_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_config" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" "model_provider" NOT NULL,
	"api_key_encrypted" text,
	"base_url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"model_catalog_cache" jsonb,
	"model_catalog_cached_at" timestamp with time zone,
	"input_cost_per_mtok" numeric(12, 6),
	"output_cost_per_mtok" numeric(12, 6)
);
--> statement-breakpoint
CREATE TABLE "approval" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" text NOT NULL,
	"kind" "approval_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "secret" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"value_encrypted" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_combo" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"entries" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_lead_agent_id_agent_id_fk" FOREIGN KEY ("lead_agent_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_reports_to_agent_id_fk" FOREIGN KEY ("reports_to") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_assignee_id_agent_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_parent_id_task_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_step" ADD CONSTRAINT "run_step_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_reply_to_message_id_fk" FOREIGN KEY ("reply_to") REFERENCES "public"."message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kg_node" ADD CONSTRAINT "kg_node_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kg_edge" ADD CONSTRAINT "kg_edge_from_id_kg_node_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."kg_node"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kg_edge" ADD CONSTRAINT "kg_edge_to_id_kg_node_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."kg_node"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page" ADD CONSTRAINT "wiki_page_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_project_id_idx" ON "task" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "task_status_idx" ON "task" USING btree ("status");--> statement-breakpoint
CREATE INDEX "task_assignee_id_idx" ON "task" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "run_agent_id_idx" ON "run" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "run_task_id_idx" ON "run" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "run_channel_id_idx" ON "run" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "run_status_idx" ON "run" USING btree ("status");--> statement-breakpoint
CREATE INDEX "run_step_run_id_idx" ON "run_step" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "channel_project_id_idx" ON "channel" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "channel_team_id_idx" ON "channel" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "channel_task_id_idx" ON "channel" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "message_channel_id_idx" ON "message" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "artifact_project_id_idx" ON "artifact" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "artifact_task_id_idx" ON "artifact" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "artifact_run_id_idx" ON "artifact" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "kg_node_project_id_idx" ON "kg_node" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "kg_edge_from_id_idx" ON "kg_edge" USING btree ("from_id");--> statement-breakpoint
CREATE INDEX "kg_edge_to_id_idx" ON "kg_edge" USING btree ("to_id");--> statement-breakpoint
CREATE INDEX "wiki_page_project_id_idx" ON "wiki_page" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "approval_status_idx" ON "approval" USING btree ("status");--> statement-breakpoint
CREATE INDEX "approval_run_id_idx" ON "approval" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "secret_name_idx" ON "secret" USING btree ("name");--> statement-breakpoint
CREATE INDEX "event_occurred_at_idx" ON "event" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_idx" ON "user" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "model_combo_name_idx" ON "model_combo" USING btree ("name");