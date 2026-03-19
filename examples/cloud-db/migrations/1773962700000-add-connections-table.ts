interface QueryRunner { query(sql: string): Promise<void>; }

export class AddConnectionsTable {
  name = '1773962700000-add-connections-table'

  static constraints = {}

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "public"."connections" (
  "id" VARCHAR NOT NULL,
  "owner_id" VARCHAR NOT NULL,
  "name" VARCHAR NOT NULL,
  "type" VARCHAR NOT NULL,
  "config_encrypted" VARCHAR NOT NULL,
  "status" VARCHAR NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "public"."connections"`);
  }
}
