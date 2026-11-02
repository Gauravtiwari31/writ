// Errors shared across packages. NotImplementedError marks a contract stub that a build stream has
// not filled in yet (docs/ARCHITECTURE.md lists the owner of every stub); the gateway answers 501.

/** Thrown by a contract stub. `owner` is the build stream that implements it. */
export class NotImplementedError extends Error {
  override readonly name = "NotImplementedError";
  readonly owner: string;
  readonly feature: string;

  constructor(owner: string, feature: string) {
    super(`${feature} is not implemented yet (owner: ${owner} stream)`);
    this.owner = owner;
    this.feature = feature;
  }
}

/** By name, so it also matches an instance from a second copy of this module. */
export function isNotImplementedError(error: unknown): error is NotImplementedError {
  return error instanceof Error && error.name === "NotImplementedError" && "owner" in error && "feature" in error;
}
