-- Seed template so the document pipeline is usable end-to-end.
-- The Rust service (later) renders from schema_definition; the mock generator
-- only echoes the payload.

INSERT INTO public.templates (id, name, version, schema_definition)
VALUES (
    'invoice',
    'Invoice',
    1,
    '{
      "type": "object",
      "required": ["invoice_number", "customer_name", "amount"],
      "properties": {
        "invoice_number": { "type": "string" },
        "customer_name":  { "type": "string" },
        "amount":         { "type": "number" },
        "issued_date":    { "type": "string" },
        "due_date":       { "type": "string" },
        "notes":          { "type": "string" }
      }
    }'::jsonb
)
ON CONFLICT (id) DO NOTHING;
