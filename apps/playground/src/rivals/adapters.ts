import type { DocFormat, EditIntent, RivalId } from "../lab/index.ts";

/** The format each rival edits, and the extension its scratch input and output carry. */
export const RIVAL_FORMAT: Record<RivalId, DocFormat> = {
  openpyxl: "xlsx",
  "python-docx": "docx",
  "python-pptx": "pptx",
};

export const RIVAL_EXT: Record<RivalId, string> = {
  openpyxl: ".xlsx",
  "python-docx": ".docx",
  "python-pptx": ".pptx",
};

/** The edit kinds each rival implements as a scripted intent. */
export const RIVAL_INTENTS: Record<RivalId, readonly EditIntent["kind"][]> = {
  openpyxl: ["set-cell", "user-script"],
  "python-docx": ["replace-text", "user-script"],
  "python-pptx": ["set-shape-text", "user-script"],
};

/**
 * Python run by the rivals worker under Pyodide. Each edit is the load,
 * edit, save script a typical user writes, and `run_edit` is the only entry
 * point.
 *
 * `run_edit(rival, intent_json, src, dst)` returns a JSON string:
 * `{ok, error, stdout, stderr, version}`. `ok` is true only when the script
 * finished and `dst` exists. Nothing in this source touches the network.
 */
export const ADAPTER_SOURCE = String.raw`
import contextlib
import importlib.metadata
import io
import json
import os
import re
import sys
import traceback

MAX_STREAM = 200000


def library_version(rival):
    try:
        return importlib.metadata.version(rival)
    except Exception:
        return None


def openpyxl_set_cell(src, dst, sheet, a1, value):
    from openpyxl import load_workbook

    wb = load_workbook(src)
    ws = wb[sheet]
    ws[a1] = value
    wb.save(dst)


def python_docx_replace_text(src, dst, find, replace):
    from docx import Document

    doc = Document(src)
    replaced = 0
    for paragraph in doc.paragraphs:
        for run in paragraph.runs:
            if find in run.text:
                replaced += run.text.count(find)
                run.text = run.text.replace(find, replace)
    doc.save(dst)
    if replaced:
        print("python-docx replaced %d occurrence(s), each inside a single run." % replaced)
    else:
        print(
            "python-docx replaced 0 occurrences. It compares one run at a time, so text that is split "
            "across runs (or sits outside body paragraphs) is not found, and the file was saved unchanged."
        )


def python_pptx_set_shape_text(src, dst, slide, shape, text):
    from pptx import Presentation

    prs = Presentation(src)
    target = prs.slides[slide - 1]
    match = re.fullmatch(r"#?(\d+)", shape)
    found = None
    for candidate in target.shapes:
        if (match and candidate.shape_id == int(match.group(1))) or candidate.name == shape:
            found = candidate
            break
    if found is None:
        raise LookupError("slide %d has no shape %r" % (slide, shape))
    found.text_frame.text = text
    prs.save(dst)
    print("python-pptx set the text of shape %r (id %d)." % (found.name, found.shape_id))


EDITS = {
    ("openpyxl", "set-cell"): lambda i, src, dst: openpyxl_set_cell(src, dst, i["sheet"], i["a1"], i["value"]),
    ("python-docx", "replace-text"): lambda i, src, dst: python_docx_replace_text(src, dst, i["find"], i["replace"]),
    ("python-pptx", "set-shape-text"): lambda i, src, dst: python_pptx_set_shape_text(
        src, dst, i["slide"], i["shape"], i["text"]
    ),
}


def run_user_script(code, src, dst):
    namespace = {"__name__": "__main__", "INPUT_PATH": src, "OUTPUT_PATH": dst}
    exec(compile(code, "<script>", "exec"), namespace)


def clip(text):
    if len(text) <= MAX_STREAM:
        return text
    return text[:MAX_STREAM] + "\n[output cut at %d characters]" % MAX_STREAM


def run_edit(rival, intent_json, src, dst):
    intent = json.loads(intent_json)
    kind = intent["kind"]
    out, err = io.StringIO(), io.StringIO()
    error = None
    scratch = os.path.dirname(dst)
    cwd = os.getcwd()
    if os.path.exists(dst):
        os.remove(dst)
    try:
        os.chdir(scratch)
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                if kind == "user-script":
                    run_user_script(intent["python"], src, dst)
                else:
                    EDITS[(rival, kind)](intent, src, dst)
            except SystemExit as exit_:
                if exit_.code not in (None, 0):
                    error = "SystemExit: %s" % (exit_.code,)
                    err.write("SystemExit: %s\n" % (exit_.code,))
            except BaseException as exc:
                error = "%s: %s" % (type(exc).__name__, exc)
                tb = exc.__traceback__.tb_next if kind == "user-script" and exc.__traceback__ else exc.__traceback__
                err.write("".join(traceback.format_exception(type(exc), exc, tb)))
    finally:
        os.chdir(cwd)
    if error is None and not os.path.exists(dst):
        error = (
            "The script finished without writing a file to OUTPUT_PATH."
            if kind == "user-script"
            else "The edit finished without writing an output file."
        )
    return json.dumps(
        {
            "ok": error is None,
            "error": error,
            "stdout": clip(out.getvalue()),
            "stderr": clip(err.getvalue()),
            "version": library_version(rival),
        }
    )
`;
