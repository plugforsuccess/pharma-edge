-- Add missing etb_convergence column to confluence_ranks table
-- The ranking script computes E+T+B (Echo + Tango + Bravo) convergence
-- and includes it in the upsert payload, but the column was not in the schema.

ALTER TABLE public.confluence_ranks ADD COLUMN IF NOT EXISTS etb_convergence boolean;
