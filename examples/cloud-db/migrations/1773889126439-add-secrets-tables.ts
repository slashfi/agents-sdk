interface QueryRunner { query(sql: string): Promise<void>; }

export class AddSecretsTables
{
  name = '1773889126439add-secrets-tables'

  // Define schema constraints
  static constraints = {
    "connections": {
      "must_exist": true,
      "columns": {},
      "indexes": {}
    }
  }

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "public"."secret" (
  "id" VARCHAR NOT NULL,
  "value_encrypted" VARCHAR NOT NULL,
  "created_at" TIMESTAMP NOT NULL,
  PRIMARY KEY ("id")
)`);
    await queryRunner.query(`CREATE TABLE "public"."secret_association" (
  "secret_id" VARCHAR NOT NULL,
  "entity_type" VARCHAR NOT NULL,
  "entity_id" VARCHAR NOT NULL,
  "created_at" TIMESTAMP NOT NULL,
  PRIMARY KEY ("secret_id", "entity_type", "entity_id")
)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "public"."secret_association" CASCADE`);
    await queryRunner.query(`DROP TABLE "public"."secret" CASCADE`);
  }
}
