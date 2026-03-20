interface QueryRunner { query(sql: string): Promise<void>; }

export class FixSchemaDefaults {
  name = '1773964100000-fix-schema-defaults'

  static constraints = {}

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "public"."tenants" ALTER COLUMN "plan" SET DEFAULT 'free'`);
    await queryRunner.query(`ALTER TABLE "public"."auth_clients" ADD COLUMN IF NOT EXISTS "tenant_id" STRING DEFAULT 'default'`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // No-op
  }
}
