/** The command line was wrong, or a file it names is: reported with the usage, exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
