-- Spec section 15: SuperTokens gets its own database inside the same Postgres
-- instance rather than a second container. This mirrors the production layout,
-- where the database and role are created inside the existing Unraid Postgres.
CREATE DATABASE supertokens;
