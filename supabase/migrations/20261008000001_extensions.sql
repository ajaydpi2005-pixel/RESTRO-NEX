-- RestroNex — Phase 1: PostgreSQL extensions
-- gen_random_uuid() is built into PostgreSQL 13+; no pgcrypto needed.

create extension if not exists citext;
