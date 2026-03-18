interface QueryRunner { query(sql: string): Promise<void>; }

export class InitialSchema
{
  name = '1773799919680-initial-schema'

  // Define schema constraints
  static constraints = {}

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "public"."agents" (
  "id" VARCHAR NOT NULL,
  "tenant_id" VARCHAR NOT NULL,
  "name" VARCHAR NOT NULL,
  "description" VARCHAR NOT NULL,
  "version" VARCHAR NOT NULL,
  "status" VARCHAR NOT NULL,
  "endpoint_url" VARCHAR,
  "created_at" TIMESTAMP NOT NULL,
  "updated_at" TIMESTAMP NOT NULL,
  PRIMARY KEY ("id")
)`);
    await queryRunner.query(`CREATE TABLE "public"."agent_tools" (
  "id" VARCHAR NOT NULL,
  "agent_id" VARCHAR NOT NULL,
  "name" VARCHAR NOT NULL,
  "description" VARCHAR NOT NULL,
  "input_schema" VARCHAR NOT NULL,
  PRIMARY KEY ("id")
)`);
    await queryRunner.query(`CREATE TABLE "public"."auth_clients" (
  "client_id" VARCHAR NOT NULL,
  "client_secret_hash" VARCHAR NOT NULL,
  "name" VARCHAR NOT NULL,
  "scopes" VARCHAR NOT NULL,
  "self_registered" BOOLEAN NOT NULL,
  "created_at" TIMESTAMP NOT NULL,
  PRIMARY KEY ("client_id")
)`);
    await queryRunner.query(`CREATE TABLE "public"."auth_tokens" (
  "token" VARCHAR NOT NULL,
  "client_id" VARCHAR NOT NULL,
  "scopes" VARCHAR NOT NULL,
  "issued_at" TIMESTAMP NOT NULL,
  "expires_at" TIMESTAMP NOT NULL,
  PRIMARY KEY ("token")
)`);
    await queryRunner.query(`CREATE TABLE "public"."tenants" (
  "id" VARCHAR NOT NULL,
  "name" VARCHAR NOT NULL,
  "plan" VARCHAR NOT NULL,
  "created_at" TIMESTAMP NOT NULL,
  PRIMARY KEY ("id")
)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "public"."tenants" CASCADE`);
    await queryRunner.query(`DROP TABLE "public"."auth_tokens" CASCADE`);
    await queryRunner.query(`DROP TABLE "public"."auth_clients" CASCADE`);
    await queryRunner.query(`DROP TABLE "public"."agent_tools" CASCADE`);
    await queryRunner.query(`DROP TABLE "public"."agents" CASCADE`);
  }
}
