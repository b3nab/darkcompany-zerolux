//! A kernel module: a tally kept in the workspace, counted up by an action, with an event
//! each time and a view of it.

use zerolux_extension::{Caller, Context, Extension, Value, json};

#[derive(Default)]
struct Tally;

impl Extension for Tally {
    fn initialize(&self, _context: &Context) -> Result<Value, String> {
        Ok(json!({
            "actions": [
                {"name": "add", "title": "Add", "description": "Counts up", "effects": "write",
                    "input": {"type": "object", "properties": {"by": {"type": "integer"}}}},
                {"name": "total", "title": "Total", "description": "The tally so far"},
            ],
            "events": [{"name": "counted", "description": "The tally changed"}],
            "ui": [{"space": "page", "name": "tally", "title": "Tally",
                "view": {"kind": "described", "action": "total",
                    "refresh_on": ["zerolux.tally/counted"]}}],
        }))
    }

    fn action(
        &self,
        context: &Context,
        name: &str,
        input: Value,
        caller: Caller,
    ) -> Result<Value, String> {
        let total = context.get_value("total")?.as_i64().unwrap_or(0);
        match name {
            "add" => {
                let total = total + input["by"].as_i64().unwrap_or(1);
                context.set_value("total", json!(total))?;
                context.publish("counted", json!({"total": total}))?;
                Ok(json!({"total": total, "by": caller["actor_id"]}))
            }
            "total" => Ok(json!({"type": "heading", "text": total.to_string(),
                "folder": context.folder(), "settings": context.settings()})),
            other => Err(format!("No action `{other}`")),
        }
    }
}

zerolux_extension::export!(Tally::default);
