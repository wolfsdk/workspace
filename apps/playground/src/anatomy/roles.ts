/**
 * OOXML role of a package member, decided from its part name only. This is a
 * presentation grouping for the anatomy map, not an engine finding.
 */
export type AnatomyRole =
  | "body"
  | "styles"
  | "media"
  | "relationships"
  | "custom-xml"
  | "vba"
  | "charts"
  | "pivot"
  | "other";

/** Display order, also the tie-break when two groups hold the same bytes. */
export const ROLE_ORDER: readonly AnatomyRole[] = [
  "body",
  "styles",
  "media",
  "relationships",
  "custom-xml",
  "vba",
  "charts",
  "pivot",
  "other",
];

export const ROLE_LABEL: Record<AnatomyRole, string> = {
  body: "Document body",
  styles: "Styles",
  media: "Media",
  relationships: "Relationships",
  "custom-xml": "Custom XML",
  vba: "VBA",
  charts: "Charts",
  pivot: "Pivot",
  other: "Other",
};

const MEDIA_EXT = /\.(png|jpe?g|gif|bmp|tiff?|emf|wmf|svg|wdp|jxr|ico|webp|mp3|mp4|m4a|m4v|wav|wma|wmv|avi|mov|mpe?g)$/;
const STYLE_BASENAMES: Record<string, true> = {
  "styles.xml": true,
  "styleswitheffects.xml": true,
  "fonttable.xml": true,
  "numbering.xml": true,
  "tablestyles.xml": true,
};
const STYLE_DIRS = /^(word|xl|ppt)\/(theme|slidemasters|slidelayouts|notesmasters|handoutmasters|fonts)\//;
const BODY = [
  /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments[a-z]*)\.xml$/,
  /^word\/glossary\//,
  /^xl\/(workbook|sharedstrings|comments\d*)\.xml$/,
  /^xl\/(worksheets|tables|drawings|threadedcomments|persons)\//,
  /^ppt\/presentation\.xml$/,
  /^ppt\/(slides|notesslides|comments|drawings)\//,
];

export function memberRole(name: string): AnatomyRole {
  const n = name.toLowerCase();
  const base = n.slice(n.lastIndexOf("/") + 1);
  if (n.endsWith(".rels")) return "relationships";
  if (base.startsWith("vba")) return "vba";
  if (n.startsWith("customxml/")) return "custom-xml";
  if (/\/pivot(tables|cache)\//.test(n)) return "pivot";
  if (/\/(charts|chartsheets)\//.test(n)) return "charts";
  if (/\/(media|embeddings)\//.test(n) || MEDIA_EXT.test(n)) return "media";
  if (Object.hasOwn(STYLE_BASENAMES, base) || STYLE_DIRS.test(n)) return "styles";
  if (BODY.some((re) => re.test(n))) return "body";
  return "other";
}
