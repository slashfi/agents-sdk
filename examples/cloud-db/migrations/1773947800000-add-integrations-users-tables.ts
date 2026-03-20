interface QueryRunner { query(sql: string): Promise<void>; }

export class AddIntegrationsUsersTables {
  name = '1773947800000-add-integrations-users-tables'

  static constraints = {}

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "public"."provider_configs" (
  "id" VARCHAR NOT NULL,
  "name" VARCHAR NOT NULL,
  "type" VARCHAR NOT NULL,
  "scope" VARCHAR NOT NULL DEFAULT 'user',
  "config_json" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "provider_configs_pkey" PRIMARY KEY ("id")
)`);

    await queryRunner.query(`CREATE TABLE "public"."user_connections" (
  "user_id" VARCHAR NOT NULL,
  "provider_id" VARCHAR NOT NULL,
  "access_token_encrypted" TEXT NOT NULL,
  "refresh_token_encrypted" TEXT,
  "expires_at" TIMESTAMPTZ,
  "token_type" VARCHAR,
  "scopes" TEXT,
  "connected_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "user_connections_pkey" PRIMARY KEY ("user_id", "provider_id")
)`);

    await queryRunner.query(`CREATE TABLE "public"."users" (
  "id" VARCHAR NOT NULL,
  "tenant_id" VARCHAR NOT NULL,
  "email" VARCHAR,
  "name" VARCHAR,
  "avatar_url" VARCHAR,
  "metadata_json" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
)`);
    await queryRunner.query(`CREATE INDEX "idx_users_tenant_id" ON "public"."users" ("tenant_id")`);
    await queryRunner.query(`CREATE INDEX "idx_users_tenant_email" ON "public"."users" ("tenant_id", "email")`);

    await queryRunner.query(`CREATE TABLE "public"."user_identities" (
  "id" VARCHAR NOT NULL,
  "user_id" VARCHAR NOT NULL,
  "provider" VARCHAR NOT NULL,
  "provider_user_id" VARCHAR NOT NULL,
  "email" VARCHAR,
  "name" VARCHAR,
  "avatar_url" VARCHAR,
  "access_token_encrypted" TEXT,
  "refresh_token_encrypted" TEXT,
  "expires_at" TIMESTAMPTZ,
  "token_type" VARCHAR,
  "scopes" TEXT,
  "metadata_json" TEXT,
  "connected_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
)`);
    await queryRunner.query(`CREATE INDEX "idx_user_identities_user_id" ON "public"."user_identities" ("user_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_user_identities_provider_lookup" ON "public"."user_identities" ("provider", "provider_user_id")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "public"."user_identities"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "public"."users"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "public"."user_connections"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "public"."provider_configs"`);
  }
}
