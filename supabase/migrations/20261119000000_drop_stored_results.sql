-- Transcripts and translations are no longer stored: results are only streamed
-- back to the client. Drop the columns (and any data already in them).
alter table public.jobs drop column if exists transcript;
alter table public.jobs drop column if exists translation;
