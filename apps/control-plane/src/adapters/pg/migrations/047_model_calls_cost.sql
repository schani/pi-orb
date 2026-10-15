-- Provider-side list-price estimate per call (docs/model-usage.md); NULL where unknown.
ALTER TABLE model_calls ADD COLUMN cost_usd double precision;
