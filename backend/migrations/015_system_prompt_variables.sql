-- The system prompt can use fixed variables (Value / Dataset). The run keeps the
-- rendered system message it actually sent; system_prompt keeps the template.
alter table runs add column system_message text;
