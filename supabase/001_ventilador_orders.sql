-- Ventilador Funnel: Orders table
-- Run this in the Supabase SQL Editor at https://supabase.com/dashboard

CREATE TABLE IF NOT EXISTS ventilador_orders (
  id                  UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  payment_intent_id   TEXT        UNIQUE NOT NULL,
  pack                INTEGER     NOT NULL,
  pack_name           TEXT        NOT NULL,
  color               TEXT        NOT NULL,
  amount              INTEGER     NOT NULL,
  currency            TEXT        DEFAULT 'eur',
  status              TEXT        DEFAULT 'pending'
                                  CHECK (status IN ('pending','paid','failed','refunded')),
  customer_name       TEXT,
  customer_email      TEXT,
  shipping_address    JSONB,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ventilador_orders_updated_at ON ventilador_orders;
CREATE TRIGGER ventilador_orders_updated_at
  BEFORE UPDATE ON ventilador_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_ventilador_orders_payment_intent
  ON ventilador_orders (payment_intent_id);

CREATE INDEX IF NOT EXISTS idx_ventilador_orders_status
  ON ventilador_orders (status);

-- Row Level Security: only service role can access
ALTER TABLE ventilador_orders ENABLE ROW LEVEL SECURITY;
