interface QueryRunner { query(sql: string): Promise<void>; }

export class AddTenantIdentities {
  name = '1774002900000-add-tenant-identities'

  static constraints = {}

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "public"."tenant_identities" (
  "id" VARCHAR NOT NULL,
  "tenant_id" VARCHAR NOT NULL,
  "provider" VARCHAR NOT NULL,
  "provider_org_id" VARCHAR NOT NULL,
  "name" VARCHAR,
  "metadata_json" TEXT,
  "created_at" TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  UNIQUE ("provider", "provider_org_id")
)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "public"."tenant_identities"`);
  }
}
