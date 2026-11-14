/**
 * Engine faces for the grid on the reactor kernel, through the font store
 * of `@wolfsdk/runtime/vector` (packages/vector/INTEGRATION.md, "Font store for
 * browser text"): the reactor's `fonts` command lists the document's font
 * requests (Calibri -> Carlito), `ResourceCache.loadFonts` registers each
 * served face once as a `FontFace`, and `cssFont` names it. Cell text is
 * measured and drawn with that same CSS font, so what the grid measures is
 * what it paints, at the real face's advances. A font with no served face
 * (or still loading) and the command kernel (no `fonts`) use the system
 * stack.
 */
import type { DocId } from "@wolfsdk/protocol";
import {
  cssFont,
  parseFonts,
  parseResource,
  ResourceCache,
  ResourceStore,
  type DocumentFont,
} from "@wolfsdk/runtime/vector";

/** `fonts` and `resource` of the reactor kernel client. */
export type FontSource = {
  fonts(doc: DocId): Promise<unknown>;
  resource(handle: string): Promise<unknown>;
};

/** How one run of cell text is measured and painted. */
export type TextFace = {
  /** Size in CSS px (zoom applied). */
  px: number;
  ascent: number;
  descent: number;
  /** Baseline-to-baseline distance for wrapped lines. */
  lineHeight: number;
  /** Advance width of `text` in CSS px. */
  measure(text: string): number;
  /** Paint `text` with its baseline at (`x`, `y`) in the current fill style. */
  draw(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void;
};

/** A face drawn with canvas text in one CSS font. Ascent and descent are the
 * font's (`fontBoundingBox*`: the face's hhea metrics for a registered
 * face), so wrapped lines and baselines follow the face. */
export class CssFace implements TextFace {
  readonly px: number;
  readonly ctx: CanvasRenderingContext2D;
  readonly ascent: number;
  readonly descent: number;
  readonly lineHeight: number;
  readonly font: string;

  constructor(px: number, font: string, ctx: CanvasRenderingContext2D, lineHeight?: number) {
    this.px = px;
    this.ctx = ctx;
    this.font = font;
    // Font-box metrics are measured from the current baseline.
    ctx.textBaseline = "alphabetic";
    ctx.font = font;
    const m = ctx.measureText("Hg");
    this.ascent = m.fontBoundingBoxAscent || px * 0.8;
    this.descent = m.fontBoundingBoxDescent || px * 0.2;
    this.lineHeight = lineHeight ?? Math.max(this.ascent + this.descent, px * 1.2);
  }

  measure(text: string): number {
    this.ctx.font = this.font;
    this.ctx.fontKerning = "none";
    return this.ctx.measureText(text).width;
  }

  /** Kerning off, as Excel draws cell text. */
  draw(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
    ctx.font = this.font;
    ctx.fontKerning = "none";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, x, y);
  }
}

/** Fonts of the open document, by requested family and weight/style. */
export class GridFonts {
  readonly store: ResourceStore;
  readonly #source: FontSource;
  readonly #onLoad: () => void;
  #doc: DocId | null = null;
  #cache: ResourceCache | null = null;
  #fonts: DocumentFont[] = [];
  /** Reason the document's faces could not be listed, if any. */
  error: string | null = null;

  constructor(source: FontSource, onLoad: () => void) {
    this.#source = source;
    this.#onLoad = onLoad;
    this.store = new ResourceStore(async (handle) =>
      parseResource((await source.resource(handle)) as Parameters<typeof parseResource>[0]),
    );
  }

  /** List `doc`'s font requests and register their faces (once per document). */
  open(doc: DocId): void {
    if (doc === this.#doc) return;
    this.#doc = doc;
    this.#fonts = [];
    this.error = null;
    this.#cache?.dispose();
    const cache = new ResourceCache(this.store);
    this.#cache = cache;
    this.#source
      .fonts(doc)
      .then((raw) => {
        if (this.#doc !== doc) return;
        const info = parseFonts(raw as Parameters<typeof parseFonts>[0]);
        this.store.noteFonts(info);
        return cache.loadFonts(info.requests).then((fonts) => {
          if (this.#doc === doc) this.#fonts = fonts;
        });
      })
      .catch((e: unknown) => {
        if (this.#doc === doc) this.error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        if (this.#doc === doc) this.#onLoad();
      });
  }

  /** The registered document font for `family` with exactly that weight
   * class and style (a regular face does not stand in for bold). */
  font(family: string, bold: boolean, italic: boolean): DocumentFont | null {
    const f = family.toLowerCase();
    return (
      this.#fonts.find(
        (d) =>
          d.cssFamily && d.font.family.toLowerCase() === f && d.font.weight >= 600 === bold && d.font.italic === italic,
      ) ?? null
    );
  }

  /** The engine face for a cell font at `px`, else `fallback`. */
  face(
    family: string,
    bold: boolean,
    italic: boolean,
    px: number,
    ctx: CanvasRenderingContext2D,
    fallback: TextFace,
  ): TextFace {
    const d = this.font(family, bold, italic);
    return d ? new CssFace(px, cssFont(d, px), ctx) : fallback;
  }

  /** CSS font for DOM text (the cell editor) in the engine face, or null. */
  cssFont(family: string, bold: boolean, italic: boolean, px: number): string | null {
    const d = this.font(family, bold, italic);
    return d ? cssFont(d, px) : null;
  }

  /** Drop the document's faces from `document.fonts` and stop pending loads. */
  dispose(): void {
    this.#doc = null;
    this.#fonts = [];
    this.#cache?.dispose();
    this.#cache = null;
    this.store.dispose();
  }
}
