// The Send message menu's templates: Person Hub's Email dialog (creators-hub/src/lib/emailTemplates.ts), which are the
// SpokPay CRM's outreach emails (Settings › Gmail sender › Templates), signed by Igor. Edited copies are kept in
// <collector dir>/templates.json; Reset brings a built-in one back. `{name}` and `{handle}` are filled per creator.

export interface Template {
  id: string;
  name: string;
  description: string;
  subject: string;
  body: string;
  /** One of the built-ins (it can be edited and reset, not deleted). */
  builtin?: boolean;
}

const SIGNATURE = "Igor, SpokPay\nspokpay.com";

export const BLANK_TEMPLATE: Template = { id: "blank", name: "Blank", description: "Em branco", subject: "", body: "", builtin: true };

export const BUILTIN_TEMPLATES: Template[] = [
  {
    id: "padrao",
    name: "Padrão",
    description: "Criador sem loja: uma loja própria do canal",
    subject: "Sua loja profissional.",
    body: `Olá {name}, tudo bem?

Após ter assistido vários dos seus vídeos, enxerguei uma oportunidade: seu público provavelmente compra Robux e Gamepass toda semana, só que compra de outras lojas ou do roblox, com a gente, você terá uma loja própria, com seu rosto e estilo, na qual seus seguidores irão confiar.

Na SpokPay a gente monta uma loja do seu canal e você ganha em cada venda. Pagamento no PIX, entrega e reembolso ficam com a gente. Você só divulga.

Podemos marcar uma reunião para conversar sobre?

${SIGNATURE}`,
    builtin: true,
  },
  {
    id: "loja-parceira",
    name: "Loja parceira",
    description: "Criador que divulga a loja de um parceiro",
    subject: "Sua loja própria",
    body: `Olá {name}, tudo bem?

Após ter assistido vários dos seus vídeos, enxerguei uma oportunidade: seu público já compra Robux e Gamepass toda semana, só que da sua loja parceira. Por que não ter uma loja própria, com seu rosto e estilo, na qual seus seguidores irão confiar?

Na SpokPay a gente cria o site da sua loja do zero, personalizado com a identidade do seu canal, nada de template genérico. E o lucro de cada venda é seu, não uma comissão nem uma porcentagem. Você define os preços e cupons; pagamento no PIX, entrega e reembolso ficam com a gente. Você apenas faz a divulgação.

Podemos marcar uma reunião para conversar sobre?

${SIGNATURE}`,
    builtin: true,
  },
  {
    id: "site-da-loja",
    name: "Site para a loja",
    description: "Criador com loja num template genérico",
    subject: "Um site feito para a sua loja",
    body: `Olá {name}, tudo bem?

Conheci sua loja pelo seu canal e gostei muito da ideia. Só que hoje ela roda num template genérico, igual ao de várias outras lojas, e não tem a cara do seu canal.

Na SpokPay a gente cria um site personalizado para a sua loja, do zero, com a sua identidade visual e o seu estilo, para os seus seguidores reconhecerem na hora que é seu. Além do site, a gente cuida de tudo que fica por trás: pagamento no PIX, pedidos, entrega de Robux e Gamepass, reembolsos e saques. Você continua com sua marca, seus preços e seus cupons, e ganha um painel com produtos, equipe e um atendente de IA que responde os clientes por você.

Podemos marcar uma reunião para conversarmos sobre?

${SIGNATURE}`,
    builtin: true,
  },
  BLANK_TEMPLATE,
];

/**
 * `{name}` and `{handle}` become the creator's (the CRM's fillEmailTemplate). Without a name the placeholder goes away
 * cleanly: "Olá {name}, tudo bem?" becomes "Olá, tudo bem?", a line starting "{name}, …" loses it and its comma.
 */
export function fillTemplate(template: string, who: { name?: string | null; handle?: string | null } | null): string {
  const name = who?.name?.trim() ?? "";
  const handle = who?.handle?.trim() || name;
  const fill = (s: string, key: string, value: string): string => {
    if (value) return s.replaceAll(key, value);
    const k = key.replace(/[{}]/g, "\\$&");
    return s
      .replace(new RegExp(`^([ \\t]*)${k}[ \\t]*[,;:]?[ \\t]*`, "gm"), "$1")
      .replace(new RegExp(`[ \\t]+${k}(?=[ \\t]*[,.!?;:)]|[ \\t]*$)`, "gm"), "")
      .replace(new RegExp(`[ \\t]*${k}`, "g"), "");
  };
  return fill(fill(template, "{name}", name), "{handle}", handle);
}

/** "Padrão" / "Default", else the first. */
export function defaultTemplate(list: Template[]): Template | undefined {
  return list.find((t) => ["padrão", "padrao", "default"].includes(t.name.trim().toLowerCase())) ?? list[0];
}

/** The CRM's cap: Gmail flags accounts that send cold mail in bursts, so at most this many new emails a rolling 24 h. */
export const DAILY_LIMIT = 30;
/** A second send to the same creator inside this window is a double click. */
export const REPEAT_GUARD_MS = 2 * 60 * 1000;

/** The saved list (built-ins first, edited where edited, then the user's own), from templates.json's content. */
export function loadTemplates(raw: unknown): Template[] {
  const saved = Array.isArray(raw) ? (raw.filter((t) => t && typeof t === "object" && typeof (t as Template).id === "string") as Template[]) : [];
  const clean = (t: Template, builtin: boolean): Template => ({
    id: t.id,
    name: String(t.name ?? "").slice(0, 80) || "Untitled",
    description: String(t.description ?? "").slice(0, 160),
    subject: String(t.subject ?? "").slice(0, 300),
    body: String(t.body ?? "").slice(0, 20_000),
    ...(builtin ? { builtin: true } : {}),
  });
  const out = BUILTIN_TEMPLATES.map((b) => {
    const s = saved.find((x) => x.id === b.id);
    return s ? clean({ ...b, ...s }, true) : b;
  });
  for (const s of saved) if (!BUILTIN_TEMPLATES.some((b) => b.id === s.id)) out.splice(out.length - 1, 0, clean(s, false));
  return out;
}

/** What templates.json keeps: the edited built-ins and the user's own (an untouched built-in isn't written). */
export function templatesToSave(list: Template[]): Template[] {
  return list.filter((t) => {
    const b = BUILTIN_TEMPLATES.find((x) => x.id === t.id);
    return !b || b.name !== t.name || b.description !== t.description || b.subject !== t.subject || b.body !== t.body;
  }).map(({ builtin: _b, ...t }) => t);
}
