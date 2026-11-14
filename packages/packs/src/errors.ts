// The one error of the packs package. A pack that cannot be read, checked or refreshed says why with a stable
// `code` and, when the problem belongs to one binding, which binding and which target address. A refresh that
// throws has written nothing.

export type PackProblem = { code: string; message: string; binding_id?: string; target_doc?: string; target_address?: string };

export class PackError extends Error {
  readonly code: string;
  readonly binding_id: string | undefined;
  readonly target_doc: string | undefined;
  readonly target_address: string | undefined;
  /** Every problem of a refusal that found several (a refresh names each binding it refused). */
  readonly problems: readonly PackProblem[];

  constructor(code: string, message: string, where: { binding_id?: string; target_doc?: string; target_address?: string } = {}, problems?: readonly PackProblem[]) {
    super(message);
    this.name = "PackError";
    this.code = code;
    this.binding_id = where.binding_id;
    this.target_doc = where.target_doc;
    this.target_address = where.target_address;
    this.problems = problems ?? [{ code, message, ...where }];
  }

  /** This problem, with the binding it belongs to. */
  forBinding(binding: { id: string; target_doc: string; target_address: string }): PackError {
    return new PackError(this.code, this.message, { binding_id: binding.id, target_doc: binding.target_doc, target_address: binding.target_address });
  }

  toProblem(): PackProblem {
    const problem: PackProblem = { code: this.code, message: this.message };
    if (this.binding_id !== undefined) problem.binding_id = this.binding_id;
    if (this.target_doc !== undefined) problem.target_doc = this.target_doc;
    if (this.target_address !== undefined) problem.target_address = this.target_address;
    return problem;
  }
}
