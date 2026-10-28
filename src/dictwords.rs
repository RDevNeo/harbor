//! Dictation's words (0.76): the personal dictionary and the spoken commands, applied to every
//! transcript before and after the cleanup (dictate.rs). The phone's offline fallback runs the
//! same rules (android Words.java); both check `android/test/dictation-cases.txt`.
//!
//! Dictionary: a term ("SpokPay") and optional sound-alikes ("spoke pay"). Words of a transcript
//! that are the term or a sound-alike, spelled differently ("spok pay", "Spokepay"), become the
//! term exactly. Close spellings count only for terms of 6+ letters said in two or more words,
//! or of 7+ letters, so short everyday words are never "corrected".
//!
//! Commands, like Wispr Flow's "press enter": a dictation that ENDS with "press enter" (or
//! "aperta enter"…), or whose last sentence is only "send"/"enviar"/"enter", has it removed and
//! is sent. A sentence that is only "new line"/"nova linha" becomes a line break. Anywhere else
//! the same words are just text.

use serde_json::{Value, json};

/// A dictionary entry: the exact spelling, and how it may come out of the transcriber.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub term: String,
    pub sounds: Vec<String>,
}

/// At most this many entries, and characters per term.
pub const MAX_ENTRIES: usize = 500;
pub const MAX_TERM: usize = 60;

/// The dictionary from its JSON (`[{"term": "…", "sounds": ["…"]}]`), cleaned: blank and
/// duplicate terms out, lengths capped.
pub fn parse(v: &Value) -> Vec<Entry> {
    let mut out: Vec<Entry> = vec![];
    for e in v.as_array().into_iter().flatten() {
        let term = clip(e["term"].as_str().unwrap_or(""));
        if term.is_empty() || out.iter().any(|x| x.term.eq_ignore_ascii_case(&term)) {
            continue;
        }
        let mut sounds: Vec<String> = vec![];
        for s in e["sounds"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            let s = clip(s);
            if !s.is_empty() && !s.eq_ignore_ascii_case(&term) && !sounds.contains(&s) && sounds.len() < 8 {
                sounds.push(s);
            }
        }
        out.push(Entry { term, sounds });
        if out.len() >= MAX_ENTRIES {
            break;
        }
    }
    out
}

fn clip(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_TERM).collect()
}

pub fn to_json(d: &[Entry]) -> Value {
    Value::Array(d.iter().map(|e| json!({ "term": e.term, "sounds": e.sounds })).collect())
}

// ------------------------------------------------------------------ dictionary

/// A word of the text: its byte span.
type Span = (usize, usize);

fn word_spans(text: &str) -> Vec<Span> {
    let mut out = vec![];
    let mut start: Option<usize> = None;
    for (i, c) in text.char_indices() {
        if c.is_alphanumeric() {
            start.get_or_insert(i);
        } else if let Some(s) = start.take() {
            out.push((s, i));
        }
    }
    if let Some(s) = start {
        out.push((s, text.len()));
    }
    out
}

fn fold_char(c: char) -> char {
    match c {
        'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'í' | 'ì' | 'î' | 'ï' => 'i',
        'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
        'ú' | 'ù' | 'û' | 'ü' => 'u',
        'ç' => 's',
        'ñ' => 'n',
        c => c,
    }
}

/// How a word or words sound, roughly, for both languages: lowercase letters and digits,
/// accents off, spellings of one sound made one (ph/f, c/k/q, z/s, y/i), doubled letters single.
pub fn key(s: &str) -> String {
    let base: String = s.chars().flat_map(char::to_lowercase).map(fold_char).filter(|c| c.is_alphanumeric()).collect();
    let b: Vec<char> = base.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        let next = b.get(i + 1).copied();
        let (c, skip) = match (b[i], next) {
            ('p', Some('h')) => ('f', 2),
            ('c', Some('k')) => ('k', 2),
            ('c', _) | ('q', _) | ('k', _) => ('k', 1),
            ('x', _) => {
                out.push('k');
                ('s', 1)
            }
            ('z', _) => ('s', 1),
            ('y', _) => ('i', 1),
            (c, _) => (c, 1),
        };
        if !out.ends_with(c) {
            out.push(c);
        }
        i += skip;
    }
    out
}

fn distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = (prev[j] + usize::from(ca != cb)).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[b.len()]
}

/// How far `heard` (in `words` words) is from `form`, if close enough to be it.
fn closeness(heard: &str, words: usize, form: &str) -> Option<usize> {
    if heard.is_empty() || form.is_empty() {
        return None;
    }
    if heard == form {
        return Some(0);
    }
    let n = form.chars().count();
    let fuzzy = n >= 7 || (n >= 6 && words >= 2);
    if !fuzzy || heard.chars().next() != form.chars().next() {
        return None;
    }
    let d = distance(heard, form);
    (d <= if n >= 10 { 2 } else { 1 }).then_some(d)
}

/// The text with the dictionary's terms spelled exactly.
pub fn apply(text: &str, dict: &[Entry]) -> String {
    if dict.is_empty() {
        return text.to_string();
    }
    let forms: Vec<(usize, String)> = dict.iter().enumerate().flat_map(|(i, e)| std::iter::once(&e.term).chain(&e.sounds).map(move |f| (i, key(f)))).collect();
    let spans = word_spans(text);
    let mut out = String::new();
    let mut copied = 0;
    let mut i = 0;
    while i < spans.len() {
        // The best match starting at word i: closest first, then most words ("spoke pay CRM").
        let mut best: Option<(usize, usize, usize)> = None; // (distance, words, entry)
        let mut joined = String::new();
        for k in 1..=6.min(spans.len() - i) {
            if k > 1 {
                let gap = &text[spans[i + k - 2].1..spans[i + k - 1].0];
                if !(gap.chars().all(char::is_whitespace) || gap == "-") {
                    break;
                }
            }
            let (s, e) = spans[i + k - 1];
            joined.push_str(&text[s..e]);
            let heard = key(&joined);
            for (entry, form) in &forms {
                if let Some(d) = closeness(&heard, k, form)
                    && best.is_none_or(|b| d <= b.0)
                {
                    best = Some((d, k, *entry));
                }
            }
        }
        match best {
            Some((_, k, entry)) => {
                let (s, e) = (spans[i].0, spans[i + k - 1].1);
                out.push_str(&text[copied..s]);
                out.push_str(&dict[entry].term);
                copied = e;
                i += k;
            }
            None => i += 1,
        }
    }
    out.push_str(&text[copied..]);
    out
}

// ------------------------------------------------------------------ commands

/// Said alone as the last sentence: send.
const SEND_ALONE: &[&str] = &[
    "send", "send it", "send message", "send the message", "enter", "press enter", "hit enter", "enviar", "envia", "envie", "enviar mensagem", "manda", "mandar", "pode enviar", "pode mandar",
    "aperta enter", "aperte enter", "apertar enter", "pressiona enter", "pressione enter", "da enter", "dar enter",
];
/// Ending the dictation, even right after other words: send (Wispr Flow's "press enter").
const SEND_TAIL: &[&str] = &["press enter", "hit enter", "aperta enter", "aperte enter", "apertar enter", "pressiona enter", "pressione enter", "da enter", "dar enter"];
/// A sentence that is only this: a line break, or an empty line.
const NEW_LINE: &[&str] = &["new line", "newline", "next line", "nova linha", "proxima linha", "quebra de linha", "pula linha", "pular linha"];
const NEW_PARAGRAPH: &[&str] = &["new paragraph", "next paragraph", "novo paragrafo", "proximo paragrafo"];

/// Words compared: lowercase, accents and punctuation off.
fn norm(s: &str) -> String {
    let t: String = s.chars().flat_map(char::to_lowercase).map(fold_char).map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect();
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The text's sentences as byte spans (ends after their . ! ? … or at a line break).
fn sentences(text: &str) -> Vec<Span> {
    let mut out = vec![];
    let mut start = 0;
    let mut it = text.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        let end = if c == '\n' {
            Some(i)
        } else if matches!(c, '.' | '!' | '?' | '…') {
            while it.peek().is_some_and(|(_, n)| matches!(n, '.' | '!' | '?' | '…')) {
                it.next();
            }
            let after = it.peek().map_or(text.len(), |(j, _)| *j);
            it.peek().is_none_or(|(_, n)| n.is_whitespace()).then_some(after)
        } else {
            None
        };
        if let Some(e) = end {
            out.push((start, e));
            start = if c == '\n' { i + 1 } else { e };
        }
    }
    out.push((start, text.len()));
    out.into_iter().filter(|(s, e)| !text[*s..*e].trim().is_empty()).collect()
}

/// What the spoken commands do to a transcript: (the text without them, send it).
pub fn commands(text: &str) -> (String, bool) {
    // Line breaks first.
    let mut t = String::new();
    let mut copied = 0;
    for (s, e) in sentences(text) {
        let n = norm(&text[s..e]);
        let brk = if NEW_LINE.contains(&n.as_str()) {
            "\n"
        } else if NEW_PARAGRAPH.contains(&n.as_str()) {
            "\n\n"
        } else {
            continue;
        };
        t.push_str(text[copied..s].trim_end_matches([' ', '\t']));
        t.push_str(brk);
        copied = e;
        // What follows starts the new line.
        copied += text[copied..].len() - text[copied..].trim_start_matches([' ', '\t']).len();
    }
    t.push_str(&text[copied..]);
    // Then send, at the very end.
    let trimmed = t.trim_end();
    if let Some(&(s, e)) = sentences(trimmed).last()
        && SEND_ALONE.contains(&norm(&trimmed[s..e]).as_str())
    {
        return (trimmed[..s].trim_end_matches(|c: char| c.is_whitespace() || c == ',').to_string(), true);
    }
    let n = norm(trimmed);
    if let Some(tail) = SEND_TAIL.iter().find(|c| n == **c || n.ends_with(&format!(" {c}"))) {
        // Cut as many words off the end as the command has.
        let spans = word_spans(trimmed);
        let words = tail.split(' ').count();
        if spans.len() >= words {
            let cut = spans[spans.len() - words].0;
            return (trimmed[..cut].trim_end_matches(|c: char| c.is_whitespace() || c == ',').to_string(), true);
        }
    }
    (t, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cases the phone's Words.java checks too.
    const CASES: &str = include_str!("../android/test/dictation-cases.txt");

    #[test]
    fn shared_cases() {
        let mut dict: Vec<Entry> = vec![];
        let mut n = 0;
        for line in CASES.lines().filter(|l| !l.trim().is_empty() && !l.starts_with('#')) {
            let f: Vec<&str> = line.split('|').collect();
            let un = |s: &str| s.replace("\\n", "\n");
            match f[0] {
                "entry" => dict.push(Entry { term: f[1].into(), sounds: f.get(2).filter(|s| !s.is_empty()).map(|s| s.split(',').map(String::from).collect()).unwrap_or_default() }),
                "dict" => assert_eq!(apply(&un(f[1]), &dict), un(f[2]), "dict: {line}"),
                "cmd" => assert_eq!(commands(&un(f[1])), (un(f[2]), f[3] == "1"), "cmd: {line}"),
                other => panic!("unknown case {other}"),
            }
            n += 1;
        }
        assert!(n > 20);
    }

    #[test]
    fn parses_and_cleans_the_dictionary() {
        let d = parse(&json!([{"term": " SpokPay ", "sounds": ["spoke pay", "SpokPay", ""]}, {"term": "spokpay"}, {"term": ""}, {"sounds": ["x"]}]));
        assert_eq!(d, vec![Entry { term: "SpokPay".into(), sounds: vec!["spoke pay".into()] }]);
        assert_eq!(parse(&to_json(&d)), d);
    }

    #[test]
    fn keys_fold_spellings() {
        assert_eq!(key("SpokPayCRM"), key("spock pay crm"));
        assert_eq!(key("Harbor"), "harbor");
        assert_ne!(key("codes"), key("Codex"));
    }
}
