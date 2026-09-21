import type { Protocol } from "devtools-protocol";

export interface El {
  ref: string;
  role: string;
  name: string;
  value?: string;
  states: string[];
  /** Nearest named container or preceding heading; disambiguates repeated controls. */
  context?: string;
  interactive: boolean;
  depth: number;
  backendNodeId?: number;
  objectId?: string;
  frame?: string;
}

export interface Query {
  role?: string;
  name?: string | RegExp;
  /** Match visible text on any node, interactive or not. */
  text?: string | RegExp;
  exact?: boolean;
  nth?: number;
}

export interface Snapshot {
  url: string;
  title: string;
  elements: El[];
}

const INTERACTIVE = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider",
  "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "listbox",
  "treeitem", "DisclosureTriangle", "ColorWell", "Date", "DateTime", "InputTime",
]);
const NAMED_CONTENT = new Set(["heading", "img", "image", "progressbar", "meter", "tooltip"]);
const ALWAYS_STRUCTURE = new Set([
  "navigation", "main", "banner", "contentinfo", "form", "search", "dialog", "alertdialog",
  "alert", "status", "table", "grid", "Iframe",
]);
const NAMED_STRUCTURE = new Set([
  "region", "complementary", "list", "tablist", "tabpanel", "toolbar", "menu", "menubar",
  "group", "radiogroup", "article", "row", "tree", "listitem",
]);
/** Repeated containers that often have no accessible name; their own text then identifies the controls inside. */
const ITEM = new Set(["listitem", "row", "article"]);
const SKIP = new Set(["none", "generic", "RootWebArea", "InlineTextBox", "LineBreak"]);
const STATE_PROPS = ["disabled", "checked", "expanded", "selected", "pressed", "required", "invalid", "focused", "readonly"];

const clean = (s: unknown, max: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function buildElements(nodes: Protocol.Accessibility.AXNode[], startRef: number, frame?: string): El[] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  const out: El[] = [];
  let lastHeading = "";
  let refN = startRef;

  const textOf = (node: Protocol.Accessibility.AXNode): string => {
    const parts: string[] = [];
    const walk = (n: Protocol.Accessibility.AXNode): void => {
      if (parts.join(" ").length > 80) return;
      if (n.role?.value === "StaticText") parts.push(String(n.name?.value ?? ""));
      else for (const id of n.childIds ?? []) { const child = byId.get(id); if (child) walk(child); }
    };
    walk(node);
    return clean(parts.join(" "), 80);
  };

  const visit = (node: Protocol.Accessibility.AXNode, depth: number, container: string, suppressText: boolean): void => {
    const role = String(node.role?.value ?? "");
    const name = clean(node.name?.value, 160);
    const descend = (d: number, c: string, s: boolean) => {
      for (const id of node.childIds ?? []) {
        const child = byId.get(id);
        if (child) visit(child, d, c, s);
      }
    };

    if (node.ignored || SKIP.has(role)) return descend(depth, container, suppressText);
    if (role === "StaticText") {
      if (!suppressText && name) {
        out.push({ ref: `e${refN++}`, role: "text", name, states: [], interactive: false, depth, backendNodeId: node.backendDOMNodeId, frame });
      }
      return;
    }

    const props = new Map((node.properties ?? []).map((p) => [p.name as string, p.value?.value]));
    const structural = ALWAYS_STRUCTURE.has(role) || (NAMED_STRUCTURE.has(role) && name !== "");
    const interactive = INTERACTIVE.has(role) || (props.get("focusable") === true && name !== "" && !structural);
    const emitted = interactive || structural || (NAMED_CONTENT.has(role) && name !== "");
    const nextContainer = (structural && name) || (ITEM.has(role) && textOf(node)) || container;
    if (!emitted) return descend(depth, nextContainer, suppressText);

    const states: string[] = [];
    for (const key of STATE_PROPS) {
      const v = props.get(key);
      if (v === undefined || v === false || v === "false") continue;
      states.push(v === true || v === "true" ? key : `${key}=${v}`);
    }
    if (role === "heading" && props.get("level") !== undefined) states.push(`level=${props.get("level")}`);

    const rawValue = node.value?.value;
    out.push({
      ref: `e${refN++}`,
      role,
      name,
      value: rawValue !== undefined && rawValue !== "" ? clean(rawValue, 80) : undefined,
      states,
      context: clean(container || lastHeading, 80) || undefined,
      interactive,
      depth,
      backendNodeId: node.backendDOMNodeId,
      frame,
    });
    if (role === "heading" && name) lastHeading = name;
    const labelled = name !== "" && (interactive || NAMED_CONTENT.has(role));
    descend(depth + 1, nextContainer, suppressText || labelled);
  };

  if (root) visit(root, 0, "", false);
  return out;
}

export function describe(el: El, withContext = true): string {
  let s = `${el.role} "${el.name}"`;
  if (el.value !== undefined) s += ` value="${el.value}"`;
  if (el.states.length) s += ` [${el.states.join(", ")}]`;
  if (withContext && el.context && el.context !== el.name) s += ` — in "${el.context}"`;
  return s;
}

export function render(snap: Snapshot, opts: { interactive?: boolean; maxChars?: number; refs?: boolean } = {}): string {
  const lines = [`# ${snap.title} — ${snap.url}`];
  for (const el of snap.elements) {
    const ref = opts.refs === false ? "" : `@${el.ref} `;
    if (opts.interactive) {
      if (el.interactive) lines.push(`${ref}${describe(el)}`);
    } else if (el.role === "text") {
      lines.push(`${"  ".repeat(el.depth)}${ref}"${el.name}"`);
    } else {
      lines.push(`${"  ".repeat(el.depth)}${ref}${describe(el, false)}`);
    }
  }
  const text = lines.join("\n");
  const max = opts.maxChars ?? Infinity;
  return text.length > max ? `${text.slice(0, max)}\n… (truncated, ${text.length - max} more chars)` : text;
}

const matches = (actual: string, expected: string | RegExp, exact: boolean | undefined): boolean => {
  if (expected instanceof RegExp) return expected.test(actual);
  return exact ? actual === expected : actual.toLowerCase().includes(expected.toLowerCase());
};

export function queryElements(elements: El[], q: Query): El[] {
  return elements.filter((el) => {
    if (q.role !== undefined && el.role.toLowerCase() !== q.role.toLowerCase()) return false;
    if (q.name !== undefined && (el.role === "text" || !matches(el.name, q.name, q.exact))) return false;
    if (q.text !== undefined && !matches(el.name, q.text, q.exact)) return false;
    return true;
  });
}
