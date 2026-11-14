import type { PackageDelta, RivalLoss } from "../lab/index.ts";

/** Member-name categories, first match wins. */
const CATEGORIES: readonly (readonly [string, RegExp])[] = [
  ["content-types", /^\[Content_Types\]\.xml$/],
  ["relationships", /\.rels$/],
  ["vba-project", /(^|\/)vba(Project|ProjectSignature\w*)\.bin$|(^|\/)vbaData\.xml$/],
  ["custom-xml", /^customXml\//],
  ["custom-ui", /^customUI\//],
  ["pivot", /^xl\/pivot(Tables|Cache)\//],
  ["slicer", /^xl\/slicer(s|Caches)\//],
  ["timeline", /^xl\/timeline(s|Caches)\//],
  ["chart", /\/charts\//],
  ["threaded-comments", /^xl\/(threadedComments|persons)\//],
  ["comments", /^xl\/comments|^word\/(comments\w*|people)\.xml$|^ppt\/(comments\/|commentAuthors\.xml$)/],
  ["form-control", /^xl\/ctrlProps\//],
  ["activex", /\/activeX\//],
  ["drawing", /^xl\/drawings\//],
  ["printer-settings", /\/printerSettings\//],
  ["doc-properties", /^docProps\//],
  ["styles", /(^|\/)styles\.xml$|^word\/stylesWithEffects\.xml$/],
  ["theme", /\/theme\//],
  ["calc-chain", /^xl\/calcChain\.xml$/],
  ["shared-strings", /^xl\/sharedStrings\.xml$/],
  ["external-link", /^xl\/externalLinks\//],
  ["table", /^xl\/tables\//],
  ["worksheet", /^xl\/worksheets\//],
  ["chartsheet", /^xl\/chartsheets\//],
  ["workbook", /^xl\/workbook\.xml$/],
  ["media", /\/media\//],
  ["embedding", /\/embeddings\//],
  ["smartart", /\/diagrams\//],
  ["notes", /^ppt\/notes(Slides|Masters)\//],
  ["slide", /^ppt\/slides\//],
  ["slide-layout", /^ppt\/slideLayouts\//],
  ["slide-master", /^ppt\/slideMasters\//],
  ["presentation", /^ppt\/(presentation|presProps|viewProps|tableStyles)\.xml$/],
  ["document", /^word\/document\.xml$/],
  ["header-footer", /^word\/(header|footer)\d*\.xml$/],
  ["numbering", /^word\/numbering\.xml$/],
  ["settings", /^word\/(settings|webSettings|fontTable)\.xml$/],
  ["footnotes", /^word\/(foot|end)notes\.xml$/],
];

export function categoryOf(member: string): string {
  for (const [category, pattern] of CATEGORIES) if (pattern.test(member)) return category;
  return "other";
}

/**
 * Loss categories from a package comparison, one entry per category with a
 * `changed` or `removed` member. Member level only:
 * - `data-loss` when no member of the category is left in the output,
 *   except `calc-chain`, a derived cache Excel rebuilds;
 * - `rewrite` otherwise.
 * Element-level losses inside a part that survives (a style entry that
 * disappeared, say) are not visible from member verdicts, so this can only
 * under-report.
 */
export function lossesFromDelta(delta: PackageDelta): RivalLoss[] {
  type Bucket = { members: string[]; removed: number; survivors: number };
  const buckets = new Map<string, Bucket>();
  for (const member of delta.verdicts) {
    const category = categoryOf(member.name);
    const bucket = buckets.get(category) ?? { members: [], removed: 0, survivors: 0 };
    buckets.set(category, bucket);
    if (member.verdict === "removed") bucket.removed++;
    else bucket.survivors++;
    if (member.verdict === "changed" || member.verdict === "removed" || member.verdict === "added") {
      bucket.members.push(`${member.name} (${member.verdict})`);
    }
  }
  const losses: RivalLoss[] = [];
  const touched = [...buckets.entries()]
    .filter(([, bucket]) => bucket.members.some((m) => !m.endsWith("(added)")))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [category, bucket] of touched) {
    const gone = bucket.removed > 0 && bucket.survivors === 0 && category !== "calc-chain";
    losses.push({ category, members: bucket.members, severity: gone ? "data-loss" : "rewrite" });
  }
  return losses;
}
