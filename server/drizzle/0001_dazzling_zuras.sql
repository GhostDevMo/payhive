CREATE TABLE "retired_handles" (
	"skeleton" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"user_id" uuid,
	"retired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "handle" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "handle_skeleton" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "handle_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retired_handles" ADD CONSTRAINT "retired_handles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_handle_skeleton_key" ON "users" USING btree ("handle_skeleton");