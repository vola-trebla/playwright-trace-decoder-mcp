type SnapNode = [string, Record<string, string>, ...(SnapNode | string)[]];

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "BASE",
  "META",
  "LINK",
  "HEAD",
  "TITLE",
]);

export function snapshotToAriaYaml(html: unknown): string {
  if (!Array.isArray(html)) return "- document\n";
  const lines: string[] = [];
  walkNode(html as SnapNode, lines, 0);
  return lines.length ? lines.join("\n") : "- document\n";
}

function walkNode(node: SnapNode, lines: string[], depth: number): void {
  const tag = node[0];
  const attrs: Record<string, string> =
    node[1] !== null && typeof node[1] === "object" && !Array.isArray(node[1])
      ? (node[1] as Record<string, string>)
      : {};
  const childStart =
    node[1] !== null && typeof node[1] === "object" && !Array.isArray(node[1]) ? 2 : 1;
  const children = node.slice(childStart) as (SnapNode | string)[];

  if (SKIP_TAGS.has(tag)) return;
  if (attrs["aria-hidden"] === "true") return;

  const role = resolveRole(tag, attrs);

  if (role === null) {
    for (const child of children) {
      if (Array.isArray(child)) walkNode(child as SnapNode, lines, depth);
    }
    return;
  }

  const name = resolveName(tag, attrs, children);
  const extra = resolveExtra(tag, attrs);

  const indent = "  ".repeat(depth);
  const namePart = name ? ` "${name.slice(0, 80)}"` : "";
  const extraPart = extra ? ` ${extra}` : "";
  lines.push(`${indent}- ${role}${namePart}${extraPart}`);

  for (const child of children) {
    if (Array.isArray(child)) walkNode(child as SnapNode, lines, depth + 1);
  }
}

function resolveRole(tag: string, attrs: Record<string, string>): string | null {
  if (attrs["role"]) return attrs["role"];

  switch (tag) {
    case "HTML":
      return "document";
    case "BODY":
      return null;
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return "heading";
    case "A":
      return "href" in attrs ? "link" : null;
    case "BUTTON":
      return "button";
    case "INPUT": {
      const t = (attrs["type"] ?? "text").toLowerCase();
      if (t === "hidden") return null;
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "range") return "slider";
      if (["submit", "button", "reset", "image"].includes(t)) return "button";
      return "textbox";
    }
    case "SELECT":
      return "combobox";
    case "TEXTAREA":
      return "textbox";
    case "IMG":
      return attrs["alt"] !== undefined && attrs["alt"] !== "" ? "img" : null;
    case "NAV":
      return "navigation";
    case "MAIN":
      return "main";
    case "HEADER":
      return "banner";
    case "FOOTER":
      return "contentinfo";
    case "ASIDE":
      return "complementary";
    case "FORM":
      return "form";
    case "TABLE":
      return "table";
    case "TR":
      return "row";
    case "TD":
      return "cell";
    case "TH":
      return "columnheader";
    case "THEAD":
    case "TBODY":
    case "TFOOT":
      return "rowgroup";
    case "UL":
    case "OL":
      return "list";
    case "LI":
      return "listitem";
    case "DIALOG":
      return "dialog";
    case "PROGRESS":
      return "progressbar";
    case "SECTION":
      return attrs["aria-label"] ? "region" : null;
    // transparent layout tags
    case "DIV":
    case "SPAN":
    case "P":
    case "ARTICLE":
    case "FIGURE":
    case "DETAILS":
    case "SUMMARY":
      return null;
    default:
      return null;
  }
}

function resolveName(
  tag: string,
  attrs: Record<string, string>,
  children: (SnapNode | string)[]
): string {
  if (attrs["aria-label"]) return attrs["aria-label"].replace(/\s+/g, " ").trim();

  if (tag === "IMG") return (attrs["alt"] ?? "").trim();

  if (tag === "INPUT") {
    const t = (attrs["type"] ?? "text").toLowerCase();
    if (["submit", "button", "reset"].includes(t)) return (attrs["value"] ?? "").trim();
    if (t === "image") return (attrs["alt"] ?? "").trim();
    return (attrs["placeholder"] ?? attrs["name"] ?? "").trim();
  }

  const role = resolveRole(tag, attrs);
  const needsName = [
    "heading",
    "link",
    "button",
    "navigation",
    "main",
    "banner",
    "contentinfo",
    "complementary",
    "region",
    "form",
    "dialog",
    "combobox",
    "textbox",
  ].includes(role ?? "");

  return needsName ? extractText(children) : "";
}

function resolveExtra(tag: string, attrs: Record<string, string>): string {
  const parts: string[] = [];
  const levelMap: Record<string, string> = {
    H1: "[level=1]",
    H2: "[level=2]",
    H3: "[level=3]",
    H4: "[level=4]",
    H5: "[level=5]",
    H6: "[level=6]",
  };
  if (levelMap[tag]) parts.push(levelMap[tag]);
  if ("disabled" in attrs) parts.push("[disabled]");
  if (attrs["aria-expanded"] !== undefined) parts.push(`[expanded=${attrs["aria-expanded"]}]`);
  if (attrs["aria-checked"] !== undefined) parts.push(`[checked=${attrs["aria-checked"]}]`);
  if (attrs["aria-selected"] !== undefined) parts.push(`[selected=${attrs["aria-selected"]}]`);
  return parts.join(" ");
}

function extractText(children: (SnapNode | string)[]): string {
  let text = "";
  for (const child of children) {
    if (typeof child === "string") {
      text += child;
    } else if (Array.isArray(child)) {
      const childTag = (child as SnapNode)[0];
      if (!SKIP_TAGS.has(childTag)) {
        text += extractText((child as SnapNode).slice(2) as (SnapNode | string)[]);
      }
    }
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 100);
}
