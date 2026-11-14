import { KernelRequestError, type DocFormat, type KernelError } from "@wolfsdk/protocol";

export const MIME: Record<DocFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export const OPEN_ACCEPT = ".docx,.pptx,.xlsx," + Object.values(MIME).join(",");

/** Text for a thrown value: an embedder's save handler may throw anything. */
function causeText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause !== "object" || cause === null) return String(cause);
  const message = (cause as { message?: unknown }).message;
  if (typeof message === "string") return message;
  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
}

export function toKernelError(cause: unknown, code = "shell-failure"): KernelError {
  if (cause instanceof KernelRequestError) return cause.error;
  return { code, message: causeText(cause) };
}

/** Keys typed into a form field or editable content belong to that element. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** A Blob over the saved bytes; copies only if they sit on a shared buffer. */
function blobOf(bytes: Uint8Array, type: string): Blob {
  const own =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : bytes.slice();
  return new Blob([own], { type });
}

export function downloadBytes(bytes: Uint8Array, name: string, type: string): void {
  const url = URL.createObjectURL(blobOf(bytes, type));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The parts of the File System Access API the shell uses (Chromium only). */
type SaveFilePicker = (options: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{
  name: string;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}>;

/**
 * Ask for a destination and write the bytes there. Uses the native save
 * dialog where the browser has one, otherwise asks for a file name and
 * downloads. Resolves the chosen name, or null when the user cancelled.
 */
export async function saveBytesAs(bytes: Uint8Array, suggestedName: string, format: DocFormat): Promise<string | null> {
  const blob = blobOf(bytes, MIME[format]);
  // Chromium-only API, absent from the DOM typings: checked to be a function, typed by `SaveFilePicker`.
  const candidate: unknown = Reflect.get(globalThis, "showSaveFilePicker");
  const picker = typeof candidate === "function" ? (candidate as SaveFilePicker).bind(globalThis) : undefined;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName,
        types: [{ description: format.toUpperCase(), accept: { [MIME[format]]: [`.${format}`] } }],
      });
      const out = await handle.createWritable();
      await out.write(blob);
      await out.close();
      return handle.name;
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return null;
      throw cause;
    }
  }
  const typed = globalThis.prompt("Save as", suggestedName);
  if (!typed) return null;
  const name = /\.[A-Za-z0-9]+$/.test(typed) ? typed : `${typed}.${format}`;
  downloadBytes(bytes, name, MIME[format]);
  return name;
}

/** 12-hour clock, e.g. `3:04 PM`. */
export function clockTime(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

export function fileNameFromUrl(url: string): string {
  const path = new URL(url, globalThis.location?.href ?? "http://localhost/").pathname;
  return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)) || "document";
}
