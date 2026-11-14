import type { EditIntent, LabDoc, Op } from "./types.ts";

/**
 * The Wolf ops that carry out an edit intent on this document.
 *
 * Addresses use the forms the engine resolves by name (`sheet:Model/cell:B2`,
 * `slide:@1/shape:TextBox 2`), so they work without a view of the document.
 * Replacing text in a deck needs the view: the engine refuses `replace-text`
 * on a slide, so each shape whose text contains the search string is targeted.
 */
export function wolfOpsFor(intent: EditIntent, doc: LabDoc): Op[] {
  switch (intent.kind) {
    case "set-cell": {
      if (doc.format !== "xlsx") throw new Error(`set-cell needs a workbook, this document is ${doc.format}`);
      const value = typeof intent.value === "number" ? { number: intent.value } : { string: intent.value };
      return [{ op: "set", target: `sheet:${intent.sheet}/cell:${intent.a1.toUpperCase()}`, value }];
    }
    case "replace-text": {
      if (intent.find === "") throw new Error("replace-text needs a search string");
      if (doc.format === "docx") {
        return [{ op: "replace-text", target: "section:body", find: intent.find, replace: intent.replace }];
      }
      if (doc.format === "xlsx") {
        return [{ op: "replace-text", target: "workbook", find: intent.find, replace: intent.replace }];
      }
      const shapes = doc.nodes.filter((n) => n.kind === "shape" && n.visible && (n.text ?? "").includes(intent.find));
      if (shapes.length === 0 && doc.nodes.length === 0) {
        throw new Error("replacing text in a deck needs the document view, which this snapshot does not carry");
      }
      return shapes.map((n) => ({ op: "replace-text", target: n.id, find: intent.find, replace: intent.replace }));
    }
    case "set-shape-text": {
      if (doc.format !== "pptx") throw new Error(`set-shape-text needs a deck, this document is ${doc.format}`);
      if (!Number.isInteger(intent.slide) || intent.slide < 1) throw new Error("slide numbers start at 1");
      return [
        { op: "set", target: `slide:@${intent.slide}/shape:${intent.shape}`, value: { text: intent.text } },
      ];
    }
    case "user-script":
      throw new Error("a user script has no Wolf ops; it runs only against the other libraries");
  }
}
