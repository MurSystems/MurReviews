-- ============================================================================
-- A cancelled text is not a failure. Give it its own status so Activity can
-- say "Cancelled" instead of "Failed".
--
-- The value is added in its own migration because PostgreSQL will not let a
-- new enum value be used in the same transaction that adds it.
-- ============================================================================

alter type public.message_status add value if not exists 'cancelled';
