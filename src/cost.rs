//! Tokens and cost: one turn's (its footer), a thread's and an agent's (summed from their
//! turn results), shown compact and dim ("12.4k tok · $0.18") with the full split on hover.
//! The numbers are what the agents report in their result events (store `Item::Result`): the
//! cost is the provider's own estimate (Claude Code and OpenCode report one; Claude's is the
//! API-equivalent price, also for subscription accounts, which aren't billed per token).

use crate::app::App;
use crate::store::Item;
use eframe::egui;
use serde_json::{Value, json};

/// Turn results added up.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Usage {
    pub turns: u64,
    /// Input tokens, cached ones included.
    pub input: u64,
    pub output: u64,
    /// Of `input`: read from or written to the prompt cache.
    pub cached: u64,
    pub cost: f64,
}

impl Usage {
    pub fn add(&mut self, it: &Item) {
        if let Item::Result { input_tokens, output_tokens, cached, cost_usd, .. } = it {
            self.turns += 1;
            self.input += input_tokens;
            self.output += output_tokens;
            self.cached += cached;
            self.cost += cost_usd;
        }
    }

    pub fn tokens(&self) -> u64 {
        self.input + self.output
    }

    pub fn is_empty(&self) -> bool {
        self.turns == 0
    }

    /// "12.4k tok · $0.18" (no cost when none was reported).
    pub fn compact(&self) -> String {
        let cost = money(self.cost);
        if cost.is_empty() { format!("{} tok", short(self.tokens())) } else { format!("{} tok · {cost}", short(self.tokens())) }
    }

    /// The whole split, for a hover or a details line.
    pub fn detail(&self) -> String {
        let mut s = format!("{} in", short(self.input));
        if self.cached > 0 {
            s += &format!(" ({} cached)", short(self.cached));
        }
        s += &format!(" · {} out", short(self.output));
        let cost = money(self.cost);
        if !cost.is_empty() {
            s += &format!(" · {cost}");
        }
        let turns = if self.turns == 1 { "1 turn".to_string() } else { format!("{} turns", self.turns) };
        format!("{s} · {turns}")
    }

    /// As the phone gets it (PROTOCOL.md `usage`).
    pub fn json(&self) -> Value {
        json!({
            "turns": self.turns, "input": self.input, "output": self.output, "cached": self.cached,
            "cost": (self.cost * 10_000.0).round() / 10_000.0, "label": self.compact(), "detail": self.detail(),
        })
    }
}

impl App {
    /// A chat's own turns: from its transcript while it's loaded (live), else from the store's
    /// totals (`usage_now`).
    #[allow(dead_code)]
    pub fn chat_usage(&mut self, ctx: &egui::Context, id: i64) -> Usage {
        if let Some(t) = self.transcripts.get(&id) {
            return of_items(&t.items);
        }
        self.usage_now(ctx).by_chat.get(&id).copied().unwrap_or_default()
    }

    /// `chat_usage` without summing the store again (the API's: what the desktop last summed).
    pub fn chat_usage_known(&self, id: i64) -> Usage {
        match self.transcripts.get(&id) {
            Some(t) => of_items(&t.items),
            None => self.usage_totals.last().by_chat.get(&id).copied().unwrap_or_default(),
        }
    }
}

impl App {
    /// `GET /v1/usage`: Settings › Usage's breakdown for the phone (PROTOCOL.md): per project
    /// (costliest first), per day (the last 14, newest first) and per account.
    pub fn api_usage(&mut self, ctx: &egui::Context) -> Value {
        let today = crate::store::now() / 86400;
        let t = self.usage_now(ctx).clone();
        let row = |name: String, u: &Usage| json!({ "name": name, "label": u.compact(), "detail": u.detail(), "usage": u.json() });
        let mut projects: Vec<(String, Usage)> = t.by_project.into_iter().map(|(p, u)| (if p.is_empty() { "No project".to_string() } else { p }, u)).collect();
        projects.sort_by(|a, b| b.1.cost.total_cmp(&a.1.cost).then(b.1.tokens().cmp(&a.1.tokens())));
        let days: Vec<Value> = (0..14)
            .filter_map(|i| {
                let d = today - i;
                let name = match i {
                    0 => "Today".to_string(),
                    1 => "Yesterday".to_string(),
                    _ => day_label(d),
                };
                t.days.get(&d).map(|u| row(name, u))
            })
            .collect();
        let accounts: Vec<Value> = t
            .by_account
            .iter()
            .map(|(a, (turns, tin, tout, cost))| {
                let name = self.account(a).map(crate::limits::account_name).unwrap_or_else(|| a.clone());
                row(name, &Usage { turns: *turns, input: *tin, output: *tout, cached: 0, cost: *cost })
            })
            .collect();
        json!({ "projects": projects.iter().map(|(n, u)| row(n.clone(), u)).collect::<Vec<_>>(), "days": days, "accounts": accounts })
    }
}

/// A day (days since the epoch) as the Usage page names it: "Mon 24 Oct".
pub fn day_label(day: i64) -> String {
    // 1970-01-01 was a Thursday; civil date from days (Howard Hinnant's algorithm).
    const WD: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MON: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let z = day + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{} {d} {}", WD[day.rem_euclid(7) as usize], MON[(m - 1) as usize])
}

/// A list of items' turn results added up.
pub fn of_items(items: &[Item]) -> Usage {
    let mut u = Usage::default();
    for it in items {
        u.add(it);
    }
    u
}

/// A token count in few characters: 950, 12.4k, 189k, 1.2M.
pub fn short(n: u64) -> String {
    match n {
        0..1_000 => n.to_string(),
        1_000..100_000 => trim(format!("{:.1}k", n as f64 / 1_000.0)),
        100_000..1_000_000 => format!("{}k", n / 1_000),
        _ => trim(format!("{:.1}M", n as f64 / 1_000_000.0)),
    }
}

/// "12.0k" reads as "12k".
fn trim(s: String) -> String {
    s.replace(".0k", "k").replace(".0M", "M")
}

/// "$0.18", "$12.40", "<$0.01"; "" for nothing.
pub fn money(c: f64) -> String {
    if c <= 0.0 {
        String::new()
    } else if c < 0.005 {
        "<$0.01".into()
    } else {
        format!("${c:.2}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(tin: u64, tout: u64, cached: u64, cost: f64) -> Item {
        Item::Result { cost_usd: cost, duration_ms: 0, turns: 1, input_tokens: tin, output_tokens: tout, cached, at: 0, account: String::new(), model: String::new() }
    }

    #[test]
    fn days() {
        assert_eq!(day_label(0), "Thu 1 Jan");
        // 2026-10-26 is a Monday.
        assert_eq!(day_label(20_752), "Mon 26 Oct");
    }

    #[test]
    fn compact_numbers() {
        assert_eq!(short(950), "950");
        assert_eq!(short(12_400), "12.4k");
        assert_eq!(short(12_000), "12k");
        assert_eq!(short(189_400), "189k");
        assert_eq!(short(1_250_000), "1.2M");
        assert_eq!(money(0.0), "");
        assert_eq!(money(0.001), "<$0.01");
        assert_eq!(money(0.1849), "$0.18");
        assert_eq!(money(12.4), "$12.40");
    }

    #[test]
    fn sums_turns() {
        let items = vec![result(10_000, 400, 8_000, 0.12), Item::Error { text: "x".into() }, result(2_000, 100, 0, 0.06)];
        let u = of_items(&items);
        assert_eq!(u, Usage { turns: 2, input: 12_000, output: 500, cached: 8_000, cost: 0.18 });
        assert_eq!(u.compact(), "12.5k tok · $0.18");
        assert_eq!(u.detail(), "12k in (8k cached) · 500 out · $0.18 · 2 turns");
        // No cost reported (Codex, Gemini): tokens only.
        let u = of_items(&[result(1_500, 20, 0, 0.0)]);
        assert_eq!((u.compact(), u.detail()), ("1.5k tok".to_string(), "1.5k in · 20 out · 1 turn".to_string()));
        assert_eq!(u.json()["label"], "1.5k tok");
    }
}
