CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"currency" char(3) NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"allow_negative" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" bigint,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'posted' NOT NULL,
	"description" text,
	"initiated_by" uuid,
	"provider_ref" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payhive_id" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"kyc_status" text DEFAULT 'unverified' NOT NULL,
	"stripe_customer_id" text,
	"stripe_account_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postings" ADD CONSTRAINT "postings_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postings" ADD CONSTRAINT "postings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_user_currency_kind_key" ON "accounts" USING btree ("user_id","currency","kind");--> statement-breakpoint
CREATE INDEX "accounts_kind_idx" ON "accounts" USING btree ("kind","currency");--> statement-breakpoint
CREATE INDEX "idempotency_user_idx" ON "idempotency_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "postings_transaction_idx" ON "postings" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "postings_account_idx" ON "postings" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_provider_ref_key" ON "transactions" USING btree ("provider_ref") WHERE provider_ref IS NOT NULL;--> statement-breakpoint
CREATE INDEX "transactions_created_idx" ON "transactions" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_payhive_id_key" ON "users" USING btree ("payhive_id");